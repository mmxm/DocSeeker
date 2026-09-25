/**
 * DocSeeker - LocalFilePdfCache (OPFS / CacheStorage)
 * 
 * Système de stockage local au format fichier PDF complet :
 * 1. Moteur principal : OPFS (Origin Private File System) sous 'docseeker_pdfs/doc_<id>.pdf'
 * 2. Fallback universel : CacheStorage sous 'docseeker_pdfs_v1'
 * 
 * Chaque document est un fichier binaire standard complet (zéro chunk, zéro OOM, zéro blocage à 99%).
 * La base IndexedDB obsolète (docseeker_pdf_chunks_v2) est automatiquement purgée.
 */

const OPFS_DIR_NAME = "docseeker_pdfs";
const CACHE_STORAGE_NAME = "docseeker_pdfs_v1";

class PdfCacheManager {
  constructor() {
    this.opfsDir = null;
    this.cacheStorage = null;
    this._initPromise = null;
    this.cachedIds = new Set();
    this.fileSizes = new Map(); // docId -> size in bytes
    this.progressListeners = new Map(); // docId -> Set of callbacks
    this.progressCache = new Map(); // docId -> { status, progress, downloadedBytes, totalBytes }
  }

  async init() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      // 1. Initialiser OPFS comme moteur exclusif prioritaire
      if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function") {
        try {
          const root = await navigator.storage.getDirectory();
          this.opfsDir = await root.getDirectoryHandle(OPFS_DIR_NAME, { create: true });
        } catch (e) {
          console.warn("[LocalFilePdfCache] OPFS non disponible, repli sur CacheStorage:", e);
          this.opfsDir = null;
        }
      }

      // 2. Si et seulement si OPFS n'est pas disponible, activer CacheStorage en secours
      if (!this.opfsDir && typeof caches !== "undefined") {
        try {
          this.cacheStorage = await caches.open(CACHE_STORAGE_NAME);
        } catch (e) {
          console.warn("[LocalFilePdfCache] CacheStorage non disponible:", e);
          this.cacheStorage = null;
        }
      }

      // 3. Purger l'ancienne base IndexedDB de micro-chunks (libère l'espace disque et la RAM)
      if (typeof indexedDB !== "undefined") {
        try {
          indexedDB.deleteDatabase("docseeker_pdf_chunks_v2");
        } catch (_) {}
      }

      // 4. Scanner les fichiers déjà présents
      await this._scanExistingFiles();

      return this;
    })();

    return this._initPromise;
  }

  async _scanExistingFiles() {
    this.cachedIds.clear();
    this.fileSizes.clear();

    // Scan OPFS
    if (this.opfsDir && typeof this.opfsDir.values === "function") {
      try {
        for await (const entry of this.opfsDir.values()) {
          if (entry.kind === "file") {
            const m = entry.name.match(/^doc_(\d+)\.pdf$/);
            if (m) {
              const id = Number(m[1]);
              try {
                const f = await entry.getFile();
                if (f.size > 0) {
                  this.cachedIds.add(id);
                  this.fileSizes.set(id, f.size);
                  this.progressCache.set(id, {
                    status: "complete",
                    progress: 100,
                    downloadedBytes: f.size,
                    totalBytes: f.size
                  });
                }
              } catch (_) {}
            }
          }
        }
      } catch (e) {
        console.warn("[LocalFilePdfCache] Erreur parcours OPFS:", e);
      }
    }

    // Scan CacheStorage
    if (this.cacheStorage) {
      try {
        const requests = await this.cacheStorage.keys();
        for (const req of requests) {
          const m = req.url.match(/doc_(\d+)\.pdf$/);
          if (m) {
            const id = Number(m[1]);
            if (!this.cachedIds.has(id)) {
              const res = await this.cacheStorage.match(req);
              if (res) {
                const blob = await res.blob();
                if (blob.size > 0) {
                  this.cachedIds.add(id);
                  this.fileSizes.set(id, blob.size);
                  this.progressCache.set(id, {
                    status: "complete",
                    progress: 100,
                    downloadedBytes: blob.size,
                    totalBytes: blob.size
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn("[LocalFilePdfCache] Erreur parcours CacheStorage:", e);
      }
    }
  }

  normalizeUrl(docId) {
    return `/api/pdf/${Number(docId)}`;
  }

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

    return () => {
      const set = this.progressListeners.get(id);
      if (set) set.delete(callback);
    };
  }

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
          console.error("[LocalFilePdfCache] Erreur listener:", e);
        }
      }
    }
  }

  /**
   * Vérifie si un document est 100% présent sous forme de fichier local complet
   */
  async isComplete(docId) {
    const id = Number(docId);
    if (!id) return false;

    // Cache mémoire ultra-rapide (0 ms)
    if (this.cachedIds.has(id)) return true;

    await this.init();

    // Vérifier dans OPFS
    if (this.opfsDir) {
      try {
        const fileHandle = await this.opfsDir.getFileHandle(`doc_${id}.pdf`);
        const file = await fileHandle.getFile();
        if (file.size > 0) {
          this.cachedIds.add(id);
          this.fileSizes.set(id, file.size);
          return true;
        }
      } catch (_) {}
    }

    // Vérifier dans CacheStorage
    if (this.cacheStorage) {
      try {
        const res = await this.cacheStorage.match(`/offline/doc_${id}.pdf`);
        if (res) {
          this.cachedIds.add(id);
          return true;
        }
      } catch (_) {}
    }

    return false;
  }

  /**
   * Renvoie les statistiques connues d'un document
   */
  async getCachedStats(docId) {
    const id = Number(docId);
    if (!id) return null;

    const isComplete = await this.isComplete(id);
    const size = this.fileSizes.get(id) || 0;

    if (isComplete) {
      return {
        status: "complete",
        progress: 100,
        downloadedBytes: size,
        totalBytes: size
      };
    }

    const cached = this.progressCache.get(id);
    if (cached) return cached;

    return {
      status: "none",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0
    };
  }

  async getProgress(docId) {
    const id = Number(docId);
    if (!id) return { status: "none", progress: 0, downloadedBytes: 0, totalBytes: 0 };
    return (await this.getCachedStats(id)) || { status: "none", progress: 0, downloadedBytes: 0, totalBytes: 0 };
  }

  /**
   * Retourne un Blob URL vers le fichier PDF local complet.
   * Direct, zéro allocation RAM redondante.
   */
  async getBlobUrl(docId) {
    const id = Number(docId);
    if (!id) return null;

    await this.init();

    // 1. Depuis OPFS
    if (this.opfsDir) {
      try {
        const fileHandle = await this.opfsDir.getFileHandle(`doc_${id}.pdf`);
        const file = await fileHandle.getFile();
        if (file.size > 0) {
          this.cachedIds.add(id);
          this.fileSizes.set(id, file.size);
          return URL.createObjectURL(file);
        }
      } catch (_) {}
    }

    // 2. Depuis CacheStorage
    if (this.cacheStorage) {
      try {
        const res = await this.cacheStorage.match(`/offline/doc_${id}.pdf`);
        if (res) {
          const blob = await res.blob();
          if (blob.size > 0) {
            this.cachedIds.add(id);
            this.fileSizes.set(id, blob.size);
            return URL.createObjectURL(blob);
          }
        }
      } catch (_) {}
    }

    return null;
  }

  /**
   * Ouvre une cible d'écriture directe (streaming) dans le stockage local.
   * OPFS (FileSystemWritableFileStream) en priorité ; repli CacheStorage en
   * streaming par blobs incrémentaux. Retourne null si rien n'est disponible.
   */
  async createLocalWriteTarget(docId, expectedBytes = 0) {
    const id = Number(docId);
    if (!id) return null;
    await this.init();
    if (this.opfsDir && typeof this.opfsDir.getFileHandle === "function") {
      try {
        const fileHandle = await this.opfsDir.getFileHandle(`doc_${id}.pdf`, { create: true });
        if (typeof fileHandle.createWritable === "function") {
          const writable = await fileHandle.createWritable();
          return { kind: "opfs", docId: id, writable, expectedBytes: Number(expectedBytes) || 0 };
        }
      } catch (e) {
        console.warn(`[LocalFilePdfCache] createWritable OPFS indisponible pour doc ${id}:`, e);
      }
    }
    if (this.cacheStorage) {
      try {
        const { writable, readable } = new TransformStream();
        const putPromise = this.cacheStorage.put(`/offline/doc_${id}.pdf`, new Response(readable, {
          headers: { "Content-Type": "application/pdf" }
        }));
        if (typeof putPromise?.catch === "function") putPromise.catch(() => { });
        return { kind: "cache", docId: id, writable, tail: null, expectedBytes: Number(expectedBytes) || 0 };
      } catch (e) {
        console.warn(`[LocalFilePdfCache] streaming CacheStorage indisponible pour doc ${id}:`, e);
      }
    }
    return null;
  }

  /**
   * Abandonne une écriture streaming (téléchargement interrompu) : jamais de
   * fichier partiel persisté dans le cache.
   */
  async abortLocalWrite(docId) {
    const id = Number(docId);
    if (!id) return;
    await this.init();
    if (this.opfsDir) {
      try { await this.opfsDir.removeEntry(`doc_${id}.pdf`); } catch (_) { }
    }
    if (this.cacheStorage) {
      try { await this.cacheStorage.delete(`/offline/doc_${id}.pdf`); } catch (_) { }
    }
  }

  /**
   * Finalise une écriture streaming : scanne le stockage local pour enregistrer
   * la présence et la taille du fichier (aucune copie du binaire en RAM).
   * Retourne true si le fichier complet est bien présent, false sinon.
   */
  async completeStreamingSave(docId, byteLength = 0) {
    const id = Number(docId);
    if (!id) return false;
    await this.init();
    let size = Number(byteLength) || 0;
    try {
      if (this.opfsDir) {
        const fh = await this.opfsDir.getFileHandle(`doc_${id}.pdf`, { create: false });
        const f = await fh.getFile();
        if (f.size <= 0) return false;
        size = f.size;
      } else if (this.cacheStorage) {
        const res = await this.cacheStorage.match(`/offline/doc_${id}.pdf`);
        if (!res) return false;
        const cl = Number(res.headers.get("Content-Length"));
        size = Number.isFinite(cl) && cl > 0 ? cl : size;
      }
    } catch (_) {
      return false;
    }
    if (size <= 0) return false;
    this.cachedIds.add(id);
    this.fileSizes.set(id, size);
    const payload = {
      status: "complete",
      progress: 100,
      downloadedBytes: size,
      totalBytes: size
    };
    this.progressCache.set(id, payload);
    this._notifyProgress(id, payload);
    if (typeof window !== "undefined" && window.downloadQueueManager) {
      window.downloadQueueManager.cachedDocIds.add(id);
      window.downloadQueueManager._notify();
    }
  }

  /**
   * Sauvegarde un document PDF complet (Uint8Array, ArrayBuffer ou Blob)
   * dans le système de fichiers local sous forme de fichier complet standard.
   */
  async saveFullDocument(docId, bufferOrBlob) {
    const id = Number(docId);
    if (!id || !bufferOrBlob) return;

    await this.init();

    let blob;
    let byteLength = 0;
    if (bufferOrBlob instanceof Blob) {
      blob = bufferOrBlob;
      byteLength = blob.size;
    } else if (bufferOrBlob instanceof Uint8Array || bufferOrBlob instanceof ArrayBuffer) {
      byteLength = bufferOrBlob.byteLength;
      blob = new Blob([bufferOrBlob], { type: "application/pdf" });
    } else {
      blob = new Blob([bufferOrBlob], { type: "application/pdf" });
      byteLength = blob.size;
    }

    if (byteLength <= 0) return;

    let saved = false;

    // 1. Sauvegarde dans OPFS
    if (this.opfsDir) {
      try {
        const fileHandle = await this.opfsDir.getFileHandle(`doc_${id}.pdf`, { create: true });
        if (typeof fileHandle.createWritable === "function") {
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          saved = true;
        }
      } catch (e) {
        console.warn(`[LocalFilePdfCache] Écriture OPFS impossible pour doc ${id}, fallback CacheStorage:`, e);
      }
    }

    // 2. Sauvegarde dans CacheStorage (si OPFS indisponible ou en sécurité)
    if (!saved && this.cacheStorage) {
      try {
        const response = new Response(blob, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(byteLength)
          }
        });
        await this.cacheStorage.put(`/offline/doc_${id}.pdf`, response);
        saved = true;
      } catch (e) {
        console.warn(`[LocalFilePdfCache] Écriture CacheStorage impossible pour doc ${id}:`, e);
      }
    }

    this.cachedIds.add(id);
    this.fileSizes.set(id, byteLength);

    const payload = {
      status: "complete",
      progress: 100,
      downloadedBytes: byteLength,
      totalBytes: byteLength
    };
    this.progressCache.set(id, payload);
    this._notifyProgress(id, payload);

    if (typeof window !== "undefined" && window.downloadQueueManager) {
      window.downloadQueueManager.cachedDocIds.add(id);
      window.downloadQueueManager._notify();
    }
  }

  /**
   * Supprime un document du système de fichier local
   */
  async invalidate(docId) {
    const id = Number(docId);
    if (!id) return;

    await this.init();

    this.cachedIds.delete(id);
    this.fileSizes.delete(id);
    this.progressCache.delete(id);

    // Supprimer d'OPFS
    if (this.opfsDir) {
      try {
        await this.opfsDir.removeEntry(`doc_${id}.pdf`);
      } catch (_) {}
    }

    // Supprimer de CacheStorage
    if (this.cacheStorage) {
      try {
        await this.cacheStorage.delete(`/offline/doc_${id}.pdf`);
      } catch (_) {}
    }

    this._notifyProgress(id, {
      status: "none",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0
    });

    if (typeof window !== "undefined" && window.downloadQueueManager) {
      window.downloadQueueManager.cachedDocIds.delete(id);
      if (Array.isArray(window.downloadQueueManager._cachedDocsList)) {
        window.downloadQueueManager._cachedDocsList = window.downloadQueueManager._cachedDocsList.filter(d => Number(d.id) !== id);
      }
      window.downloadQueueManager._notify();
    }
  }

  /**
   * Supprime l'intégralité des fichiers PDF en cache local
   */
  async clearAll() {
    await this.init();

    if (this.opfsDir && typeof this.opfsDir.keys === "function") {
      try {
        for await (const key of this.opfsDir.keys()) {
          try { await this.opfsDir.removeEntry(key); } catch (_) {}
        }
      } catch (_) {}
    }

    if (this.cacheStorage) {
      try {
        const keys = await this.cacheStorage.keys();
        for (const req of keys) {
          try { await this.cacheStorage.delete(req); } catch (_) {}
        }
      } catch (_) {}
    }

    this.cachedIds.clear();
    this.fileSizes.clear();
    this.progressCache.clear();
  }

  // Méthodes de compatibilité interface
  setDocumentTotalBytes(docId, totalBytes) {
    const id = Number(docId);
    if (!id || !totalBytes) return;
    const prev = this.progressCache.get(id) || {};
    this.progressCache.set(id, { ...prev, totalBytes });
  }

  markComplete(docId, totalBytes) {
    const id = Number(docId);
    if (!id) return;
    this.cachedIds.add(id);
    if (totalBytes) this.fileSizes.set(id, totalBytes);
    const payload = {
      status: "complete",
      progress: 100,
      downloadedBytes: totalBytes || 0,
      totalBytes: totalBytes || 0
    };
    this.progressCache.set(id, payload);
    this._notifyProgress(id, payload);
  }

  updateProgressFromViewer(docId, loaded, total) {
    // No-op : le badge n'affiche que la progression du téléchargement local OPFS
    // et n'est pas lié au flux de lecture dynamique de PDF.js
  }

  recordChunkDownloaded(docId, chunkSize, totalBytes) {
    // No-op : remplacé par le flux complet continu OPFS
  }

  saveMeta(docId, meta) {
    // Compatibilité
  }

  pauseDownload(docId) {
    const id = Number(docId);
    if (!id) return;
    const prev = this.progressCache.get(id);
    if (prev && prev.status !== "complete") {
      const updated = { ...prev, status: "paused" };
      this.progressCache.set(id, updated);
      this._notifyProgress(id, updated);
    }
  }

  cleanup(docId) {
    const id = Number(docId);
    if (!id) return;
    this.progressListeners.delete(id);
  }
}

// Instance globale unique
if (typeof window !== "undefined") {
  window.pdfCacheManager = new PdfCacheManager();
  window.pdfCacheManager.init().catch(err => {
    console.warn("[LocalFilePdfCache] Erreur initialisation globale:", err);
  });
}
