/**
 * DocSeeker - Service Worker (Virtual Local Server & App Shell Cache)
 * 
 * Assure la disponibilité complète de l'application hors-ligne :
 * 1. Mise en cache de l'App Shell (HTML, CSS, JS, Wasm, polices, viewer PDF.js).
 * 2. Cache local des couvertures et des vignettes WebP (crops).
 * 3. Routage résilient avec fallback automatique sur incident réseau.
 */

const CACHE_NAME = 'docseeker-app-shell-v16';
const CROP_CACHE_NAME = 'docseeker_offline_crops';
const COVER_CACHE_NAME = 'docseeker_covers';

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/style.css?v=8.4',
  '/app.js?v=8.4',
  '/pdf-cache.js?v=8.4',
  '/download-queue-manager.js?v=8.4',
  '/offline-search-worker.js?v=8.4',
  '/worker-setup.js?v=8.4',
  '/crop-worker.js?v=8.4',
  '/favicon.ico',
  '/placeholder-cover.png',
  '/wasm/search_wasm/search_wasm.js',
  '/wasm/search_wasm/search_wasm_bg.wasm',
  '/wasm/sqlite/index.mjs',
  '/wasm/sqlite/sqlite3.wasm',
  '/wasm/sqlite/sqlite3-opfs-async-proxy.js',
  '/wasm/sqlite/sqlite3-worker1.mjs',
  '/pdfjs/build/pdf.mjs',
  '/pdfjs/build/pdf.worker.mjs',
  '/pdfjs/web/viewer.html',
  '/pdfjs/web/viewer.mjs',
  '/pdfjs/web/viewer.css',
  '/pdfjs/web/images/toolbarButton-sidebarToggle.svg',
  '/pdfjs/web/images/toolbarButton-viewThumbnail.svg',
  '/pdfjs/web/images/toolbarButton-viewOutline.svg',
  '/pdfjs/web/images/toolbarButton-viewAttachments.svg',
  '/pdfjs/web/images/toolbarButton-viewLayers.svg',
  '/pdfjs/web/images/toolbarButton-search.svg',
  '/pdfjs/web/images/toolbarButton-zoomOut.svg',
  '/pdfjs/web/images/toolbarButton-zoomIn.svg',
  '/pdfjs/web/images/toolbarButton-secondaryToolbarToggle.svg',
  '/pdfjs/web/images/toolbarButton-pageUp.svg',
  '/pdfjs/web/images/toolbarButton-pageDown.svg',
  '/pdfjs/web/images/toolbarButton-presentationMode.svg',
  '/pdfjs/web/images/toolbarButton-print.svg',
  '/pdfjs/web/images/toolbarButton-download.svg',
  '/pdfjs/web/images/toolbarButton-bookmark.svg',
  '/pdfjs/web/images/toolbarButton-openFile.svg',
  '/pdfjs/web/images/findbarButton-previous.svg',
  '/pdfjs/web/images/findbarButton-next.svg',
  '/pdfjs/web/images/secondaryToolbarButton-firstPage.svg',
  '/pdfjs/web/images/secondaryToolbarButton-lastPage.svg',
  '/pdfjs/web/images/secondaryToolbarButton-rotateCw.svg',
  '/pdfjs/web/images/secondaryToolbarButton-rotateCcw.svg',
  '/pdfjs/web/images/secondaryToolbarButton-handTool.svg',
  '/pdfjs/web/images/secondaryToolbarButton-selectTool.svg',
  '/pdfjs/web/images/secondaryToolbarButton-documentProperties.svg',
  '/pdfjs/web/images/treeitem-collapsed.svg',
  '/pdfjs/web/images/treeitem-expanded.svg',
  '/pdfjs/web/images/loading.svg',
  '/pdfjs/web/images/loading-icon.gif',
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
  if (!event.request || !event.request.url) return;
  let url;
  try {
    url = new URL(event.request.url);
  } catch (e) {
    return;
  }
  if (!url.protocol.startsWith('http')) return;

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
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          }
          return new Response('Offline crop not available', { status: 503, statusText: 'Offline Crop Missing' });
        }).catch(async () => {
          return new Response('Offline crop not available', { status: 503, statusText: 'Offline Crop Missing' });
        });
      })
    );
    return;
  }

  // 3. Streaming PDF (/api/pdf/{id}) : Network First avec fallback IndexedDB local.
  if (url.pathname.startsWith('/api/pdf/')) {
    event.respondWith(
      (async () => {
        const id = url.pathname.replace('/api/pdf/', '').split('/')[0];
        
        // En mode déconnecté : servir immédiatement depuis IndexedDB
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          try {
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
          } catch (e) {}
          return new Response('PDF non disponible hors-ligne', {
            status: 503,
            statusText: 'PDF Offline Unavailable',
            headers: { 'Content-Type': 'text/plain' },
          });
        }

        // En ligne : Network direct avec protection d'annulation
        try {
          return await fetch(event.request);
        } catch (netErr) {
          // Si le client a annulé (AbortError) ou si le réseau est tombé :
          try {
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
          } catch (fallbackErr) {}
          return new Response('Ressource non disponible', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          });
        }
      })()
    );
    return;
  }

  // 4. Navigation (F5 / chargement de page principale OU iframe viewer.html)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        // Cas A : Chargement de l'iframe du viewer PDF.js (/pdfjs/web/viewer.html)
        if (url.pathname.includes('/pdfjs/web/viewer.html')) {
          const cachedViewer = await caches.match('/pdfjs/web/viewer.html', { ignoreSearch: true });
          if (cachedViewer) {
            return cachedViewer;
          }
          try {
            const netRes = await fetch(event.request);
            if (netRes && netRes.status === 200) {
              const copy = netRes.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put('/pdfjs/web/viewer.html', copy));
            }
            return netRes;
          } catch (e) {
            const retry = await caches.match('/pdfjs/web/viewer.html', { ignoreSearch: true });
            if (retry) return retry;
            return new Response('Lecteur PDF non disponible', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' }
            });
          }
        }

        // Cas B : Navigation vers l'application principale (F5 / /index.html)
        const cachedApp = await caches.match('/index.html', { ignoreSearch: true }) || await caches.match('/', { ignoreSearch: true });
        if (cachedApp && typeof navigator !== 'undefined' && navigator.onLine === false) {
          return cachedApp;
        }

        try {
          const netRes = await fetch(event.request);
          if (netRes && netRes.status === 200) {
            const copy = netRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          }
          return netRes;
        } catch (e) {
          if (cachedApp) return cachedApp;
          return new Response('Mode hors-ligne DocSeeker', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
      })()
    );
    return;
  }

  // 5. App Shell & Assets statiques (HTML, CSS, JS, Wasm, SVG, Images) : Cache First
  if (!url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        let cached = await caches.match(event.request, { ignoreSearch: true }) || await caches.match(url.pathname, { ignoreSearch: true });
        if (!cached && url.pathname.endsWith('sqlite3-opfs-async-proxy.js')) {
          cached = await caches.match('/wasm/sqlite/sqlite3-opfs-async-proxy.js', { ignoreSearch: true });
        }
        if (!cached && url.pathname.endsWith('sqlite3-worker1.mjs')) {
          cached = await caches.match('/wasm/sqlite/sqlite3-worker1.mjs', { ignoreSearch: true });
        }
        if (cached) {
          if (typeof navigator !== 'undefined' && navigator.onLine) {
            fetch(event.request).then((netRes) => {
              if (netRes && netRes.status === 200) {
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, netRes));
              }
            }).catch(() => {});
          }
          return cached;
        }

        try {
          const netRes = await fetch(event.request);
          if (netRes && netRes.status === 200) {
            const copy = netRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return netRes;
        } catch (fetchErr) {
          // GARANTIE ABSOLUE : Ne JAMAIS résoudre avec undefined !
          if (url.pathname.endsWith('.svg')) {
            return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>', {
              status: 200,
              headers: { 'Content-Type': 'image/svg+xml' }
            });
          }
          if (url.pathname.endsWith('.png') || url.pathname.endsWith('.ico')) {
            return new Response(new Uint8Array(0), {
              status: 200,
              headers: { 'Content-Type': 'image/png' }
            });
          }
          if (url.pathname.endsWith('.css')) {
            return new Response('', {
              status: 200,
              headers: { 'Content-Type': 'text/css' }
            });
          }
          return new Response('Asset indisponible hors-ligne', {
            status: 404,
            statusText: 'Not Found Offline',
            headers: { 'Content-Type': 'text/plain' }
          });
        }
      })()
    );
    return;
  }

  // 6. Requêtes API standard : Network First avec fallback
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
          try { db.close(); } catch (e) {}
          return resolve(null);
        }

        try {
          const metaTx = db.transaction('meta', 'readonly');
          const metaStore = metaTx.objectStore('meta');
          const metaReq = metaStore.get(normUrl);

          metaReq.onerror = () => { try { db.close(); } catch (e) {} resolve(null); };
          metaReq.onsuccess = () => {
            const meta = metaReq.result;
            if (!meta || !meta.totalBytes || meta.totalBytes <= 0) {
              try { db.close(); } catch (e) {}
              return resolve(null);
            }

            const totalBytes = meta.totalBytes;
            // Limite de sécurité : éviter d'allouer plus de 500 Mo d'un coup dans le Service Worker
            if (totalBytes > 500 * 1024 * 1024) {
              try { db.close(); } catch (e) {}
              return resolve(null);
            }

            const chunkTx = db.transaction('chunks', 'readonly');
            const chunkStore = chunkTx.objectStore('chunks');
            const prefix = `${normUrl}#`;
            const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
            const cursorReq = chunkStore.openCursor(range);
            let fullArray;
            try {
              fullArray = new Uint8Array(totalBytes);
            } catch (allocErr) {
              try { db.close(); } catch (e) {}
              return resolve(null);
            }
            let readBytes = 0;

            cursorReq.onerror = () => { try { db.close(); } catch (e) {} resolve(null); };
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
                try { db.close(); } catch (e) {}
                if (readBytes >= totalBytes || (meta.completed && readBytes > 0)) {
                  resolve(fullArray.buffer);
                } else {
                  resolve(null);
                }
              }
            };
          };
        } catch (txErr) {
          try { db.close(); } catch (e) {}
          resolve(null);
        }
      };
    } catch (err) {
      resolve(null);
    }
  });
}
