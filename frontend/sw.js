/**
 * DocSeeker - Service Worker (Virtual Local Server & App Shell Cache)
 * 
 * Assure la disponibilité complète de l'application hors-ligne :
 * 1. Mise en cache de l'App Shell (HTML, CSS, JS, Wasm, polices, viewer PDF.js).
 * 2. Cache local des couvertures et des vignettes WebP (crops).
 * 3. Routage résilient avec fallback automatique sur incident réseau.
 */

const CACHE_NAME = 'docseeker-app-shell-v13';
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
        const cached = await cache.match(event.request, { ignoreSearch: true }) || await cache.match(url.pathname);
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

  // 3. Streaming PDF (/api/pdf/{id}) : Network First avec fallback IndexedDB local.
  if (url.pathname.startsWith('/api/pdf/')) {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const id = url.pathname.replace('/api/pdf/', '').split('/')[0];
        const pdfBytes = await getCachedPdfBytesFromIndexedDB(id);
        if (pdfBytes) {
          return new Response(pdfBytes, {
            status: 200,
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Length': String(pdfBytes.byteLength),
              'Accept-Ranges': 'bytes',
            },
          });
        }
        return new Response('PDF non disponible hors-ligne', {
          status: 503,
          statusText: 'PDF Offline Unavailable',
          headers: { 'Content-Type': 'text/plain' },
        });
      })
    );
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

/**
 * Reconstitue les octets d'un PDF depuis les fragments persistés dans IndexedDB (docseeker_pdf_chunks_v2)
 * Permet au Service Worker de répondre aux requêtes /api/pdf/{id} même en mode 100% hors-ligne.
 */
async function getCachedPdfBytesFromIndexedDB(docId) {
  if (typeof indexedDB === 'undefined') return null;
  const id = Number(docId);
  if (!id) return null;
  const normUrl = `/api/pdf/${id}`;

  return new Promise((resolve) => {
    try {
      const openReq = indexedDB.open('docseeker_pdf_chunks_v2', 2);
      openReq.onerror = () => resolve(null);
      openReq.onsuccess = (evt) => {
        const db = evt.target.result;
        if (!db.objectStoreNames.contains('meta') || !db.objectStoreNames.contains('chunks')) {
          db.close();
          return resolve(null);
        }

        try {
          const metaTx = db.transaction('meta', 'readonly');
          const metaStore = metaTx.objectStore('meta');
          const metaReq = metaStore.get(normUrl);

          metaReq.onerror = () => { db.close(); resolve(null); };
          metaReq.onsuccess = () => {
            const meta = metaReq.result;
            if (!meta || !meta.totalBytes || meta.totalBytes <= 0) {
              db.close();
              return resolve(null);
            }

            const totalBytes = meta.totalBytes;
            const chunkTx = db.transaction('chunks', 'readonly');
            const chunkStore = chunkTx.objectStore('chunks');
            const prefix = `${normUrl}#`;
            const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
            const cursorReq = chunkStore.openCursor(range);
            const fullArray = new Uint8Array(totalBytes);
            let readBytes = 0;

            cursorReq.onerror = () => { db.close(); resolve(null); };
            cursorReq.onsuccess = (e) => {
              const cursor = e.target.result;
              if (cursor) {
                const key = String(cursor.key);
                const parts = key.slice(prefix.length).split('_');
                if (parts.length === 2) {
                  const b = parseInt(parts[0], 10);
                  const chunkBuf = cursor.value;
                  if (chunkBuf && chunkBuf.byteLength) {
                    fullArray.set(new Uint8Array(chunkBuf), b);
                    readBytes += chunkBuf.byteLength;
                  }
                }
                cursor.continue();
              } else {
                db.close();
                if (readBytes >= totalBytes || (meta.completed && readBytes > 0)) {
                  resolve(fullArray.buffer);
                } else {
                  resolve(null);
                }
              }
            };
          };
        } catch (txErr) {
          db.close();
          resolve(null);
        }
      };
    } catch (err) {
      resolve(null);
    }
  });
}

