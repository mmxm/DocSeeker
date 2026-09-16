import './worker-setup.js';
import * as pdfjsLib from './pdfjs/build/pdf.mjs';
import * as pdfjsWorker from './pdfjs/build/pdf.worker.mjs';
import initSearchWasm, { calculate_crop_bounds_wasm, get_shared_constants_wasm } from './wasm/search_wasm/search_wasm.js';
import { CLIENT_CONCURRENT_CROP_TASKS } from './environment-limits.js';

if (typeof globalThis !== 'undefined') {
  globalThis.pdfjsWorker = pdfjsWorker;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';

let wasmInitPromise = null;
let wasmReady = false;
let sharedConstants = null;

async function ensureWasm() {
  if (wasmReady) return; // Court-circuit immédiat après la première init
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      await initSearchWasm();
      sharedConstants = JSON.parse(get_shared_constants_wasm());
      wasmReady = true;
    })();
  }
  return wasmInitPromise;
}

// Sémaphore / File d'attente (limite définie dans environment-limits.js)
const MAX_CONCURRENT_RENDERS = CLIENT_CONCURRENT_CROP_TASKS;
let activeRenders = 0;
const renderQueue = [];

// Cache de documents PDF.js ouverts récemment (évite de réanalyser le PDF pour chaque occurrence d'un même doc)
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
  const normUrl = `/api/pdf/${docId}`;
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open('docseeker_pdf_chunks_v2', 2);
      req.onerror = () => resolve(null);
      req.onsuccess = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('meta') || !db.objectStoreNames.contains('chunks')) {
          db.close();
          return resolve(null);
        }

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
          const store = chunkTx.objectStore('chunks');
          const prefix = `${normUrl}#`;
          const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
          const cursorReq = store.openCursor(range);
          const fullArray = new Uint8Array(totalBytes);
          let readBytes = 0;

          cursorReq.onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (cursor) {
              const key = String(cursor.key);
              const parts = key.slice(prefix.length).split('_');
              if (parts.length === 2) {
                const b = parseInt(parts[0], 10);
                const e = parseInt(parts[1], 10);
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
          cursorReq.onerror = () => { db.close(); resolve(null); };
        };
      };
    } catch (err) {
      resolve(null);
    }
  });
}

async function loadPdfDoc(docId) {
  const cached = getCachedPdfDoc(docId);
  if (cached) return cached;

  if (loadingPromises.has(docId)) {
    return await loadingPromises.get(docId);
  }

  const loadPromise = (async () => {
    try {
      // 1. Tenter la lecture directe depuis le cache binaire IndexedDB (0ms, 100% hors-ligne)
      const localBytes = await getCachedPdfBytesFromIndexedDB(docId);
      let loadingTask = null;

      if (localBytes) {
        loadingTask = pdfjsLib.getDocument({
          data: localBytes,
          disableAutoFetch: false,
          disableStream: false,
          ownerDocument: null,
          disableFontFace: true,
        });
      } else {
        // 2. Fallback réseau si en ligne (avec credentials obligatoires pour l'authentification)
        const pdfUrl = new URL(`/api/pdf/${docId}`, self.location.origin).href;
        loadingTask = pdfjsLib.getDocument({
          url: pdfUrl,
          withCredentials: true,
          disableAutoFetch: false,
          disableStream: false,
          ownerDocument: null,
          disableFontFace: true,
        });
      }

      const doc = await loadingTask.promise;

      // Nettoyage LRU si plus de 4 documents ouverts en mémoire
      if (pdfDocCache.size >= 4) {
        let oldestId = null;
        let oldestTime = Infinity;
        for (const [id, item] of pdfDocCache.entries()) {
          if (item.lastUsed < oldestTime) {
            oldestTime = item.lastUsed;
            oldestId = id;
          }
        }
        if (oldestId) {
          try {
            pdfDocCache.get(oldestId).doc.destroy();
          } catch (e) {}
          pdfDocCache.delete(oldestId);
        }
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
  if (activeRenders >= MAX_CONCURRENT_RENDERS || renderQueue.length === 0) {
    return;
  }

  const { task, resolve, reject } = renderQueue.shift();
  activeRenders++;

  executeCropRender(task)
    .then(resolve)
    .catch(reject)
    .finally(() => {
      activeRenders--;
      processQueue();
    });
}

function enqueueCrop(task) {
  return new Promise((resolve, reject) => {
    renderQueue.push({ task, resolve, reject });
    processQueue();
  });
}

async function executeCropRender(task) {
  const { docId, pageNumber, highlightRects, rect } = task;

  await ensureWasm();
  const doc = await loadPdfDoc(docId);
  const page = await doc.getPage(pageNumber);

  try {
    const [x0, y0, x1, y1] = rect;
    const pw = page.view[2] - page.view[0];
    const ph = page.view[3] - page.view[1];

    const scale = sharedConstants ? sharedConstants.crop_render_scale : 1.5;
    const targetW = sharedConstants ? sharedConstants.default_crop_width : 300.0;
    const targetH = sharedConstants ? sharedConstants.default_crop_height : 120.0;
    const yellowCss = sharedConstants ? sharedConstants.goodnotes_yellow_css : "rgba(255, 226, 0, 0.45)";

    // Calcul spatial unifié exécuté par Rust WebAssembly (search-core)
    const bounds = JSON.parse(calculate_crop_bounds_wasm(x0, y0, x1, y1, pw, ph, targetW, targetH));
    const cropX0 = bounds.x0;
    const cropY0 = bounds.y0;
    const cropW = bounds.width * scale;
    const cropH = bounds.height * scale;

    const canvas = new OffscreenCanvas(Math.max(1, Math.round(cropW)), Math.max(1, Math.round(cropH)));
    const ctx = canvas.getContext('2d');

    const viewport = page.getViewport({ scale });

    // Rendu avec translation négative pour ne dessiner que la sous-région
    await page.render({
      canvasContext: ctx,
      viewport: viewport,
      transform: [1, 0, 0, 1, -cropX0 * scale, -cropY0 * scale],
    }).promise;

    // Application du surlignage jaune Goodnotes translucide unifié
    ctx.fillStyle = yellowCss;
    const rects = (highlightRects && highlightRects.length > 0) ? highlightRects : [rect];

    for (const hl of rects) {
      const rx0 = (hl[0] - cropX0) * scale;
      const ry0 = (hl[1] - cropY0) * scale;
      const rw = (hl[2] - hl[0]) * scale;
      const rh = (hl[3] - hl[1]) * scale;
      ctx.fillRect(rx0, ry0, rw, rh);
    }

    let blob;
    try {
      blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
    } catch (e) {
      blob = await canvas.convertToBlob({ type: 'image/png' });
    }
    return blob;
  } finally {
    page.cleanup();
  }
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  if (type === 'CLEAR_QUEUE') {
    while (renderQueue.length > 0) {
      const { resolve } = renderQueue.shift();
      resolve(null);
    }
    return;
  }

  if (type === 'RENDER_CROP') {
    try {
      const blob = await enqueueCrop(payload);
      self.postMessage({ id, success: true, blob });
    } catch (err) {
      console.error('[CropWorker] Error rendering crop:', err);
      self.postMessage({ id, success: false, error: (err.message || String(err)) + '\nSTACK:\n' + (err.stack || '') });
    }
  }
};
