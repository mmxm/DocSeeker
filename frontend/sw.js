/**
 * DocSeeker - Service Worker (Virtual Local Server & App Shell Cache)
 * 
 * Assure la disponibilité complète de l'application hors-ligne :
 * 1. Mise en cache de l'App Shell (HTML, CSS, JS, Wasm, polices, viewer PDF.js).
 * 2. Cache local des couvertures et des vignettes WebP (crops).
 * 3. Routage résilient avec fallback automatique sur incident réseau.
 */

const CACHE_NAME = 'docseeker-app-shell-v12';
const CROP_CACHE_NAME = 'docseeker_offline_crops';
const COVER_CACHE_NAME = 'docseeker_covers';

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/style.css?v=8.3',
  '/app.js?v=8.3',
  '/pdf-cache.js?v=8.3',
  '/download-queue-manager.js?v=8.3',
  '/offline-search-worker.js?v=8.3',
  '/worker-setup.js?v=8.3',
  '/crop-worker.js?v=8.3',
  '/favicon.ico',
  '/placeholder-cover.png',
  '/wasm/search_wasm/search_wasm.js',
  '/wasm/search_wasm/search_wasm_bg.wasm',
  '/wasm/sqlite/index.mjs',
  '/wasm/sqlite/sqlite3.wasm',
  '/pdfjs/build/pdf.mjs',
  '/pdfjs/build/pdf.worker.mjs',
  '/pdfjs/web/viewer.html',
  '/pdfjs/web/viewer.mjs',
  '/pdfjs/web/viewer.css',
];

// Installation du Service Worker et pré-chargement de l'App Shell
self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Installation de la version', CACHE_NAME);
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[ServiceWorker] Mise en cache de l\'App Shell...');
      for (const asset of APP_SHELL_ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn(`[ServiceWorker] Impossible de pré-cacher l'asset ${asset}:`, err);
        }
      }
    })
  );
});

// Activation et nettoyage des anciens caches
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activation...');
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== CROP_CACHE_NAME && key !== COVER_CACHE_NAME) {
            console.log('[ServiceWorker] Suppression de l\'ancien cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Interception des requêtes HTTP (Reverse Proxy Local)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Couvertures (/api/cover/{id}) : Cache First avec Network Fallback
  if (url.pathname.startsWith('/api/cover/')) {
    event.respondWith(
      caches.open(COVER_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => {
          return caches.match('/placeholder-cover.png');
        });
      })
    );
    return;
  }

  // 2. Vignettes de recherche (/api/crop/{docId}/{page}/{occId}) : Cache First
  if (url.pathname.startsWith('/api/crop/')) {
    event.respondWith(
      caches.open(CROP_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        // Si en ligne, tenter le réseau serveur
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          }
          return new Response('Offline crop not available', { status: 503, statusText: 'Offline Crop Missing' });
        }).catch(async () => {
          // En mode hors-ligne ou si inaccessible : renvoyer 503 pour déclencher img.onerror et le rendu local
          return new Response('Offline crop not available', { status: 503, statusText: 'Offline Crop Missing' });
        });
      })
    );
    return;
  }

  // 3. Streaming PDF (/api/pdf/{id}) : PDF.js lit nativement depuis IndexedDB
  if (url.pathname.startsWith('/api/pdf/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 4. Navigation principale (F5 / chargement de page sans wifi) : Servir index.html depuis le cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await caches.match('/index.html') || await caches.match('/');
        if (cached) return cached;
        return new Response('Mode hors-ligne DocSeeker', { headers: { 'Content-Type': 'text/html' } });
      })
    );
    return;
  }

  // 5. App Shell (HTML, CSS, JS, Wasm) : Cache First avec tolérance query string et mise à jour en arrière-plan
  if (!url.pathname.startsWith('/api/')) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
        if (cachedResponse) {
          // Revalidation discrète en tâche de fond si connecté
          fetch(event.request).then((netRes) => {
            if (netRes && netRes.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, netRes));
            }
          }).catch(() => {});
          return cachedResponse;
        }
        return fetch(event.request).catch(async () => {
          // Fallback ultime : chercher sans paramètre de requête
          return caches.match(url.pathname, { ignoreSearch: true });
        });
      })
    );
    return;
  }

  // 5. Requêtes API standard : Network First avec fallback
  event.respondWith(
    fetch(event.request).catch(() => {
      return new Response(JSON.stringify({ error: 'Réseau indisponible' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    })
  );
});
