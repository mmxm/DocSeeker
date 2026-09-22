import './worker-setup.js';
import * as pdfjsLib from './pdfjs/build/pdf.mjs';
import * as pdfjsWorker from './pdfjs/build/pdf.worker.mjs';

if (typeof globalThis !== 'undefined') {
  globalThis.pdfjsWorker = pdfjsWorker;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';

// ─── Constantes partagées (traduction exacte de search-core/src/constants.rs) ───
// Ces valeurs DOIVENT rester en sync avec les constantes Rust du backend.
const CROP_RENDER_SCALE   = 1.5;
const DEFAULT_CROP_WIDTH  = 300.0;
const DEFAULT_CROP_HEIGHT = 120.0;
const GOODNOTES_YELLOW_CSS = 'rgba(255, 226, 0, 0.45)';

/**
 * Calcul pur JS de la sous-région de crop — traduction fidèle de crop.rs::calculate_crop_bounds().
 * Logique STRICTEMENT identique au backend Rust (Pdfium) et au frontend Wasm (search-core).
 */
function calculateCropBounds(x0, y0, x1, y1, pageWidth, pageHeight,
                              targetW = DEFAULT_CROP_WIDTH, targetH = DEFAULT_CROP_HEIGHT) {
  const centerX = (x0 + x1) / 2;
  const centerY = (y0 + y1) / 2;

  let cropX0 = Math.max(0, centerX - targetW / 2);
  let cropX1 = Math.min(cropX0 + targetW, pageWidth);
  if (cropX1 === pageWidth) cropX0 = Math.max(0, cropX1 - targetW);

  let cropY0 = Math.max(0, centerY - targetH / 2);
  let cropY1 = Math.min(cropY0 + targetH, pageHeight);
  if (cropY1 === pageHeight) cropY0 = Math.max(0, cropY1 - targetH);

  return {
    x0: cropX0,
    y0: cropY0,
    width:  Math.max(1, cropX1 - cropX0),
    height: Math.max(1, cropY1 - cropY0),
  };
}

let wasmReady = true; // Wasm supprimé de ce worker — flag toujours vrai pour compatibilité


// Sémaphore / File d'attente (2 tâches concurrentes pour accélérer le débit de rendu mobile)
const MAX_CONCURRENT_RENDERS = 2;
let activeRenders = 0;
const renderQueue = [];

// Cache LRU de pages décodées (max 8 pages) pour réutilisation immédiate lors d'occurrences multiples sur la même page
const pageCache = new Map(); // `${docId}_${pageNumber}` -> { page, docId, lastUsed }
const PAGE_CACHE_MAX = 8;

// Cache LRU de bitmaps de pages complètes rastérisées (max 8 pages) pour extraction instantanée par GPU
const pageBitmapCache = new Map(); // `${docId}_${pageNumber}` -> { bitmap, docId, lastUsed }
const PAGE_BITMAP_CACHE_MAX = 8;
const renderingBitmapPromises = new Map(); // `${docId}_${pageNumber}` -> Promise<ImageBitmap|OffscreenCanvas>

async function getOrRenderPageBitmap(page, docId, pageNumber) {
  const key = `${docId}_${pageNumber}`;
  if (pageBitmapCache.has(key)) {
    const item = pageBitmapCache.get(key);
    item.lastUsed = Date.now();
    return item.bitmap;
  }

  if (renderingBitmapPromises.has(key)) {
    return await renderingBitmapPromises.get(key);
  }

  const renderPromise = (async () => {
    try {
      const viewport = page.getViewport({ scale: CROP_RENDER_SCALE });
      const fullCanvas = new OffscreenCanvas(
        Math.max(1, Math.round(viewport.width)),
        Math.max(1, Math.round(viewport.height))
      );
      const fullCtx = fullCanvas.getContext('2d');

      await page.render({
        canvasContext: fullCtx,
        viewport: viewport,
      }).promise;

      let bitmap;
      if (typeof createImageBitmap === 'function') {
        try {
          bitmap = await createImageBitmap(fullCanvas);
        } catch (_) {
          bitmap = fullCanvas;
        }
      } else {
        bitmap = fullCanvas;
      }

      while (pageBitmapCache.size >= PAGE_BITMAP_CACHE_MAX) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [k, v] of pageBitmapCache.entries()) {
          if (v.lastUsed < oldestTime) {
            oldestTime = v.lastUsed;
            oldestKey = k;
          }
        }
        if (oldestKey) {
          const item = pageBitmapCache.get(oldestKey);
          if (item?.bitmap && typeof item.bitmap.close === 'function') {
            try { item.bitmap.close(); } catch (_) {}
          }
          pageBitmapCache.delete(oldestKey);
        } else break;
      }

      pageBitmapCache.set(key, { bitmap, docId, lastUsed: Date.now() });
      return bitmap;
    } finally {
      renderingBitmapPromises.delete(key);
    }
  })();

  renderingBitmapPromises.set(key, renderPromise);
  return await renderPromise;
}

async function getOrLoadPage(doc, docId, pageNumber) {
  const key = `${docId}_${pageNumber}`;
  if (pageCache.has(key)) {
    const item = pageCache.get(key);
    item.lastUsed = Date.now();
    return item.page;
  }
  const page = await doc.getPage(pageNumber);

  while (pageCache.size >= PAGE_CACHE_MAX) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of pageCache.entries()) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      try { pageCache.get(oldestKey).page.cleanup(); } catch (_) {}
      pageCache.delete(oldestKey);
    } else break;
  }

  pageCache.set(key, { page, docId, lastUsed: Date.now() });
  return page;
}

function clearPageCache(docId = null) {
  for (const [k, v] of pageCache.entries()) {
    if (!docId || v.docId === docId) {
      try { v.page.cleanup(); } catch (_) {}
      pageCache.delete(k);
    }
  }
  for (const [k, v] of pageBitmapCache.entries()) {
    if (!docId || v.docId === docId) {
      if (v?.bitmap && typeof v.bitmap.close === 'function') {
        try { v.bitmap.close(); } catch (_) {}
      }
      pageBitmapCache.delete(k);
    }
  }
}

// Cache LRU de documents PDF.js : la taille est adaptée à la RAM disponible.
// Un PDF chargé en mémoire dans ce Worker peut peser 2× sa taille sur disque
// (Uint8Array IndexedDB + copie interne PDF.js). 2 = équilibre performance/mémoire.
const PDF_LRU_MAX = (typeof navigator !== 'undefined' && navigator.deviceMemory && navigator.deviceMemory <= 4) ? 1 : 2;
const pdfDocCache = new Map(); // docId -> { doc, lastUsed }
const loadingPromises = new Map(); // docId -> Promise<doc>

function getCachedPdfDoc(docId) {
  if (pdfDocCache.has(docId)) {
    const item = pdfDocCache.get(docId);
    item.lastUsed = Date.now();
    return item.doc;
  }
  return null;
}

/**
 * Tente de reconstituer les octets du PDF directement depuis IndexedDB (docseeker_pdf_chunks_v2)
 * Fonctionne 100% hors-ligne, sans requête HTTP ni cookie de session.
 */
async function getCachedPdfBytesFromIndexedDB(docId) {
  const id = Number(docId);
  const normUrl = `/api/pdf/${id || docId}`;
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open('docseeker_pdf_chunks_v2', 2);
      req.onerror = () => resolve(null);
      req.onsuccess = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('meta') || !db.objectStoreNames.contains('chunks')) {
          try { db.close(); } catch (_) {}
          return resolve(null);
        }

        try {
          const metaTx = db.transaction('meta', 'readonly');
          const metaStore = metaTx.objectStore('meta');
          const metaReq = metaStore.get(normUrl);

          metaReq.onerror = () => { try { db.close(); } catch (_) {} resolve(null); };
          metaReq.onsuccess = () => {
            const meta = metaReq.result;
            if (!meta || !meta.totalBytes || meta.totalBytes <= 0) {
              try { db.close(); } catch (_) {}
              return resolve(null);
            }

            const totalBytes = meta.totalBytes;
            const chunkTx = db.transaction('chunks', 'readonly');
            const store = chunkTx.objectStore('chunks');
            const prefix = `${normUrl}#`;
            const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
            const cursorReq = store.openCursor(range);
            let fullArray;
            try {
              fullArray = new Uint8Array(totalBytes);
            } catch (_) {
              try { db.close(); } catch (_) {}
              return resolve(null);
            }
            let readBytes = 0;

            cursorReq.onerror = () => { try { db.close(); } catch (_) {} resolve(null); };
            cursorReq.onsuccess = (ev) => {
              const cursor = ev.target.result;
              if (cursor) {
                const key = String(cursor.key);
                const parts = key.slice(prefix.length).split('_');
                if (parts.length === 2) {
                  const b = parseInt(parts[0], 10);
                  const chunkVal = cursor.value;
                  const chunkBuf = chunkVal instanceof ArrayBuffer ? new Uint8Array(chunkVal) : (ArrayBuffer.isView(chunkVal) ? chunkVal : null);
                  if (chunkBuf && chunkBuf.byteLength) {
                    // Garde anti-RangeError : un fragment périmé (ancien cache, re-téléchargement)
                    // peut dépasser totalBytes du meta ; on l'ignore au lieu de lever,
                    // ce qui laisse la vignette retomber sur le fallback réseau.
                    if (b >= 0 && b + chunkBuf.byteLength <= totalBytes) {
                      fullArray.set(chunkBuf, b);
                      readBytes += chunkBuf.byteLength;
                    }
                  }
                }
                cursor.continue();
              } else {
                try { db.close(); } catch (_) {}
                if (readBytes >= totalBytes || (meta.completed && readBytes > 0)) {
                  resolve(fullArray.buffer);
                } else {
                  resolve(null);
                }
              }
            };
          };
        } catch (_) {
          try { db.close(); } catch (_) {}
          resolve(null);
        }
      };
    } catch (err) {
      resolve(null);
    }
  });
}

/**
 * Vérifie si un document est complètement en cache dans IndexedDB (sans allouer de mémoire binaire)
 */
async function isDocumentCachedInIndexedDB(docId) {
  const id = Number(docId);
  const normUrl = `/api/pdf/${id || docId}`;
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(false);
      const req = indexedDB.open('docseeker_pdf_chunks_v2', 2);
      req.onerror = () => resolve(false);
      req.onsuccess = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('meta')) {
          try { db.close(); } catch (_) {}
          return resolve(false);
        }
        try {
          const tx = db.transaction('meta', 'readonly');
          const store = tx.objectStore('meta');
          const metaReq = store.get(normUrl);
          metaReq.onerror = () => { try { db.close(); } catch (_) {} resolve(false); };
          metaReq.onsuccess = () => {
            const meta = metaReq.result;
            try { db.close(); } catch (_) {}
            if (meta && meta.totalBytes > 0 && (meta.completed || (meta.downloadedBytes && meta.downloadedBytes >= meta.totalBytes))) {
              resolve(true);
            } else {
              resolve(false);
            }
          };
        } catch (_) {
          try { db.close(); } catch (_) {}
          resolve(false);
        }
      };
    } catch (_) {
      resolve(false);
    }
  });
}

async function loadPdfDoc(docId, isOffline = false) {
  const cached = getCachedPdfDoc(docId);
  if (cached) return cached;

  if (loadingPromises.has(docId)) {
    return await loadingPromises.get(docId);
  }

  const loadPromise = (async () => {
    try {
      // 1. Tenter la lecture directe depuis le cache binaire IndexedDB (0ms, 100% hors-ligne pour les PDF standards <= 100 Mo)
      const localBytes = await getCachedPdfBytesFromIndexedDB(docId);
      let loadingTask = null;

      const pdfParams = {
        disableAutoFetch: false,
        disableStream: false,
        ownerDocument: null,
        useSystemFonts: true,
        disableFontFace: true,
        verbosity: 0,
        isEvalSupported: false,
        standardFontDataUrl: new URL('/pdfjs/web/standard_fonts/', self.location.origin).href,
        cMapUrl: new URL('/pdfjs/web/cmaps/', self.location.origin).href,
        cMapPacked: true,
      };

      if (localBytes) {
        loadingTask = pdfjsLib.getDocument({
          data: localBytes,
          ...pdfParams,
        });
      } else {
        // Vérifier si le document est disponible dans IndexedDB (ex: gros PDF > 100 Mo complet)
        const isLocallyCached = await isDocumentCachedInIndexedDB(docId);

        // Détecter si l'application ou le navigateur est en mode hors-ligne
        const isNetworkOffline = (typeof self !== 'undefined' && self.navigator && self.navigator.onLine === false);
        if ((isOffline || isNetworkOffline) && !isLocallyCached) {
          const offlineErr = new Error(`PDF_OFFLINE_UNAVAILABLE: Document ${docId} non mis en cache locale`);
          offlineErr.code = 'PDF_OFFLINE_UNAVAILABLE';
          throw offlineErr;
        }

        // 2. Chargement via URL (PDF.js utilisera RangeReader et lira les fragments directement depuis IndexedDB)
        const pdfUrl = new URL(`/api/pdf/${docId}`, self.location.origin).href;
        loadingTask = pdfjsLib.getDocument({
          url: pdfUrl,
          withCredentials: true,
          ...pdfParams,
        });
      }

      const doc = await loadingTask.promise;

      // Nettoyage LRU si le cache dépasse la limite adaptative
      while (pdfDocCache.size >= PDF_LRU_MAX) {
        let oldestId = null;
        let oldestTime = Infinity;
        for (const [id, item] of pdfDocCache.entries()) {
          if (item.lastUsed < oldestTime) {
            oldestTime = item.lastUsed;
            oldestId = id;
          }
        }
        if (oldestId) {
          clearPageCache(oldestId);
          try { pdfDocCache.get(oldestId).doc.destroy(); } catch (e) {}
          pdfDocCache.delete(oldestId);
        } else break;
      }

      pdfDocCache.set(docId, { doc, lastUsed: Date.now() });
      return doc;
    } finally {
      loadingPromises.delete(docId);
    }
  })();

  loadingPromises.set(docId, loadPromise);
  return await loadPromise;
}

function processQueue() {
  while (activeRenders < MAX_CONCURRENT_RENDERS && renderQueue.length > 0) {
    // Priorité LIFO : les vignettes demandées le plus récemment (sous les yeux de l'utilisateur) sont rendues en premier
    const { id, task, resolve, reject } = renderQueue.pop();
    activeRenders++;

    executeCropRender(task)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeRenders--;
        processQueue();
      });
  }
}

function enqueueCrop(id, task) {
  return new Promise((resolve, reject) => {
    renderQueue.push({ id, task, resolve, reject });
    processQueue();
  });
}

async function executeCropRender(task) {
  const { docId, pageNumber, highlightRects, rect, isOffline } = task;

  // Wasm supprimé — calcul effectué en JS pur (traduction fidèle de crop.rs)
  const doc = await loadPdfDoc(docId, isOffline);
  // Réutilisation directe de la page PDF si déjà décodée récemment (gain majeur sur multi-occurrences)
  const page = await getOrLoadPage(doc, docId, pageNumber);

  try {
    const [x0, y0, x1, y1] = rect;
    const pw = page.view[2] - page.view[0];
    const ph = page.view[3] - page.view[1];

    // Calcul spatial unifié en JS (logique identique à crop.rs::calculate_crop_bounds)
    const bounds = calculateCropBounds(x0, y0, x1, y1, pw, ph);
    const cropX0 = bounds.x0;
    const cropY0 = bounds.y0;
    const cropW = bounds.width * CROP_RENDER_SCALE;
    const cropH = bounds.height * CROP_RENDER_SCALE;

    // Rendu pleine page ou réutilisation immédiate du bitmap déjà décodé (< 1 ms)
    const bitmap = await getOrRenderPageBitmap(page, docId, pageNumber);

    const canvas = new OffscreenCanvas(Math.max(1, Math.round(cropW)), Math.max(1, Math.round(cropH)));
    const ctx = canvas.getContext('2d');

    // Découpage instantané de la sous-région depuis l'ImageBitmap en GPU
    const bmpW = bitmap.width || cropW;
    const bmpH = bitmap.height || cropH;
    const sx = Math.max(0, Math.min(cropX0 * CROP_RENDER_SCALE, bmpW - 1));
    const sy = Math.max(0, Math.min(cropY0 * CROP_RENDER_SCALE, bmpH - 1));
    const sw = Math.min(cropW, bmpW - sx);
    const sh = Math.min(cropH, bmpH - sy);

    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

    // Application du surlignage jaune Goodnotes translucide unifié
    ctx.fillStyle = GOODNOTES_YELLOW_CSS;
    const rects = (highlightRects && highlightRects.length > 0) ? highlightRects : [rect];

    for (const hl of rects) {
      const rx0 = (hl[0] - cropX0) * CROP_RENDER_SCALE;
      const ry0 = (hl[1] - cropY0) * CROP_RENDER_SCALE;
      const rw = (hl[2] - hl[0]) * CROP_RENDER_SCALE;
      const rh = (hl[3] - hl[1]) * CROP_RENDER_SCALE;
      ctx.fillRect(rx0, ry0, rw, rh);
    }

    let blob;
    try {
      blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.80 });
    } catch (e) {
      blob = await canvas.convertToBlob({ type: 'image/png' });
    }
    return blob;
  } catch (err) {
    throw err;
  }
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  if (type === 'CANCEL_TASK') {
    const targetId = payload?.id;
    if (targetId) {
      const idx = renderQueue.findIndex(item => item.id === targetId);
      if (idx !== -1) {
        const [item] = renderQueue.splice(idx, 1);
        if (item?.resolve) item.resolve({ cancelled: true });
      }
    }
    return;
  }

  if (type === 'CLEAR_QUEUE') {
    clearPageCache();
    while (renderQueue.length > 0) {
      const { resolve } = renderQueue.shift();
      if (resolve) resolve(null);
    }
    return;
  }

  if (type === 'RENDER_CROP') {
    try {
      const blob = await enqueueCrop(id, payload);
      self.postMessage({ id, success: true, blob });
    } catch (err) {
      const isNetworkOffline = (typeof self !== 'undefined' && self.navigator && self.navigator.onLine === false);
      const isOfflineMode = Boolean(payload?.isOffline || isNetworkOffline);
      const isExpectedOfflineError = err && (
        err.code === 'PDF_OFFLINE_UNAVAILABLE' ||
        String(err.message || '').includes('PDF_OFFLINE_UNAVAILABLE') ||
        String(err.message || '').includes('NetworkError') ||
        String(err.details || '').includes('NetworkError') ||
        String(err).includes('NetworkError') ||
        (isOfflineMode && err.name === 'UnknownErrorException')
      );

      if (!isExpectedOfflineError) {
        console.error('[CropWorker] Error rendering crop:', err);
      }
      self.postMessage({
        id,
        success: false,
        code: isExpectedOfflineError ? 'PDF_OFFLINE_UNAVAILABLE' : 'RENDER_ERROR',
        error: (err.message || String(err)) + (!isExpectedOfflineError && err.stack ? '\nSTACK:\n' + err.stack : '')
      });
    }
  }
};
