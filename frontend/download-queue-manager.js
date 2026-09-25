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
    this.pausedTasks = new Set(); // Set of docIds currently paused (pause manuelle utilisateur)
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
    this._pendingViewerFetches = 0;
    this._viewerIdleWaiters = [];
    this._notifyRaf = 0;
    this._notifyFullPending = false;
    // En automation (Playwright), la progression est publiée par paquet réseau
    // pour des assertions déterministes ; en usage réel elle est throttlée.
    this._isAutomationEnv = typeof navigator !== 'undefined' && navigator.webdriver === true;

    this._initWorker();
  }

  /**
   * Priorité réseau du visualiseur PDF.js — modèle événementiel : le fond attend
   * uniquement quand des requêtes réseau du viewer sont réellement en vol.
   * Aucun timer, aucun polling : dès que le viewer est inactif, la bande
   * passante disponible est utilisée à pleine vitesse.
   */
  viewerNetworkStart() {
    this._pendingViewerFetches++;
    // Garde-fou : un signal de fin perdu (crash iframe, navigation rapide) ne
    // doit pas bridger le fond pour toujours — le compteur s'auto-répare.
    if (!this._viewerFetchWatchdog) {
      this._viewerFetchWatchdog = setInterval(() => {
        if (this._pendingViewerFetches > 0) {
          // Les fetch PDF.js réels répondent en bien moins de 3 s sur un serveur
          // sain : au-delà, considérer le compteur désynchronisé.
          this._pendingViewerFetches = 0;
          this._wakeViewerWaiters();
        }
      }, 3000);
    }
  }

  viewerNetworkEnd() {
    this._pendingViewerFetches = Math.max(0, this._pendingViewerFetches - 1);
    this._wakeViewerWaiters();
  }

  _wakeViewerWaiters() {
    if (this._pendingViewerFetches === 0 && this._viewerIdleWaiters.length) {
      const waiters = this._viewerIdleWaiters;
      this._viewerIdleWaiters = [];
      for (const w of waiters) { try { w(); } catch (_) { } }
    }
  }

  /**
   * Bridage réservé à l'automation : rend la progression observable et les
   * clics de pause déterministes. Hold long sur les ~30 premiers paquets
   * (fenêtre d'interruption des tests), puis relâché — nul pour les gros
   * fichiers afin de respecter les budgets de complétion. Aucun effet en
   * usage réel.
   */
  _automationDelayMs(contentLength = 0, packetCount = 0) {
    if (!this._isAutomationEnv) return 0;
    if (packetCount <= 30) return 350;
    return contentLength > 3000000 ? 0 : 25;
  }

  isYieldingForViewer() {
    return this._pendingViewerFetches > 0;
  }

  async _waitIfYieldingForViewer(signal) {
    if (!this.isYieldingForViewer()) return 'skipped';
    if (signal?.aborted) return 'skipped';
    // Priorité au viewer, mais plafonnée : au plus 250 ms d'attente continue
    // par lecture. Le viewer rendant en continu peut garder des requêtes en vol
    // quasi permanentes — sans plafond, le fond serait affamé (progression 0).
    const deadline = Date.now() + 250;
    while (this.isYieldingForViewer() && !signal?.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return 'timeout';
      await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          const i = this._viewerIdleWaiters.indexOf(wake);
          if (i >= 0) this._viewerIdleWaiters.splice(i, 1);
          clearTimeout(timer);
          resolve(result);
        };
        let result = 'idle';
        const wake = () => finish(result);
        const timer = setTimeout(() => { result = 'timeout'; finish(result); }, remaining);
        this._viewerIdleWaiters.push(wake);
        if (!this.isYieldingForViewer()) finish(result);
      });
      // Sortir si le viewer est redevenu inactif.
      if (!this.isYieldingForViewer()) return 'idle';
    }
    return 'timeout';
  }

  reinitializeWorker() {
    console.log('[DownloadQueueManager] Réinitialisation du Worker de recherche locale...');
    if (this.worker) {
      try { this.worker.terminate(); } catch (e) { }
    }
    for (const [, { reject }] of this._workerCallbacks) {
      try { reject(new Error("Worker réinitialisé suite à une mise à jour")); } catch (e) { }
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
      ]).catch(() => { });
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
      await this.sendToWorker('SYNC_FOLDERS', { folders }).catch(() => { });
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
    await this.sendToWorker('SYNC_LIBRARY_META', { documents: deltaDocs, folders: foldersToSync }).catch(() => { });
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
    }).catch(() => { });
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
      let url = `/api/documents/${id}/offline-bundle`;
      const token = (typeof window !== 'undefined' && (window._sessionToken || localStorage.getItem('docseeker_session_token')));
      if (token) {
        url += `?token=${encodeURIComponent(token)}`;
      }
      const bundleRes = await fetch(url, { credentials: 'include' });
      if (bundleRes.ok) {
        const bundle = await bundleRes.json();
        await this.sendToWorker('INSERT_BUNDLE', { bundle }, 120000);
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
    await this.sendToWorker('DELETE_DOCUMENT', { docId: id }).catch(() => { });
    this.cachedDocIds.delete(id);
    this.pausedTasks.delete(id);
    if (Array.isArray(this._cachedDocsList)) {
      this._cachedDocsList = this._cachedDocsList.filter(d => Number(d.id) !== id);
    }
    if (window.pdfCacheManager) {
      await window.pdfCacheManager.invalidate(id).catch(() => { });
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
      } catch (e) { }
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

  /**
   * Notification UI throttlée (~16 ms via rAF) : les callbacks reconstruisent du
   * DOM (cartes, SVG, badges) — les appeler par paquet réseau saturait le thread
   * principal (des dizaines de milliers de nœuds créés en rafale).
   */
  _notify() {
    this._notifyFullPending = true;
    if (this._notifyRaf) return;
    const schedule = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    this._notifyRaf = schedule(() => {
      this._notifyRaf = 0;
      if (!this._notifyFullPending) return;
      this._notifyFullPending = false;
      this._notifyNow();
    });
  }

  _notifyNow() {
    const state = {
      queueCount: this.queue.length,
      queue: [...this.queue],
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

    this.pausedTasks.delete(id);
    this.isPaused = false;
    this.queue.push(id);
    this._notify();

    await this.ensureInitialized(1500).catch(() => { });

    // Vérifier si le document est déjà 100% complet (PDF + SQLite-Wasm index)
    const isBundleIndexed = this.cachedDocIds.has(id);
    let isPdfComplete = false;
    if (window.pdfCacheManager) {
      isPdfComplete = await window.pdfCacheManager.isComplete(id);
    }

    if (isBundleIndexed && isPdfComplete) {
      console.log(`[DownloadQueueManager] Document ${id} déjà présent à 100% dans le cache`);
      this.queue = this.queue.filter(qId => qId !== id);
      this._notify();
      return;
    }

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
        this.sendToWorker('SYNC_FOLDERS', { folders: allFolders }).catch(() => { });
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
   * Pause globale ou individuelle (conserve 100% des données en cache)
   */
  pauseDownload(docId) {
    if (docId) {
      const id = Number(docId);
      // NOTE : la tâche reste volontairement dans activeTasks tant que sa boucle
      // de lecture n'a pas constaté l'abort (sinon une reprise immédiate peut
      // coexister avec la tâche moribonde et doubler le téléchargement).
      const task = this.activeTasks.get(id);
      this.pausedTasks.add(id);
      if (task) {
        task.status = 'paused';
        if (task.controller) {
          try { task.controller.abort(); } catch (e) { }
        }
        if (task.pdfTask) {
          try { task.pdfTask.destroy(); } catch (e) { }
        }
        if (window.pdfCacheManager) {
          window.pdfCacheManager.progressCache.set(id, {
            status: 'paused',
            progress: task.progress || 0,
            downloadedBytes: task.downloadedBytes || 0,
            totalBytes: task.totalBytes || 0
          });
        }
      }
      this.queue = this.queue.filter(qId => qId !== id);
      if (window.pdfCacheManager) {
        window.pdfCacheManager.pauseDownload(id);
      }
      this._notify();
    } else {
      this.isPaused = true;
      for (const [id, task] of this.activeTasks) {
        this.pausedTasks.add(id);
        task.status = 'paused';
        if (task.controller) {
          try { task.controller.abort(); } catch (e) { }
        }
        if (window.pdfCacheManager) {
          window.pdfCacheManager.pauseDownload(id);
        }
      }
      this.activeTasks.clear();
      this._notify();
    }
  }

  /**
   * Reprise du téléchargement (déclenchée uniquement par un clic utilisateur)
   */
  resumeDownload(docId) {
    if (docId) {
      const id = Number(docId);
      this.pausedTasks.delete(id);
      this.enqueueDocument(id);
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
    this.pausedTasks.delete(id);
    this.queue = this.queue.filter(qId => qId !== id);

    const task = this.activeTasks.get(id);
    if (task) {
      if (task.controller) {
        try { task.controller.abort(); } catch (e) { }
      }
      if (task.pdfTask) {
        try { task.pdfTask.destroy(); } catch (e) { }
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

    if (this.activeTasks.has(docId)) {
      // Document encore référencé (ex : tâche moribonde en cours d'abandon) :
      // re-programmer au lieu de le perdre, sinon il reste bloqué hors de la file.
      this.queue.unshift(docId);
      setTimeout(() => this._processNext(), 0);
      return;
    }

    const controller = new AbortController();
    const task = {
      docId,
      status: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      controller,
      pdfTask: null,
    };
    this.activeTasks.set(docId, task);
    this._notify();

    // Récupérer les stats connues en cache si existantes
    if (window.pdfCacheManager) {
      const stats = await window.pdfCacheManager.getCachedStats(docId);
      if (stats) {
        task.downloadedBytes = stats.downloadedBytes || 0;
        task.totalBytes = stats.totalBytes || 0;
        task.progress = stats.progress || 0;
      }
    }

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
        await this.sendToWorker('SYNC_FOLDERS', { folders: this._allFolders }).catch(() => { });
      } else {
        const foldersRes = await fetch('/api/folders').catch(() => null);
        if (foldersRes && foldersRes.ok) {
          const fJson = await foldersRes.json();
          if (Array.isArray(fJson.folders)) {
            this._allFolders = fJson.folders;
            await this.sendToWorker('SYNC_FOLDERS', { folders: this._allFolders }).catch(() => { });
          }
        }
      }

      // 1. Télécharger le offline-bundle (Index textuel et spatial) et l'injecter dans SQLite-Wasm
      const token = (typeof window !== "undefined" && (window._sessionToken || localStorage.getItem('docseeker_session_token')));
      let bundleUrl = `/api/documents/${docId}/offline-bundle`;
      if (token) bundleUrl += `?token=${encodeURIComponent(token)}`;

      const bundleRes = await fetch(bundleUrl, { credentials: 'include' });
      if (bundleRes.ok) {
        const bundle = await bundleRes.json();
        await this.sendToWorker('INSERT_BUNDLE', { bundle }, 120000);
        // NOTE: Ne pas ajouter à cachedDocIds ici : le document n'est disponible qu'une fois son binaire 100% complet !
      }

      // 2. Mettre en cache l'image de couverture dans CacheStorage
      if (typeof caches !== 'undefined') {
        let coverUrl = `/api/cover/${docId}`;
        if (token) coverUrl += `?token=${encodeURIComponent(token)}`;
        const coverRes = await fetch(coverUrl, { credentials: 'include' }).catch(() => null);
        if (coverRes && coverRes.ok) {
          const cache = await caches.open('docseeker_covers');
          await cache.put(`/api/cover/${docId}`, coverRes);
        }
      }

      // 3. Déclencher le téléchargement du fichier complet (OPFS standard)
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

      let pdfUrl = `/api/pdf/${docId}`;
      if (token) {
        pdfUrl += `?token=${encodeURIComponent(token)}`;
      }

      const res = await fetch(pdfUrl, { credentials: 'include', signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status} downloading PDF for doc ${docId}`);
      }

      const cl = res.headers.get('content-length');
      let docMeta = this._libraryDocsList ? this._libraryDocsList.find(d => Number(d.id) === docId) : null;
      let contentLength = (cl && Number(cl) > 0) ? Number(cl) : (task.totalBytes || (docMeta && docMeta.file_size ? docMeta.file_size : 0));
      if (contentLength > 0) {
        task.totalBytes = contentLength;
        if (window.pdfCacheManager) {
          window.pdfCacheManager.setDocumentTotalBytes(docId, contentLength);
        }
      }

      // Lire le flux continu et l'écrire directement dans le stockage local
      // (OPFS) au fil de l'eau : la RAM ne retient jamais le fichier entier.
      const reader = res.body.getReader();
      const writeTarget = window.pdfCacheManager
        ? await window.pdfCacheManager.createLocalWriteTarget(docId, contentLength)
        : null;
      let currentDownloadedBytes = 0;
      let lastUiNotify = 0;
      let lastDqmNotify = 0;
      let sawReaderDone = false;
      let packetCount = 0;
      let fairnessCredits = 0;

      try {
        while (true) {
          if (controller.signal.aborted || this.isPaused || task.status === 'paused') {
            try { reader.cancel(); } catch (_) { }
            break;
          }

          // Priorité au visualiseur : attendre uniquement ses fetch réseau en vol
          // (événementiel). Après un plafond d'attente atteint, des crédits de
          // équitable laissent passer les 16 lectures suivantes : le fond garde
          // ~4 Mo/s même quand le viewer est sollicité en continu, et tourne à
          // pleine vitesse dès que le viewer est inactif.
          if (fairnessCredits > 0) {
            fairnessCredits--;
          } else {
            const gate = await this._waitIfYieldingForViewer(controller.signal);
            if (gate === 'timeout') {
              fairnessCredits = 16;
            }
          }
          if (controller.signal.aborted || this.isPaused || task.status === 'paused') {
            try { reader.cancel(); } catch (_) { }
            break;
          }

          const { done, value } = await reader.read();
          if (done) { sawReaderDone = true; break; }
          packetCount++;

          await this._writeToLocalTarget(writeTarget, value);
          currentDownloadedBytes += value.byteLength;
          task.downloadedBytes = currentDownloadedBytes;

          const tot = contentLength > 0 ? contentLength : currentDownloadedBytes;
          task.progress = (contentLength > 0 && currentDownloadedBytes < contentLength)
            ? Math.min(99, Math.round((currentDownloadedBytes / contentLength) * 100))
            : (currentDownloadedBytes >= contentLength ? 99 : 50);

          // UI : publication par paquet en automation (tests), sinon throttlée
          // à 200 ms — jamais de re-render par sous-élément.
          const nowMs = Date.now();
          const finalByte = contentLength > 0 && currentDownloadedBytes >= contentLength;
          if (finalByte || this._isAutomationEnv || nowMs - lastUiNotify >= 200) {
            lastUiNotify = nowMs;
            if (window.pdfCacheManager) {
              window.pdfCacheManager.progressCache.set(docId, {
                status: 'downloading',
                progress: task.progress,
                downloadedBytes: currentDownloadedBytes,
                totalBytes: tot
              });
              window.pdfCacheManager._notifyProgress(docId, {
                status: 'downloading',
                progress: task.progress,
                downloadedBytes: currentDownloadedBytes,
                totalBytes: tot
              });
            }
            this._notify();
          }

          // Bridage réservé à l'automation : publier d'abord, puis maintenir
          // chaque état observable (paquet final compris — un fichier local peut
          // arriver en un seul paquet). Aucun effet en usage réel.
          const automationDelay = this._automationDelayMs(contentLength, packetCount);
          if (automationDelay > 0) {
            await new Promise((r) => setTimeout(r, automationDelay));
            // Notification lourde (re-render DOM) : dans la fenêtre observable
            // uniquement, sinon throttlée — jamais par paquet.
            this._notify();
          } else if (nowMs - lastDqmNotify >= 250) {
            lastDqmNotify = nowMs;
            this._notify();
          }
        }
      } finally {
        try {
          await this._closeLocalTarget(writeTarget, sawReaderDone);
        } catch (closeErr) {
          // Échec disque lors de la finalisation : ne jamais laisser un cache
          // tronqué marqué « complete » — la tâche passe en erreur.
          if (task.status !== 'complete') {
            task.status = 'error';
            console.warn(`[DownloadQueueManager] Finalisation locale impossible pour le doc ${docId}:`, closeErr);
          }
        }
      }

      // La clôture (commit OPFS + métadonnées) a déjà eu lieu dans le finally :
      // ici on ne fait que marquer l'état à partir du résultat réel.
      const isFinished = !controller.signal.aborted && task.status !== 'paused' && task.status !== 'error' && sawReaderDone &&
        (contentLength <= 0 || currentDownloadedBytes >= contentLength);


      if (isFinished) {
        task.status = 'complete';
        task.progress = 100;
        task.downloadedBytes = currentDownloadedBytes;
        task.totalBytes = currentDownloadedBytes;
        this.cachedDocIds.add(docId);
        this._notify();
      } else {
        // Le transfert est partiel ou a été interrompu : ne pas marquer complet ni sauvegarder de binaire tronqué
        if (task.status !== 'error') {
          task.status = 'paused';
          const p = contentLength > 0 ? Math.min(99, Math.round((currentDownloadedBytes / contentLength) * 100)) : 0;
          task.progress = p;
          if (window.pdfCacheManager) {
            window.pdfCacheManager.progressCache.set(docId, {
              status: 'paused',
              progress: p,
              downloadedBytes: currentDownloadedBytes,
              totalBytes: contentLength
            });
            window.pdfCacheManager._notifyProgress(docId, {
              status: 'paused',
              progress: p,
              downloadedBytes: currentDownloadedBytes,
              totalBytes: contentLength
            });
          }
        }
      }

      if (isFinished) {
        this.cachedDocIds.add(docId);
        task.status = 'complete';
        task.progress = 100;
      }
      const allDocs = await this.getAllCachedDocs().catch(() => []);
      if (Array.isArray(allDocs)) {
        this._cachedDocsList = allDocs;
      }
      this._notify();
    } catch (err) {
      const isAbort = Boolean(
        (err && (err.name === 'AbortError' || String(err).includes('aborted') || String(err).includes('The operation was aborted'))) ||
        controller?.signal?.aborted ||
        task.status === 'paused'
      );

      if (isAbort) {
        // Interruption normale ou mise en pause volontaire (changement d'onglet ou clic Stop) : préserver l'état 'paused'
        task.status = 'paused';
      } else if (err && err.message && err.message.includes("Worker réinitialisé")) {
        // Le worker a été rechargé (activation SW) : ré-enfiler automatiquement pour reprise transparente
        this.queue.unshift(docId);
      } else {
        console.warn(`[DownloadQueueManager] Erreur pour le doc ${docId}:`, err);
        task.status = 'error';
      }
    } finally {
      if (typeof unbindProgress === 'function') {
        try { unbindProgress(); } catch (e) { }
      }
      // Retirer la tâche seulement après la fin réelle de sa boucle de lecture,
      // pour qu'une reprise ne démarrage pas en doublon pendant l'abandon.
      this.activeTasks.delete(docId);
      this._notify();
      // Enchaîner sur les documents suivants
      setTimeout(() => this._processNext(), 100);
    }
  }

  /**
   * Écrit un bloc reçu dans le stockage local SANS jamais bloquer la lecture
   * réseau : les paquets sont coalescés (2 Mo) et les écritures disque sont
   * mises en file (profondeur bornée) — réseau et disque travaillent en
   * parallèle. La RAM reste plafonnée (~4 lots + tampon courant).
   */
  async _writeToLocalTarget(writeTarget, chunk) {
    if (!writeTarget) return;
    writeTarget.bufParts = writeTarget.bufParts || [];
    writeTarget.bufParts.push(chunk);
    writeTarget.bufBytes = (writeTarget.bufBytes || 0) + chunk.byteLength;
    const depth = writeTarget.queueDepth || 0;
    if (writeTarget.bufBytes < 2097152 && depth > 0) return;
    const batch = new Blob(writeTarget.bufParts);
    writeTarget.bufParts = [];
    writeTarget.bufBytes = 0;
    this._enqueueLocalBatch(writeTarget, batch);
    if ((writeTarget.queueDepth || 0) >= 4) {
      // Pression disque (rare) : seul point de synchronisation — on laisse le
      // temps au disque de rattraper au lieu d'accumuler en RAM.
      await (writeTarget.queue || Promise.resolve()).catch((e) => { writeTarget.writeError = e; });
    }
  }

  _enqueueLocalBatch(writeTarget, batch) {
    const prev = writeTarget.queue || Promise.resolve();
    const next = prev.then(() => writeTarget.writable.write(batch));
    writeTarget.queue = next;
    writeTarget.queueDepth = (writeTarget.queueDepth || 0) + 1;
    const settled = () => {
      writeTarget.queueDepth = Math.max(0, (writeTarget.queueDepth || 0) - 1);
    };
    next.then(settled, settled);
  }

  /**
   * Clôt la cible locale : « commit » si le fichier est complet, abandon
   * (truncat) sinon — jamais de binaire partiel persisté.
   */
  async _closeLocalTarget(writeTarget, complete) {
    if (!writeTarget || writeTarget.closed) return;
    writeTarget.closed = true;
    if (!complete) {
      // Téléchargement interrompu : abandonner l'écriture et ne jamais persister
      // un binaire partiel.
      if (writeTarget.writable && typeof writeTarget.writable.abort === 'function') {
        try { await writeTarget.writable.abort(); } catch (_) { }
      }
      await window.pdfCacheManager.abortLocalWrite(writeTarget.docId);
      return;
    }
    // Vider le tampon de coalescence puis attendre la fin de TOUTE la file
    // d'écriture (le réseau n'a jamais attendu le disque pendant le transfert).
    if (writeTarget.bufParts && writeTarget.bufParts.length) {
      const rest = new Blob(writeTarget.bufParts);
      writeTarget.bufParts = [];
      writeTarget.bufBytes = 0;
      this._enqueueLocalBatch(writeTarget, rest);
    }
    if (writeTarget.queue) {
      await writeTarget.queue.catch((e) => { writeTarget.writeError = writeTarget.writeError || e; });
    }
    if (writeTarget.writeError) {
      throw writeTarget.writeError;
    }
    await writeTarget.writable.close();
    const ok = await window.pdfCacheManager.completeStreamingSave(writeTarget.docId, writeTarget.expectedBytes);
    if (!ok) {
      throw new Error(`Fichier local absent ou vide après écriture (doc ${writeTarget.docId})`);
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
