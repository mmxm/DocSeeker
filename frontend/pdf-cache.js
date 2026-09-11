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
   * Met à jour la progression reçue depuis le visualiseur PDF.js
   */
  updateProgressFromViewer(docId, loaded, total) {
    if (!docId || !total) return;
    const percent = Math.min(100, Math.round((loaded / total) * 100));
    const status = percent >= 100 ? "complete" : "downloading";
    this._notifyProgress(docId, {
      status,
      progress: percent,
      downloadedBytes: loaded,
      totalBytes: total
    });
    if (percent >= 100) {
      this.markComplete(docId, total);
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
    try {
      const db = await this.init();
      if (!db) return;
      const tx = db.transaction(DOCSEEKER_META_STORE, "readwrite");
      const store = tx.objectStore(DOCSEEKER_META_STORE);
      store.put({
        url: this.normalizeUrl(id),
        totalBytes,
        completed: true,
        updatedAt: Date.now()
      }, this.normalizeUrl(id));
    } catch (e) {}
  }

  /**
   * Vérifie si un document est 100% en cache
   */
  async isComplete(docId) {
    const id = Number(docId);
    const cached = this.progressCache.get(id);
    if (cached && cached.status === "complete") return true;

    try {
      const db = await this.init();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction(DOCSEEKER_META_STORE, "readonly");
        const store = tx.objectStore(DOCSEEKER_META_STORE);
        const req = store.get(this.normalizeUrl(id));
        req.onsuccess = () => {
          const res = req.result;
          resolve(!!(res && res.completed));
        };
        req.onerror = () => resolve(false);
      });
    } catch (e) {
      return false;
    }
  }

  /**
   * Récupère la progression connue d'un document
   */
  async getProgress(docId) {
    const id = Number(docId);
    if (this.progressCache.has(id)) {
      return this.progressCache.get(id);
    }
    const complete = await this.isComplete(id);
    if (complete) {
      return { status: "complete", progress: 100, downloadedBytes: 0, totalBytes: 0 };
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
