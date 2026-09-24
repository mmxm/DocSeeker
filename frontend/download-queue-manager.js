/**
 * DocSeeker - DownloadQueueManager
 * 
 * Gestionnaire unifié de la file d'attente de téléchargement et de synchronisation résiliente :
 * - Télécharge le bundle d'index et l'insère dans SQLite-Wasm (via offlineSearchWorker).
 * - Met en cache la couverture dans CacheStorage ('docseeker_covers').
 * - Déclenche le téléchargement intégral des fragments PDF par chargement headless de pdf.mjs.
 * - Limite la concurrence à 2 transferts simultanés avec pause, reprise et annulation.
 */

class DownloadQueueManager {
  constructor() {
    this.queue = []; // Array of docIds in queue
    this.activeTasks = new Map(); // docId -> { docId, status, progress, controller, pdfTask }
    this.cachedDocIds = new Set(); // Set of docIds indexed locally in SQLite-Wasm
    this.maxConcurrent = 2;
    this.isPaused = false;
    this.listeners = new Set();
    this.worker = null;
    this._workerReqId = 0;
    this._workerCallbacks = new Map();
    this._workerFailed = false;
    this._indexingDocIds = new Set();
    this._syncedDocMetaMap = new Map();
    this._lastSyncedFoldersHash = '';

    this._initWorker();
  }

  reinitializeWorker() {
    console.log('[DownloadQueueManager] Réinitialisation du Worker de recherche locale...');
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) {}
    }
    for (const [, { reject }] of this._workerCallbacks) {
      try { reject(new Error("Worker réinitialisé suite à une mise à jour")); } catch (e) {}
    }
    this._workerCallbacks.clear();
    this._syncedDocMetaMap.clear();
    this._lastSyncedFoldersHash = '';
    this._workerFailed = false;
    this._initWorker();
  }

  _initWorker() {
    if (typeof Worker !== 'undefined') {
      try {
        const v = (typeof window !== 'undefined' && window.DOCSEEKER_VERSION) || (typeof document !== 'undefined' && document.querySelector('meta[name="app-version"]')?.getAttribute('content')) || '8.6';
        this.worker = new Worker(`/offline-search-worker.js?v=${v}`, { type: 'module' });
        this.worker.onerror = (err) => {
          console.warn('[DownloadQueueManager] Erreur ou échec du Web Worker offline:', err);
          this._workerFailed = true;
          for (const [id, { reject }] of this._workerCallbacks) {
            reject(new Error("Web Worker offline indisponible"));
          }
          this._workerCallbacks.clear();
        };

        this.worker.onmessage = (e) => {
          const { id, success, data, error } = e.data;
          if (this._workerCallbacks.has(id)) {
            const { resolve, reject } = this._workerCallbacks.get(id);
            this._workerCallbacks.delete(id);
            if (success) resolve(data);
            else reject(new Error(error));
          }
        };

        // Initialiser avec une borne temporelle stricte pour ne jamais bloquer l'application
        this._initPromise = Promise.race([
          Promise.all([
            this.getAllCachedDocs().catch(() => []),
            this.getAllCachedFolders().catch(() => [])
          ]).then(() => {
            this._notify();
          }),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]).catch(err => console.warn('[DownloadQueueManager] Initialisation cached docs/folders:', err));
      } catch (e) {
        console.warn('[DownloadQueueManager] Impossible d\'instancier le Web Worker offline:', e);
        this._workerFailed = true;
        this._initPromise = Promise.resolve();
      }
    } else {
      this._initPromise = Promise.resolve();
    }
  }

  async ensureInitialized(timeoutMs = 5000) {
    if (this._workerFailed) return;
    if (this._initPromise) {
      await Promise.race([
        this._initPromise,
        new Promise(resolve => setTimeout(resolve, timeoutMs))
      ]).catch(() => {});
    }
  }

  sendToWorker(type, payload, timeoutMs = 10000) {
    if (!this.worker || this._workerFailed) {
      return Promise.reject(new Error("Worker offline non disponible"));
    }
    const id = ++this._workerReqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._workerCallbacks.has(id)) {
          this._workerCallbacks.delete(id);
          reject(new Error(`Timeout (${timeoutMs}ms) en attente du worker pour ${type}`));
        }
      }, timeoutMs);

      this._workerCallbacks.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      try {
        this.worker.postMessage({ id, type, payload });
      } catch (err) {
        clearTimeout(timer);
        this._workerCallbacks.delete(id);
        reject(err);
      }
    });
  }

  isDocumentCached(docId) {
    return this.cachedDocIds.has(Number(docId));
  }

  async syncFolders(folders) {
    if (Array.isArray(folders)) {
      this._allFolders = folders;
      await this.sendToWorker('SYNC_FOLDERS', { folders }).catch(() => {});
    }
  }

  // Miroir complet de la bibliothèque (dossiers + méta de TOUS les docs) dans
  // SQLite local : l'arborescence reste consultable hors-ligne, les documents
  // non téléchargés étant marqués 'meta-only' (visibles mais non consultables).
  async syncLibraryMeta(documents, folders) {
    if (!Array.isArray(documents)) return;
    this._libraryDocsList = documents.map(d => ({
      id: Number(d.id),
      filename: d.filename,
      title: d.title || d.filename,
      folder_id: d.folder_id ?? null,
      total_pages: d.total_pages || 0,
      file_size: d.file_size || 0,
      created_at: d.created_at,
      updated_at: d.updated_at
    }));
    if (Array.isArray(folders)) this._allFolders = folders;

    // Delta sync : détecter uniquement les documents et dossiers modifiés
    const deltaDocs = [];
    const currentMetaMap = new Map();
    for (const d of this._libraryDocsList) {
      const sig = `${d.title}|${d.folder_id}|${d.total_pages}|${d.file_size}|${d.updated_at || d.created_at || ''}`;
      currentMetaMap.set(d.id, sig);
      if (this._syncedDocMetaMap.get(d.id) !== sig) {
        deltaDocs.push(d);
      }
    }

    let foldersToSync = null;
    if (Array.isArray(folders)) {
      const foldersHash = folders.map(f => `${f.id}:${f.name}:${f.parent_id}:${f.color}`).join(';');
      if (foldersHash !== this._lastSyncedFoldersHash) {
        foldersToSync = folders;
        this._lastSyncedFoldersHash = foldersHash;
      }
    }

    // Si aucun document n'a changé et les dossiers sont identiques, skip le message worker
    if (deltaDocs.length === 0 && !foldersToSync) {
      return;
    }

    this._syncedDocMetaMap = currentMetaMap;
    await this.sendToWorker('SYNC_LIBRARY_META', { documents: deltaDocs, folders: foldersToSync }).catch(() => {});
  }

  // Tous les documents connus (cache + miroir) — pour l'arborescence hors-ligne.
  async getAllKnownDocs() {
    const docs = await this.sendToWorker('GET_ALL_KNOWN_DOCS', {}).catch(() => []);
    if (Array.isArray(docs)) return docs;
    return this._libraryDocsList || [];
  }

  // Le document existe-t-il dans le miroir local (méta synchronisée) ?
  isDocumentKnown(docId) {
    const id = Number(docId);
    if (this._libraryDocsList) return this._libraryDocsList.some(d => Number(d.id) === id);
    if (Array.isArray(this._cachedDocsList)) return this._cachedDocsList.some(d => Number(d.id) === id);
    return false;
  }

  async syncDocFolders(docs) {
    if (!Array.isArray(docs) || docs.length === 0) return;
    await this.sendToWorker('UPDATE_DOC_FOLDERS', {
      docs: docs.map(d => ({
        id: Number(d.id),
        folder_id: d.folder_id !== null && d.folder_id !== undefined ? Number(d.folder_id) : null
      }))
    }).catch(() => {});
    const allDocs = await this.getAllCachedDocs().catch(() => []);
    if (Array.isArray(allDocs)) {
      this._cachedDocsList = allDocs;
    }
    this._notify();
  }

  async getAllCachedFolders() {
    const folders = await this.sendToWorker('GET_ALL_CACHED_FOLDERS', {}).catch(() => []);
    if (Array.isArray(folders)) {
      this._allFolders = folders;
    }
    return folders;
  }

  getCachedDocsCountForFolder(folderId) {
    if (!Array.isArray(this._cachedDocsList)) return 0;
    const fid = Number(folderId);
    if (!fid) return 0;

    // Construire récursivement la liste de ce dossier et de tous ses sous-dossiers
    const targetFolderIds = new Set([fid]);
    if (Array.isArray(this._allFolders)) {
      const addDescendants = (parentId) => {
        for (const f of this._allFolders) {
          if (Number(f.parent_id) === Number(parentId) && !targetFolderIds.has(Number(f.id))) {
            targetFolderIds.add(Number(f.id));
            addDescendants(Number(f.id));
          }
        }
      };
      addDescendants(fid);
    }

    return this._cachedDocsList.filter(d => d.folder_id !== null && d.folder_id !== undefined && targetFolderIds.has(Number(d.folder_id))).length;
  }

  async isDocumentFullyCached(docId) {
    const id = Number(docId);
    if (!this.cachedDocIds.has(id)) return false;
    if (window.pdfCacheManager) {
      return await window.pdfCacheManager.isComplete(id);
    }
    return true;
  }

  async ensureDocumentIndexedLocally(docId) {
    const id = Number(docId);
    if (!id || this.cachedDocIds.has(id) || this._indexingDocIds.has(id)) return;
    this._indexingDocIds.add(id);
    try {
      const bundleRes = await fetch(`/api/documents/${id}/offline-bundle`);
      if (bundleRes.ok) {
        const bundle = await bundleRes.json();
        await this.sendToWorker('INSERT_BUNDLE', { bundle }, 60000);
        const isComplete = window.pdfCacheManager ? await window.pdfCacheManager.isComplete(id) : false;
        if (isComplete) {
          this.cachedDocIds.add(id);
        }
        const allDocs = await this.getAllCachedDocs().catch(() => []);
        if (Array.isArray(allDocs)) {
          this._cachedDocsList = allDocs;
        }
        this._notify();
        console.log(`[DownloadQueueManager] Document ${id} indexé localement.`);
      }
    } catch (e) {
      console.warn(`[DownloadQueueManager] Erreur ensureDocumentIndexedLocally(${id}):`, e);
    } finally {
      this._indexingDocIds.delete(id);
    }
  }

  async getAllCachedDocs() {
    const docs = await this.sendToWorker('GET_ALL_CACHED_DOCS', {});
    if (Array.isArray(docs)) {
      const verifiedDocs = [];
      for (const d of docs) {
        const id = Number(d.id);
        const isPdfComplete = window.pdfCacheManager ? await window.pdfCacheManager.isComplete(id) : true;
        if (isPdfComplete) {
          verifiedDocs.push(d);
        }
      }
      this._cachedDocsList = verifiedDocs;
      this.cachedDocIds = new Set(verifiedDocs.map(d => Number(d.id)));
      return verifiedDocs;
    }
    return docs;
  }

  async reconcileCacheIntegrity() {
    return await this.getAllCachedDocs();
  }

  // Le nombre de pages réel remonté par PDF.js (source de vérité) est persisté
  // dans SQLite local : le popover "Nombre de pages" et l'offline l'utilisent.
  async updateDocTotalPages(docId, totalPages) {
    const id = Number(docId);
    if (!id || !Number.isFinite(totalPages) || totalPages <= 0) return;
    try {
      await this.sendToWorker('UPDATE_DOC_TOTAL_PAGES', { docId: id, totalPages });
      if (Array.isArray(this._cachedDocsList)) {
        const doc = this._cachedDocsList.find(d => Number(d.id) === id);
        if (doc) doc.total_pages = totalPages;
      }
    } catch (e) {
      // Silencieux : la DB distante reste la source primaire de l'affichage.
    }
  }

  async removeDocumentFromCache(docId) {
    const id = Number(docId);
    if (!id) return;
    await this.cancelDownload(id);
    await this.sendToWorker('DELETE_DOCUMENT', { docId: id }).catch(() => {});
    this.cachedDocIds.delete(id);
    if (Array.isArray(this._cachedDocsList)) {
      this._cachedDocsList = this._cachedDocsList.filter(d => Number(d.id) !== id);
    }
    if (window.pdfCacheManager) {
      await window.pdfCacheManager.invalidate(id).catch(() => {});
    }
    if (typeof caches !== 'undefined') {
      try {
        const coverCache = await caches.open('docseeker_covers');
        await coverCache.delete(`/api/cover/${id}`);
        const cropCache = await caches.open('docseeker_offline_crops');
        const keys = await cropCache.keys();
        for (const req of keys) {
          if (req.url.includes(`/api/crop/${id}/`)) {
            await cropCache.delete(req);
          }
        }
      } catch (e) {}
    }
    this._notify();
    console.log(`[DownloadQueueManager] Document ${id} supprimé du cache local`);
  }

  async removeFolderFromCache(folderId) {
    try {
      const foldersRes = await fetch('/api/folders').catch(() => null);
      let allFolders = [];
      if (foldersRes && foldersRes.ok) {
        const json = await foldersRes.json();
        allFolders = json.folders || [];
      }
      const targetFolderIds = new Set();
      const findChildren = (fid) => {
        targetFolderIds.add(fid);
        for (const f of allFolders) {
          if (f.parent_id === fid) findChildren(f.id);
        }
      };
      findChildren(Number(folderId));

      const docsRes = await fetch('/api/documents').catch(() => null);
      let docs = [];
      if (docsRes && docsRes.ok) {
        const json = await docsRes.json();
        docs = json.documents || [];
      } else {
        docs = await this.getAllCachedDocs().catch(() => []);
      }
      const matchingDocs = docs.filter(d => targetFolderIds.has(d.folder_id));
      for (const doc of matchingDocs) {
        await this.removeDocumentFromCache(doc.id);
      }
    } catch (err) {
      console.error(`[DownloadQueueManager] Erreur purge du dossier ${folderId}:`, err);
    }
  }

  onUpdate(callback) {
    this.listeners.add(callback);
    this._notify();
    return () => this.listeners.delete(callback);
  }

  addListener(callback) {
    return this.onUpdate(callback);
  }

  _notify() {
    const state = {
      queueCount: this.queue.length,
      activeCount: this.activeTasks.size,
      activeTasks: Array.from(this.activeTasks.values()),
      isPaused: this.isPaused,
      cachedDocIds: Array.from(this.cachedDocIds),
    };
    for (const cb of this.listeners) {
      try {
        cb(state);
      } catch (e) {
        console.error('[DownloadQueueManager] Erreur listener:', e);
      }
    }
  }

  /**
   * Enfile un document pour mise en cache complète
   */
  async enqueueDocument(docId) {
    const id = Number(docId);
    if (!id || this.queue.includes(id) || this.activeTasks.has(id)) {
      return;
    }

    await this.ensureInitialized(1500).catch(() => {});

    // Vérifier si le document est déjà 100% complet (PDF + SQLite-Wasm index)
    const isBundleIndexed = this.cachedDocIds.has(id);
    let isPdfComplete = false;
    if (window.pdfCacheManager) {
      isPdfComplete = await window.pdfCacheManager.isComplete(id);
    }

    if (isBundleIndexed && isPdfComplete) {
      console.log(`[DownloadQueueManager] Document ${id} déjà présent à 100% dans le cache`);
      this._notify();
      return;
    }

    this.queue.push(id);
    this._notify();
    this._processNext();
  }

  /**
   * Enfile récursivement tous les documents d'un dossier et de ses sous-dossiers
   */
  async enqueueFolder(folderId) {
    try {
      console.log(`[DownloadQueueManager] Résolution récursive du dossier ${folderId}...`);
      
      // 1. Récupérer l'arborescence des dossiers
      const foldersRes = await fetch('/api/folders').catch(() => null);
      let allFolders = [];
      if (foldersRes && foldersRes.ok) {
        const json = await foldersRes.json();
        allFolders = json.folders || [];
        // Mettre à jour la table des dossiers dans le worker
        this.sendToWorker('SYNC_FOLDERS', { folders: allFolders }).catch(() => {});
      }

      // Construction des sous-dossiers récursifs
      const targetFolderIds = new Set();
      const findChildren = (fid) => {
        targetFolderIds.add(fid);
        for (const f of allFolders) {
          if (f.parent_id === fid) {
            findChildren(f.id);
          }
        }
      };
      findChildren(Number(folderId));

      // 2. Récupérer tous les documents rattachés
      const docsRes = await fetch('/api/documents').catch(() => null);
      if (docsRes && docsRes.ok) {
        const docsJson = await docsRes.json();
        const docs = docsJson.documents || [];
        await this.syncDocFolders(docs);
        const matchingDocs = docs.filter(d => targetFolderIds.has(d.folder_id));

        console.log(`[DownloadQueueManager] ${matchingDocs.length} documents trouvés dans l'arborescence du dossier ${folderId}`);
        for (const doc of matchingDocs) {
          await this.enqueueDocument(doc.id);
        }
      }
    } catch (err) {
      console.error(`[DownloadQueueManager] Erreur mise en cache du dossier ${folderId}:`, err);
    }
  }

  /**
   * Pause globale ou individuelle
   */
  pauseDownload(docId) {
    if (docId) {
      const task = this.activeTasks.get(Number(docId));
      if (task) {
        task.status = 'paused';
        if (task.controller) {
          try { task.controller.abort(); } catch (e) {}
        }
        if (task.pdfTask) {
          try { task.pdfTask.destroy(); } catch (e) {}
        }
        this.activeTasks.delete(Number(docId));
        this.queue.unshift(Number(docId)); // Remettre en tête de file
        this._notify();
      }
    } else {
      this.isPaused = true;
      this._notify();
    }
  }

  /**
   * Reprise du téléchargement
   */
  resumeDownload(docId) {
    if (docId) {
      this.enqueueDocument(Number(docId));
    } else {
      this.isPaused = false;
      this._notify();
      this._processNext();
    }
  }

  /**
   * Annulation et suppression d'un téléchargement en cours
   */
  async cancelDownload(docId) {
    const id = Number(docId);
    this.queue = this.queue.filter(qId => qId !== id);

    const task = this.activeTasks.get(id);
    if (task) {
      if (task.controller) {
        try { task.controller.abort(); } catch (e) {}
      }
      if (task.pdfTask) {
        try { task.pdfTask.destroy(); } catch (e) {}
      }
      this.activeTasks.delete(id);
    }

    if (window.pdfCacheManager) {
      await window.pdfCacheManager.invalidate(id);
    }

    this._notify();
    this._processNext();
  }

  /**
   * Dépilement et exécution séquentielle concurrente
   */
  async _processNext() {
    if (this.isPaused || this.activeTasks.size >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const docId = this.queue.shift();
    if (!docId) return;

    const task = {
      docId,
      status: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      pdfTask: null,
    };
    this.activeTasks.set(docId, task);
    this._notify();

    // Écoute de progression depuis pdfCacheManager
    const unbindProgress = window.pdfCacheManager ? window.pdfCacheManager.onProgress(docId, (info) => {
      task.progress = info.progress || 0;
      task.downloadedBytes = info.downloadedBytes || 0;
      task.totalBytes = info.totalBytes || 0;
      if (info.status === 'complete') {
        task.status = 'complete';
      }
      this._notify();
    }) : null;

    try {
      // S'assurer que les dossiers sont synchronisés dans le worker
      if (Array.isArray(this._allFolders) && this._allFolders.length > 0) {
        await this.sendToWorker('SYNC_FOLDERS', { folders: this._allFolders }).catch(() => {});
      } else {
        const foldersRes = await fetch('/api/folders').catch(() => null);
        if (foldersRes && foldersRes.ok) {
          const fJson = await foldersRes.json();
          if (Array.isArray(fJson.folders)) {
            this._allFolders = fJson.folders;
            await this.sendToWorker('SYNC_FOLDERS', { folders: this._allFolders }).catch(() => {});
          }
        }
      }

      // 1. Télécharger le offline-bundle (Index textuel et spatial) et l'injecter dans SQLite-Wasm
      const bundleRes = await fetch(`/api/documents/${docId}/offline-bundle`);
      if (bundleRes.ok) {
        const bundle = await bundleRes.json();
        await this.sendToWorker('INSERT_BUNDLE', { bundle });
        // NOTE: Ne pas ajouter à cachedDocIds ici : le document n'est disponible qu'une fois son binaire 100% complet !
      }

      // 2. Mettre en cache l'image de couverture dans CacheStorage
      if (typeof caches !== 'undefined') {
        const coverRes = await fetch(`/api/cover/${docId}`).catch(() => null);
        if (coverRes && coverRes.ok) {
          const cache = await caches.open('docseeker_covers');
          await cache.put(`/api/cover/${docId}`, coverRes);
        }
      }

      // 3. Déclencher le téléchargement binaire et stockage incrémental dans IndexedDB
      // Vérifier d'abord si déjà complet
      if (window.pdfCacheManager) {
        const alreadyComplete = await window.pdfCacheManager.isComplete(docId);
        if (alreadyComplete) {
          task.status = 'complete';
          task.progress = 100;
          this.cachedDocIds.add(docId);
          this._notify();
          return;
        }
      }

      // Si le document est actuellement ouvert dans le viewer, PDF.js le télécharge déjà avec priorité
      if (typeof window !== "undefined" && window.currentActiveDocId && Number(window.currentActiveDocId) === Number(docId)) {
        console.log(`[DownloadQueueManager] Doc ${docId} est ouvert dans le viewer, coordination avec PDF.js`);
        await new Promise((resolve) => {
          let resolved = false;
          const check = async () => {
            if (resolved) return;
            const complete = window.pdfCacheManager ? await window.pdfCacheManager.isComplete(docId) : false;
            if (complete) {
              resolved = true;
              resolve();
            }
          };
          const interval = setInterval(check, 300);
          const unbind = window.pdfCacheManager?.onProgress(docId, (info) => {
            if (info.status === 'complete' || info.progress >= 100) {
              if (!resolved) {
                resolved = true;
                clearInterval(interval);
                unbind?.();
                resolve();
              }
            }
          });
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              clearInterval(interval);
              unbind?.();
              resolve();
            }
          }, 120000);
        });
      } else {
        const controller = new AbortController();
        task.controller = controller;

        const CHUNK_SIZE = 256 * 1024;
        const normUrl = `/api/pdf/${docId}`;
        const prefix = `${normUrl}#`;

        // Scanner les clés de chunks déjà existants pour éviter les écritures redondantes
        const db = window.pdfCacheManager ? await window.pdfCacheManager.init() : null;
        const existingChunks = new Set();
        if (db && db.objectStoreNames.contains('chunks')) {
          await new Promise((resolve) => {
            try {
              const tx = db.transaction('chunks', 'readonly');
              const store = tx.objectStore('chunks');
              const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
              const req = store.openKeyCursor(range);
              req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                  existingChunks.add(String(cursor.key));
                  cursor.continue();
                } else {
                  resolve();
                }
              };
              req.onerror = () => resolve();
            } catch (e) {
              resolve();
            }
          });
        }

        const pdfRes = await fetch(`/api/pdf/${docId}`, { signal: controller.signal });
        if (pdfRes.ok) {
          const contentLength = Number(pdfRes.headers.get('content-length')) || 0;
          task.totalBytes = contentLength;

          if (window.pdfCacheManager && contentLength > 0) {
            window.pdfCacheManager.setDocumentTotalBytes(docId, contentLength);
          }

          if (pdfRes.body && contentLength > 0) {
            const reader = pdfRes.body.getReader();
            let receivedBytes = 0;
            let currentOffset = 0;
            let accumulator = new Uint8Array(CHUNK_SIZE * 2);
            let accumulatorLen = 0;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              if (accumulatorLen + value.length > accumulator.length) {
                const newAcc = new Uint8Array(Math.max(accumulator.length * 2, accumulatorLen + value.length));
                newAcc.set(accumulator.subarray(0, accumulatorLen), 0);
                accumulator = newAcc;
              }
              accumulator.set(value, accumulatorLen);
              accumulatorLen += value.length;
              receivedBytes += value.length;

              // Découper et persister les blocs complets de 256 Ko immédiatement au fil de l'eau
              while (accumulatorLen >= CHUNK_SIZE) {
                const chunkData = accumulator.slice(0, CHUNK_SIZE);
                const begin = currentOffset;
                const end = begin + CHUNK_SIZE;
                const chunkKey = `${normUrl}#${begin}_${end}`;

                if (db && !existingChunks.has(chunkKey)) {
                  try {
                    const tx = db.transaction('chunks', 'readwrite');
                    tx.objectStore('chunks').put(chunkData.buffer, chunkKey);
                    existingChunks.add(chunkKey);
                  } catch (e) {}
                }

                currentOffset = end;
                accumulator.copyWithin(0, CHUNK_SIZE, accumulatorLen);
                accumulatorLen -= CHUNK_SIZE;
              }

              task.downloadedBytes = receivedBytes;
              task.progress = Math.min(99, Math.round((receivedBytes / contentLength) * 100));
              this._notify();
            }

            // Écrire le reliquat final (< 256 Ko)
            if (accumulatorLen > 0) {
              const chunkData = accumulator.slice(0, accumulatorLen);
              const begin = currentOffset;
              const end = begin + accumulatorLen;
              const chunkKey = `${normUrl}#${begin}_${end}`;
              if (db && !existingChunks.has(chunkKey)) {
                try {
                  const tx = db.transaction('chunks', 'readwrite');
                  tx.objectStore('chunks').put(chunkData.buffer, chunkKey);
                  existingChunks.add(chunkKey);
                } catch (e) {}
              }
            }

            // Marquer complet dans meta
            if (db) {
              try {
                const metaTx = db.transaction('meta', 'readwrite');
                metaTx.objectStore('meta').put({
                  url: normUrl,
                  totalBytes: contentLength,
                  downloadedBytes: contentLength,
                  completed: true,
                  updatedAt: Date.now()
                }, normUrl);
              } catch (e) {}
            }

            if (window.pdfCacheManager) {
              await window.pdfCacheManager.markComplete(docId, contentLength);
            }
          } else {
            const arrayBuffer = await pdfRes.arrayBuffer();
            const actualTotal = arrayBuffer.byteLength;
            if (db) {
              const tx = db.transaction(['chunks', 'meta'], 'readwrite');
              const chunkStore = tx.objectStore('chunks');
              const metaStore = tx.objectStore('meta');

              for (let begin = 0; begin < actualTotal; begin += CHUNK_SIZE) {
                const end = Math.min(begin + CHUNK_SIZE, actualTotal);
                const chunkData = arrayBuffer.slice(begin, end);
                chunkStore.put(chunkData, `${normUrl}#${begin}_${end}`);
              }

              metaStore.put({
                url: normUrl,
                totalBytes: actualTotal,
                downloadedBytes: actualTotal,
                completed: true,
                updatedAt: Date.now()
              }, normUrl);

              await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
              if (window.pdfCacheManager) {
                await window.pdfCacheManager.markComplete(docId, actualTotal);
              }
            }
          }
        }
      }

      this.cachedDocIds.add(docId);
      const allDocs = await this.getAllCachedDocs().catch(() => []);
      if (Array.isArray(allDocs)) {
        this._cachedDocsList = allDocs;
      }

      task.status = 'complete';
      task.progress = 100;
      this._notify();
    } catch (err) {
      console.warn(`[DownloadQueueManager] Erreur ou interruption pour le doc ${docId}:`, err);
      if (err && err.message && err.message.includes("Worker réinitialisé")) {
        // Le worker a été rechargé (activation SW) : ré-enfiler automatiquement pour reprise transparente
        this.queue.unshift(docId);
      } else {
        task.status = 'error';
      }
    } finally {
      this.activeTasks.delete(docId);
      this._notify();
      // Enchaîner sur les documents suivants
      setTimeout(() => this._processNext(), 100);
    }
  }

  /**
   * Vérification de synchronisation (Last-Write-Wins)
   */
  async checkSync() {
    if (!navigator.onLine) return;

    try {
      console.log('[DownloadQueueManager] Vérification de synchronisation avec le serveur...');
      
      // 1. Récupérer la liste des documents locaux depuis SQLite-Wasm
      const cachedDocs = await this.sendToWorker('GET_CACHED_DOCS', {});
      if (!cachedDocs || cachedDocs.length === 0) return;

      // 2. Interroger POST /api/sync/check
      const res = await fetch('/api/sync/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cached_documents: cachedDocs })
      });

      if (!res.ok) return;
      const data = await res.json();
      const { outdated_ids, deleted_ids } = data;

      // 3. Traiter les suppressions distantes
      if (Array.isArray(deleted_ids)) {
        for (const id of deleted_ids) {
          console.log(`[DownloadQueueManager] Document ${id} supprimé sur le serveur, purge locale.`);
          await this.sendToWorker('DELETE_DOCUMENT', { docId: id });
          if (window.pdfCacheManager) {
            await window.pdfCacheManager.invalidate(id);
          }
        }
      }

      // 4. Traiter les documents obsolètes (invalidation + réenfilement)
      if (Array.isArray(outdated_ids)) {
        for (const id of outdated_ids) {
          console.log(`[DownloadQueueManager] Document ${id} modifié sur le serveur, re-téléchargement propre.`);
          if (window.pdfCacheManager) {
            await window.pdfCacheManager.invalidate(id);
          }
          await this.enqueueDocument(id);
        }
      }
    } catch (err) {
      if (navigator.onLine) {
        console.warn('[DownloadQueueManager] Erreur synchronisation sync/check:', err);
      }
    }
  }
}

// Instance globale unique
if (typeof window !== 'undefined') {
  window.downloadQueueManager = new DownloadQueueManager();

  // Déclencher une vérification de synchronisation dès reconnexion
  window.addEventListener('online', () => {
    window.downloadQueueManager.checkSync();
  });
}
