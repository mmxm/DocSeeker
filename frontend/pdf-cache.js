/**
 * DocSeeker - PdfCacheManager (Unified IndexedDB Chunk Cache)
 * 
 * Gestionnaire unifié du cache de fragments PDF dans IndexedDB :
 * - Fonctionne de concert avec PDF.js (PDFFetchStreamRangeReader) via la base 'docseeker_pdf_chunks_v2'.
 * - Chaque fragment de 256 Ko téléchargé par PDF.js est persisté sur le disque.
 * - À la réouverture, PDF.js lit instantanément les fragments existants depuis IndexedDB (0 ms).
 * - En cas de fermeture prématurée, la reprise se fait automatiquement au pourcentage atteint.
 * - Supprime toute boucle de téléchargement concurrente : PDF.js est l'unique moteur de transfert.
 */

const DOCSEEKER_CHUNK_DB_NAME = "docseeker_pdf_chunks_v2";
const DOCSEEKER_CHUNK_STORE = "chunks";
const DOCSEEKER_META_STORE = "meta";

class PdfCacheManager {
  constructor() {
    this.dbName = DOCSEEKER_CHUNK_DB_NAME;
    this.dbVersion = 1;
    this.db = null;
    this._initPromise = null;
    this.progressListeners = new Map(); // docId -> Set of callbacks
    this.progressCache = new Map(); // docId -> { status, progress, downloadedBytes, totalBytes }
  }

  async init() {
    if (this.db) return this.db;
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        return resolve(null);
      }
      const req = indexedDB.open(this.dbName, this.dbVersion);

      req.onupgradeneeded = (evt) => {
        const db = evt.target.result;
        if (!db.objectStoreNames.contains(DOCSEEKER_CHUNK_STORE)) {
          db.createObjectStore(DOCSEEKER_CHUNK_STORE);
        }
        if (!db.objectStoreNames.contains(DOCSEEKER_META_STORE)) {
          db.createObjectStore(DOCSEEKER_META_STORE);
        }
      };

      req.onsuccess = (evt) => {
        this.db = evt.target.result;
        resolve(this.db);
      };

      req.onerror = (evt) => {
        console.error("[PdfCacheManager] Erreur ouverture IndexedDB:", evt.target.error);
        resolve(null);
      };
    });

    return this._initPromise;
  }

  normalizeUrl(docId) {
    return `/api/pdf/${Number(docId)}`;
  }

  /**
   * Enregistre un écouteur de progression
   */
  onProgress(docId, callback) {
    const id = Number(docId);
    if (!this.progressListeners.has(id)) {
      this.progressListeners.set(id, new Set());
    }
    this.progressListeners.get(id).add(callback);

    if (this.progressCache.has(id)) {
      try {
        callback(this.progressCache.get(id));
      } catch (e) {}
    }
  }

  /**
   * Notifie les écouteurs de progression
   */
  _notifyProgress(docId, data) {
    const id = Number(docId);
    const prev = this.progressCache.get(id) || {};
    const updated = { ...prev, ...data };
    this.progressCache.set(id, updated);

    const listeners = this.progressListeners.get(id);
    if (listeners) {
      for (const cb of listeners) {
        try {
          cb(updated);
        } catch (e) {
          console.error("[PdfCacheManager] Erreur listener:", e);
        }
      }
    }
  }

  /**
   * Sauvegarde les métadonnées d'avancement d'un document dans IndexedDB
   */
  async saveMeta(docId, data) {
    try {
      const id = Number(docId);
      const db = await this.init();
      if (!db) return;
      const normUrl = this.normalizeUrl(id);
      const tx = db.transaction(DOCSEEKER_META_STORE, "readwrite");
      const store = tx.objectStore(DOCSEEKER_META_STORE);
      const prevReq = store.get(normUrl);
      prevReq.onsuccess = () => {
        const prev = prevReq.result || {};
        store.put({
          url: normUrl,
          totalBytes: data.totalBytes || prev.totalBytes || 0,
          downloadedBytes: data.downloadedBytes || prev.downloadedBytes || 0,
          completed: Boolean(data.completed ?? prev.completed),
          updatedAt: Date.now()
        }, normUrl);
      };
    } catch (e) {}
  }

  /**
   * Scanne instantanément les fragments existants dans IndexedDB pour ce document (0-2 ms)
   */
  async getCachedStats(docId) {
    const id = Number(docId);
    const normUrl = this.normalizeUrl(id);
    const prefix = `${normUrl}#`;

    try {
      const db = await this.init();
      if (!db) return null;

      // 1. Lire les métadonnées rapides
      const meta = await new Promise((resolve) => {
        try {
          const tx = db.transaction(DOCSEEKER_META_STORE, "readonly");
          const req = tx.objectStore(DOCSEEKER_META_STORE).get(normUrl);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });

      // 2. Scan ultra-rapide des clés de fragments réels (0-2 ms, sans lire les gros binaires)
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(DOCSEEKER_CHUNK_STORE, "readonly");
          const store = tx.objectStore(DOCSEEKER_CHUNK_STORE);
          const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
          const req = store.openKeyCursor(range);
          let downloadedBytes = 0;

          req.onsuccess = (evt) => {
            const cursor = evt.target.result;
            if (cursor) {
              const key = String(cursor.key);
              const parts = key.slice(prefix.length).split("_");
              if (parts.length === 2) {
                const b = parseInt(parts[0], 10);
                const e = parseInt(parts[1], 10);
                if (e > b) downloadedBytes += (e - b);
              }
              cursor.continue();
            } else {
              const totalBytes = meta?.totalBytes || 0;
              // Vérification stricte : le document n'est "complete" que si la somme des fragments réels couvre la totalité
              const isTrulyComplete = totalBytes > 0 && downloadedBytes >= totalBytes;
              const progress = totalBytes > 0 
                ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
                : (isTrulyComplete ? 100 : 0);
              const status = isTrulyComplete ? "complete" : (downloadedBytes > 0 ? "downloading" : "none");

              // Auto-réparation si meta.completed était incohérent avec les fragments réels
              if (meta && meta.completed !== isTrulyComplete && totalBytes > 0) {
                this.saveMeta(id, { totalBytes, downloadedBytes, completed: isTrulyComplete });
              }

              resolve({
                status,
                progress,
                downloadedBytes,
                totalBytes
              });
            }
          };
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * Met à jour la progression reçue depuis le visualiseur PDF.js
   */
  updateProgressFromViewer(docId, loaded, total) {
    if (!docId || !total) return;
    const id = Number(docId);
    const prev = this.progressCache.get(id) || {};

    // Si le document est déjà vérifié comme 100% complet avec tous ses fragments,
    // on interdit formellement de le rétrograder en mode "téléchargement" lors du parcours local
    if (prev.status === "complete" && prev.progress >= 100) {
      return;
    }

    const bestLoaded = Math.max(prev.downloadedBytes || 0, loaded);
    const percent = Math.min(100, Math.round((bestLoaded / total) * 100));
    const status = percent >= 100 ? "complete" : "downloading";

    this._notifyProgress(id, {
      status,
      progress: percent,
      downloadedBytes: bestLoaded,
      totalBytes: total
    });

    if (percent >= 100) {
      this.markComplete(id, total);
    } else {
      this.saveMeta(id, { totalBytes: total, downloadedBytes: bestLoaded, completed: false });
    }
  }

  /**
   * Marque un document comme 100% complet
   */
  async markComplete(docId, totalBytes) {
    const id = Number(docId);
    this._notifyProgress(id, {
      status: "complete",
      progress: 100,
      downloadedBytes: totalBytes,
      totalBytes
    });
    await this.saveMeta(id, { totalBytes, downloadedBytes: totalBytes, completed: true });
  }

  /**
   * Vérifie si un document est 100% en cache (validé par la somme réelle des fragments stockés)
   */
  async isComplete(docId) {
    const id = Number(docId);
    const cached = this.progressCache.get(id);
    if (cached && cached.status === "complete" && cached.progress >= 100) return true;

    const stats = await this.getCachedStats(id);
    if (stats && stats.status === "complete" && stats.progress >= 100) {
      this.progressCache.set(id, stats);
      return true;
    }
    return false;
  }

  /**
   * Récupère la progression connue d'un document (scanne IndexedDB si nécessaire)
   */
  async getProgress(docId) {
    const id = Number(docId);
    if (this.progressCache.has(id)) {
      return this.progressCache.get(id);
    }

    const stats = await this.getCachedStats(id);
    if (stats && (stats.downloadedBytes > 0 || stats.status === "complete")) {
      this.progressCache.set(id, stats);
      return stats;
    }

    return { status: "none", progress: 0, downloadedBytes: 0, totalBytes: 0 };
  }

  /**
   * Compatibilité avec l'interface précédente (aucun téléchargement externe requis)
   */
  startDownload(docId) {
    // No-op : PDF.js est l'unique moteur de téléchargement et gère lui-même son flux
    return Promise.resolve();
  }

  pauseDownload(docId) {
    // No-op : géré par le cycle de vie de l'iframe PDF.js
  }

  async getBlobUrl(docId) {
    // PDF.js lit directement les fragments depuis IndexedDB
    return null;
  }

  /**
   * Invalide et supprime tous les fragments d'un document
   */
  async invalidate(docId) {
    const id = Number(docId);
    const normUrl = this.normalizeUrl(id);
    this.progressCache.delete(id);
    this._notifyProgress(id, { status: "none", progress: 0, downloadedBytes: 0, totalBytes: 0 });

    try {
      const db = await this.init();
      if (!db) return;

      // 1. Supprimer les métadonnées
      const metaTx = db.transaction(DOCSEEKER_META_STORE, "readwrite");
      metaTx.objectStore(DOCSEEKER_META_STORE).delete(normUrl);

      // 2. Parcourir et supprimer tous les fragments de ce document
      const chunkTx = db.transaction(DOCSEEKER_CHUNK_STORE, "readwrite");
      const store = chunkTx.objectStore(DOCSEEKER_CHUNK_STORE);
      const req = store.openKeyCursor();

      req.onsuccess = (evt) => {
        const cursor = evt.target.result;
        if (cursor) {
          const key = String(cursor.key);
          if (key.startsWith(`${normUrl}#`) || key.startsWith(`${id}#`)) {
            store.delete(cursor.key);
          }
          cursor.continue();
        }
      };
    } catch (e) {
      console.warn(`[PdfCacheManager] Erreur invalidation doc ${id}:`, e);
    }
  }

  /**
   * Supprime l'intégralité du cache local
   */
  async clearAll() {
    this.progressCache.clear();
    try {
      const db = await this.init();
      if (!db) return;
      const tx = db.transaction([DOCSEEKER_CHUNK_STORE, DOCSEEKER_META_STORE], "readwrite");
      tx.objectStore(DOCSEEKER_CHUNK_STORE).clear();
      tx.objectStore(DOCSEEKER_META_STORE).clear();
    } catch (e) {}
  }
}

// Instance globale unique
if (typeof window !== "undefined") {
  window.pdfCacheManager = new PdfCacheManager();
}
