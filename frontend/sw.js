/**
 * DocSeeker - Service Worker (Virtual Local Server & App Shell Cache)
 * 
 * Assure la disponibilité complète de l'application hors-ligne :
 * 1. Mise en cache de l'App Shell (HTML, CSS, JS, Wasm, polices, viewer PDF.js).
 * 2. Cache local des couvertures et des vignettes WebP (crops).
 * 3. Routage résilient avec fallback automatique sur incident réseau.
 */

const APP_VERSION = '9.5';
const CACHE_NAME = `docseeker-app-shell-v${APP_VERSION}`;
const CROP_CACHE_NAME = 'docseeker_offline_crops_v2';
const COVER_CACHE_NAME = 'docseeker_covers';

const VERSIONED_ASSETS = [
  '/style.css',
  '/app.js',
  '/pdf-cache.js',
  '/download-queue-manager.js',
  '/offline-search-worker.js',
  '/worker-setup.js',
  '/crop-worker.js'
].map((asset) => `${asset}?v=${APP_VERSION}`);

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  ...VERSIONED_ASSETS,
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
  '/pdfjs/web/locale/locale.json',
  '/pdfjs/web/locale/en-US/viewer.ftl',
  '/pdfjs/web/locale/fr/viewer.ftl',
  '/pdfjs/web/standard_fonts/FoxitDingbats.pfb',
  '/pdfjs/web/standard_fonts/FoxitFixed.pfb',
  '/pdfjs/web/standard_fonts/FoxitFixedBold.pfb',
  '/pdfjs/web/standard_fonts/FoxitFixedBoldItalic.pfb',
  '/pdfjs/web/standard_fonts/FoxitFixedItalic.pfb',
  '/pdfjs/web/standard_fonts/FoxitSerif.pfb',
  '/pdfjs/web/standard_fonts/FoxitSerifBold.pfb',
  '/pdfjs/web/standard_fonts/FoxitSerifBoldItalic.pfb',
  '/pdfjs/web/standard_fonts/FoxitSerifItalic.pfb',
  '/pdfjs/web/standard_fonts/FoxitSymbol.pfb',
  '/pdfjs/web/standard_fonts/LiberationSans-Bold.ttf',
  '/pdfjs/web/standard_fonts/LiberationSans-BoldItalic.ttf',
  '/pdfjs/web/standard_fonts/LiberationSans-Italic.ttf',
  '/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf',
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
    caches.keys().then(async (keys) => {
      // 1. Suppression des anciens caches de versions antérieures
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== CROP_CACHE_NAME && key !== COVER_CACHE_NAME) {
            console.log('[ServiceWorker] Suppression de l\'ancien cache:', key);
            return caches.delete(key);
          }
        })
      );

      // 2. Invalidation du cache des vignettes lors d'une montée de version
      // pour purger d'éventuels crops corrompus et forcer le rendu vectoriel natif
      try {
        const migrationKey = `/__crop_cache_cleaned_v${APP_VERSION}`;
        const appCache = await caches.open(CACHE_NAME);
        const isCleaned = await appCache.match(migrationKey);
        if (!isCleaned) {
          console.log(`[ServiceWorker] Purge du cache des vignettes ${CROP_CACHE_NAME} pour v${APP_VERSION}...`);
          await caches.delete(CROP_CACHE_NAME);
          await appCache.put(migrationKey, new Response('1'));
        }
      } catch (e) {
        console.warn('[ServiceWorker] Erreur lors de la purge de CROP_CACHE_NAME:', e);
      }
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

  // 2. Vignettes de recherche (/api/crop/{docId}/{page}/{occId}) : Cache First avec clé URL complète
  if (url.pathname.startsWith('/api/crop/')) {
    event.respondWith(
      caches.open(CROP_CACHE_NAME).then(async (cache) => {
        // Match exact avec query params pour respecter la recherche et les surlignages spécifiques
        let cached = await cache.match(event.request);
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

  // 3. Streaming PDF (/api/pdf/{id}) :
  if (url.pathname.startsWith('/api/pdf/')) {
    const id = url.pathname.replace('/api/pdf/', '').split('/')[0];

    // En mode déconnecté : servir immédiatement depuis IndexedDB
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      event.respondWith(
        (async () => {
          try {
            const cachedRes = await createIndexedDbPdfResponse(id, event.request);
            if (cachedRes) return cachedRes;
          } catch (e) {}
          return new Response('PDF non disponible hors-ligne', {
            status: 503,
            statusText: 'PDF Offline Unavailable',
            headers: { 'Content-Type': 'text/plain' },
          });
        })()
      );
      return;
    }

    // En ligne : laisser passer nativement au réseau sans interposition !
    // PDF.js gère lui-même son cache direct dans IndexedDB (docseeker_pdf_chunks_v2).
    // Ne pas intercepter élimine totalement les erreurs 'ServiceWorker intercepted the request and encountered an unexpected error'.
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
          if (url.pathname.endsWith('.json')) {
            return new Response('{}', {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          if (url.pathname.endsWith('.ftl')) {
            return new Response('', {
              status: 200,
              headers: { 'Content-Type': 'text/plain' }
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
 * Répond à une requête /api/pdf/{id} depuis IndexedDB en supportant :
 * 1. Les Range Requests (HTTP 206 Partial Content) : allocation minimale de la tranche demandée (ex: 64-256 Ko).
 * 2. Les requêtes complètes (HTTP 200) : streaming direct sans allouer 500 Mo en RAM pour les gros PDF.
 */
async function createIndexedDbPdfResponse(docId, request) {
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
            const prefix = `${normUrl}#`;
            const rangeHeader = request?.headers?.get('Range') || request?.headers?.get('range');

            // ─── CAS A : Range Request (HTTP 206 Partial Content) ───
            if (rangeHeader) {
              const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
              if (match) {
                const reqStart = parseInt(match[1], 10);
                const reqEnd = (match[2] !== undefined && match[2] !== '') ? parseInt(match[2], 10) : (totalBytes - 1);

                if (isNaN(reqStart) || reqStart >= totalBytes || reqStart < 0) {
                  try { db.close(); } catch (e) {}
                  return resolve(new Response(null, {
                    status: 416,
                    statusText: 'Range Not Satisfiable',
                    headers: {
                      'Content-Range': `bytes */${totalBytes}`,
                      'Accept-Ranges': 'bytes',
                    }
                  }));
                }

                const targetStart = reqStart;
                const targetEnd = Math.min(reqEnd, totalBytes - 1);
                const sliceLength = targetEnd - targetStart + 1;

                let sliceBuffer;
                try {
                  sliceBuffer = new Uint8Array(sliceLength);
                } catch (allocErr) {
                  try { db.close(); } catch (e) {}
                  return resolve(null);
                }

                const chunkTx = db.transaction('chunks', 'readonly');
                const chunkStore = chunkTx.objectStore('chunks');
                const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
                const cursorReq = chunkStore.openCursor(range);

                let bytesCopied = 0;
                cursorReq.onerror = () => { try { db.close(); } catch (e) {} resolve(null); };
                cursorReq.onsuccess = (e) => {
                  const cursor = e.target.result;
                  if (cursor) {
                    const key = String(cursor.key);
                    const parts = key.slice(prefix.length).split('_');
                    if (parts.length === 2) {
                      const b = parseInt(parts[0], 10);
                      const endExclusive = parseInt(parts[1], 10);
                      // Vérifier le chevauchement avec [targetStart, targetEnd]
                      if (endExclusive > targetStart && b <= targetEnd) {
                        const chunkBuf = cursor.value;
                        if (chunkBuf && chunkBuf.byteLength) {
                          const overlapStart = Math.max(b, targetStart);
                          const overlapEnd = Math.min(endExclusive - 1, targetEnd);
                          const copyLen = overlapEnd - overlapStart + 1;
                          const chunkOffset = overlapStart - b;
                          const destOffset = overlapStart - targetStart;

                          sliceBuffer.set(new Uint8Array(chunkBuf, chunkOffset, copyLen), destOffset);
                          bytesCopied += copyLen;
                        }
                      }
                    }
                    cursor.continue();
                  } else {
                    try { db.close(); } catch (e) {}
                    if (bytesCopied < sliceLength) {
                      // Les fragments en cache ne couvrent pas toute la plage demandée :
                      // On retourne null pour que le navigateur charge les vrais octets via le réseau
                      // et n'injecte JAMAIS de zéros qui corrompent la table XRef de PDF.js.
                      return resolve(null);
                    }
                    resolve(new Response(sliceBuffer.buffer, {
                      status: 206,
                      statusText: 'Partial Content',
                      headers: {
                        'Content-Type': 'application/pdf',
                        'Content-Range': `bytes ${targetStart}-${targetEnd}/${totalBytes}`,
                        'Content-Length': String(sliceLength),
                        'Accept-Ranges': 'bytes',
                      }
                    }));
                  }
                };
                return;
              }
            }

            // ─── CAS B : Requête intégrale (HTTP 200) ───
            // Ne servir une requête 200 depuis IndexedDB QUE si le fichier est marqué 100% complet
            if (!meta.completed) {
              try { db.close(); } catch (e) {}
              return resolve(null);
            }

            // Pour les PDF <= 100 Mo : buffer complet direct
            if (totalBytes <= 100 * 1024 * 1024) {
              const chunkTx = db.transaction('chunks', 'readonly');
              const chunkStore = chunkTx.objectStore('chunks');
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
                    resolve(new Response(fullArray.buffer, {
                      status: 200,
                      headers: {
                        'Content-Type': 'application/pdf',
                        'Content-Length': String(totalBytes),
                        'Accept-Ranges': 'bytes',
                      }
                    }));
                  } else {
                    resolve(null);
                  }
                }
              };
              return;
            }

            // Pour les très gros PDF (> 100 Mo) demandés sans Range header :
            // Streaming séquentiel chunk par chunk via ReadableStream (0 allocation 500 Mo en RAM)
            try { db.close(); } catch (e) {}
            const stream = new ReadableStream({
              start(controller) {
                try {
                  const streamReq = indexedDB.open('docseeker_pdf_chunks_v2', 2);
                  streamReq.onerror = () => controller.error(new Error('IndexedDB open error'));
                  streamReq.onsuccess = (ev) => {
                    const streamDb = ev.target.result;
                    const streamTx = streamDb.transaction('chunks', 'readonly');
                    const streamStore = streamTx.objectStore('chunks');
                    const streamRange = IDBKeyRange.bound(prefix, prefix + '\uffff');
                    const streamCursorReq = streamStore.openCursor(streamRange);

                    streamCursorReq.onerror = () => {
                      try { streamDb.close(); } catch (_) {}
                      controller.error(new Error('Cursor error'));
                    };
                    streamCursorReq.onsuccess = (cev) => {
                      const cur = cev.target.result;
                      if (cur) {
                        const chunkBuf = cur.value;
                        if (chunkBuf) controller.enqueue(new Uint8Array(chunkBuf));
                        cur.continue();
                      } else {
                        try { streamDb.close(); } catch (_) {}
                        controller.close();
                      }
                    };
                  };
                } catch (err) {
                  controller.error(err);
                }
              }
            });

            resolve(new Response(stream, {
              status: 200,
              headers: {
                'Content-Type': 'application/pdf',
                'Content-Length': String(totalBytes),
                'Accept-Ranges': 'bytes',
              }
            }));
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

/**
 * Reconstitue les octets d'un PDF depuis les fragments persistés dans IndexedDB (docseeker_pdf_chunks_v2)
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
            // Limite de sécurité : éviter d'allouer plus de 100 Mo d'un coup dans un seul buffer
            if (totalBytes > 100 * 1024 * 1024) {
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
