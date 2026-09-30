/**
 * DocSeeker - Service Worker (Virtual Local Server & App Shell Cache)
 * 
 * Assure la disponibilité complète de l'application hors-ligne :
 * 1. Mise en cache de l'App Shell (HTML, CSS, JS, Wasm, polices, viewer PDF.js).
 * 2. Cache local des couvertures et des vignettes WebP (crops).
 * 3. Routage résilient avec fallback automatique sur incident réseau.
 */

const APP_VERSION = '__ASSET_VERSION__';
const CACHE_NAME = `docseeker-app-shell-v${APP_VERSION}`;
// Les vignettes (covers et crops) ne sont PLUS mises en cache, ni côté SW ni côté
// serveur : chaque requête /api/cover et /api/crop est servie fraîchement par le
// backend, ce qui garantit un rendu toujours à jour (note éditée, image collée...).

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
  '/vendor/milkdown.js',
  '/vendor/milkdown.css',
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
      // Suppression de tous les caches obsolètes, y compris les anciens caches de
      // vignettes (docseeker_covers, docseeker_offline_crops*) désormais supprimés.
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
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

  // Les couvertures (/api/cover/) et vignettes (/api/crop/) ne sont plus interceptées :
  // elles passent directement sur le réseau, servies fraîches par le backend (no-store).

  // Streaming PDF (/api/pdf/{id}) :
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
          // Network-first : le viewer servi doit toujours être la version
          // déployée (un viewer périmé peut attendre le 100 % du cache avant
          // d'afficher, ou re-télécharger les PDF en intégralité). Le cache
          // ne sert qu'en repli hors-ligne.
          try {
            const netRes = await fetch(event.request);
            if (netRes && netRes.status === 200) {
              const copy = netRes.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put('/pdfjs/web/viewer.html', copy));
            }
            return netRes;
          } catch (e) {
            const cachedViewer = await caches.match('/pdfjs/web/viewer.html', { ignoreSearch: true });
            if (cachedViewer) return cachedViewer;
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
        // Match exact d'abord (respecte ?v=...) : ignoreSearch ne sert qu'en repli,
        // sinon une URL versionnée ressert indéfiniment l'ancien asset en cache.
        let cached = await caches.match(event.request)
          || await caches.match(event.request, { ignoreSearch: true })
          || await caches.match(url.pathname, { ignoreSearch: true });
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
              let reqStart = 0;
              let reqEnd = totalBytes - 1;
              let isValidRange = false;

              const suffixMatch = rangeHeader.match(/bytes=-(\d+)/);
              const standardMatch = rangeHeader.match(/bytes=(\d+)-(\d+)?/);

              if (suffixMatch) {
                const suffixLen = parseInt(suffixMatch[1], 10);
                if (!isNaN(suffixLen) && suffixLen > 0) {
                  const len = Math.min(suffixLen, totalBytes);
                  reqStart = totalBytes - len;
                  reqEnd = totalBytes - 1;
                  isValidRange = true;
                }
              } else if (standardMatch) {
                reqStart = parseInt(standardMatch[1], 10);
                reqEnd = (standardMatch[2] !== undefined && standardMatch[2] !== '') ? parseInt(standardMatch[2], 10) : (totalBytes - 1);
                isValidRange = !isNaN(reqStart) && reqStart < totalBytes && reqStart >= 0;
              }

              if (!isValidRange) {
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
                      // Garde anti-RangeError : fragment hors bornes ignoré (cache périmé)
                      if (b >= 0 && b + chunkBuf.byteLength <= totalBytes) {
                        fullArray.set(new Uint8Array(chunkBuf), b);
                        readBytes += chunkBuf.byteLength;
                      }
                    }
                  }
                  cursor.continue();
                } else {
                  try { db.close(); } catch (e) {}
                  // Couverture stricte : un buffer tronqué (méta d'une ancienne version)
                  // casserait les pages de fin du document côté PDF.js.
                  if (readBytes >= totalBytes) {
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
                    // Garde anti-RangeError : fragment hors bornes ignoré (cache périmé)
                    if (b >= 0 && b + chunkBuf.byteLength <= totalBytes) {
                      fullArray.set(new Uint8Array(chunkBuf), b);
                      readBytes += chunkBuf.byteLength;
                    }
                  }
                }
                cursor.continue();
              } else {
                try { db.close(); } catch (e) {}
                // Couverture stricte : un buffer tronqué (méta d'une ancienne version)
                // casserait les pages de fin du document côté PDF.js.
                if (readBytes >= totalBytes) {
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
