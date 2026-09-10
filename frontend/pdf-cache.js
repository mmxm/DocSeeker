/**
 * DocSeeker - PdfCacheManager (IndexedDB Resumable Cache)
 * 
 * Gestionnaire de téléchargement résumable et de mise en cache locale des PDF.
 * - Stocke les fragments binaires par blocs de 2 Mo dans IndexedDB.
 * - En cas de fermeture prématurée, reprend le téléchargement à l'octet exact où il s'est arrêté (Range: bytes=X-).
 * - Une fois le téléchargement terminé (100%), assemble un Blob complet pour ouverture instantanée (0 ms).
 * - Vérifie la validité du cache via l'ETag du serveur pour détecter toute modification du fichier.
 */

class PdfCacheManager {
  constructor() {
    this.dbName = "docseeker_pdf_cache_v1";
    this.dbVersion = 1;
    this.db = null;
    this.chunkSize = 2 * 1024 * 1024; // 2 Mo par fragment
    this.activeDownloads = new Map(); // docId -> AbortController
    this.progressListeners = new Map(); // docId -> Set of callbacks
    this._initPromise = null;
  }

  async init() {
    if (this.db) return this.db;
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.dbVersion);

      req.onupgradeneeded = (evt) => {
        const db = evt.target.result;
        // 1. Magasin des métadonnées
        if (!db.objectStoreNames.contains("metadata")) {
          db.createObjectStore("metadata", { keyPath: "docId" });
        }
        // 2. Magasin des fragments temporaires en cours de téléchargement
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks", { keyPath: ["docId", "chunkIndex"] });
        }
        // 3. Magasin des Blobs complets (fichiers terminés à 100%)
        if (!db.objectStoreNames.contains("blobs")) {
          db.createObjectStore("blobs", { keyPath: "docId" });
        }
      };

      req.onsuccess = (evt) => {
        this.db = evt.target.result;
        resolve(this.db);
      };

      req.onerror = (evt) => {
        console.error("[PdfCacheManager] Erreur ouverture IndexedDB:", evt.target.error);
        reject(evt.target.error);
      };
    });

    return this._initPromise;
  }

  /**
   * Récupère les métadonnées d'un document en cache
   */
  async getMetadata(docId) {
    await this.init();
    return new Promise((resolve) => {
      const tx = this.db.transaction("metadata", "readonly");
      const store = tx.objectStore("metadata");
      const req = store.get(Number(docId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  /**
   * Sauvegarde ou met à jour les métadonnées
   */
  async saveMetadata(meta) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("metadata", "readwrite");
      const store = tx.objectStore("metadata");
      const req = store.put(meta);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Vérifie si un PDF est déjà disponible à 100% en cache
   */
  async isComplete(docId) {
    const meta = await this.getMetadata(docId);
    return Boolean(meta && meta.isComplete);
  }

  /**
   * Récupère le Blob complet du PDF s'il est à 100% en cache
   */
  async getBlob(docId) {
    await this.init();
    return new Promise((resolve) => {
      const tx = this.db.transaction("blobs", "readonly");
      const store = tx.objectStore("blobs");
      const req = store.get(Number(docId));
      req.onsuccess = () => {
        if (req.result && req.result.blob) {
          resolve(req.result.blob);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  }

  /**
   * Récupère une URL Blob locale utilisable directement dans PDF.js
   */
  async getBlobUrl(docId) {
    const blob = await this.getBlob(docId);
    if (!blob) return null;
    return URL.createObjectURL(blob);
  }

  /**
   * Sauvegarde un chunk binaire dans IndexedDB
   */
  async saveChunk(docId, chunkIndex, uint8Data) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("chunks", "readwrite");
      const store = tx.objectStore("chunks");
      const req = store.put({
        docId: Number(docId),
        chunkIndex: Number(chunkIndex),
        data: uint8Data,
        size: uint8Data.byteLength
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Récupère tous les chunks ordonnés d'un document pour reconstituer le Blob final
   */
  async getAllChunks(docId) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("chunks", "readonly");
      const store = tx.objectStore("chunks");
      const req = store.getAll();
      req.onsuccess = () => {
        const docChunks = (req.result || [])
          .filter(c => c.docId === Number(docId))
          .sort((a, b) => a.chunkIndex - b.chunkIndex)
          .map(c => c.data);
        resolve(docChunks);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Nettoie les chunks temporaires une fois le Blob assemblé
   */
  async deleteChunks(docId) {
    await this.init();
    return new Promise((resolve) => {
      const tx = this.db.transaction("chunks", "readwrite");
      const store = tx.objectStore("chunks");
      const req = store.openCursor();
      req.onsuccess = (evt) => {
        const cursor = evt.target.result;
        if (cursor) {
          if (cursor.value.docId === Number(docId)) {
            cursor.delete();
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => resolve();
    });
  }

  /**
   * Enregistre le Blob complet dans le magasin blobs et finalise les métadonnées
   */
  async finalizeBlob(docId, blob, etag, totalBytes) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["blobs", "metadata"], "readwrite");
      
      const blobsStore = tx.objectStore("blobs");
      blobsStore.put({
        docId: Number(docId),
        blob: blob,
        etag: etag,
        size: blob.size,
        cachedAt: Date.now()
      });

      const metaStore = tx.objectStore("metadata");
      metaStore.put({
        docId: Number(docId),
        etag: etag,
        totalBytes: totalBytes,
        downloadedBytes: totalBytes,
        isComplete: true,
        updatedAt: Date.now()
      });

      tx.oncomplete = async () => {
        // Supprimer les chunks intermédiaires pour libérer l'espace
        await this.deleteChunks(docId);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Invalide/supprime le cache d'un document (ex: après modification d'annotations)
   */
  async invalidate(docId) {
    await this.init();
    this.pauseDownload(docId);
    return new Promise((resolve) => {
      const tx = this.db.transaction(["metadata", "chunks", "blobs"], "readwrite");
      tx.objectStore("metadata").delete(Number(docId));
      tx.objectStore("blobs").delete(Number(docId));
      
      // Suppression des chunks
      const chunksStore = tx.objectStore("chunks");
      const req = chunksStore.openCursor();
      req.onsuccess = (evt) => {
        const cursor = evt.target.result;
        if (cursor) {
          if (cursor.value.docId === Number(docId)) {
            cursor.delete();
          }
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        this._notifyProgress(docId, { status: "invalidated", progress: 0 });
        resolve();
      };
      tx.onerror = () => resolve();
    });
  }

  /**
   * Invalide l'ensemble du cache IndexedDB
   */
  async clearAll() {
    await this.init();
    for (const [docId] of this.activeDownloads) {
      this.pauseDownload(docId);
    }
    return new Promise((resolve) => {
      const tx = this.db.transaction(["metadata", "chunks", "blobs"], "readwrite");
      tx.objectStore("metadata").clear();
      tx.objectStore("chunks").clear();
      tx.objectStore("blobs").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  /**
   * S'abonne aux événements de progression de téléchargement pour un document
   */
  onProgress(docId, callback) {
    const id = Number(docId);
    if (!this.progressListeners.has(id)) {
      this.progressListeners.set(id, new Set());
    }
    this.progressListeners.get(id).add(callback);
    return () => {
      const listeners = this.progressListeners.get(id);
      if (listeners) listeners.delete(callback);
    };
  }

  _notifyProgress(docId, info) {
    const listeners = this.progressListeners.get(Number(docId));
    if (listeners) {
      listeners.forEach(cb => {
        try { cb(info); } catch (e) { console.error(e); }
      });
    }
  }

  /**
   * Interrompt proprement un téléchargement en cours
   */
  pauseDownload(docId) {
    const id = Number(docId);
    if (this.activeDownloads.has(id)) {
      const controller = this.activeDownloads.get(id);
      controller.abort();
      this.activeDownloads.delete(id);
      this._notifyProgress(docId, { status: "paused" });
    }
  }

  /**
   * Démarre ou reprend le téléchargement d'un document en tâche de fond.
   * Utilise des requêtes par plages (Range) et enregistre les blocs dans IndexedDB.
   */
  async startDownload(docId, onProgressCb = null) {
    const id = Number(docId);
    if (onProgressCb) {
      this.onProgress(id, onProgressCb);
    }

    // Déjà en cours de téléchargement ?
    if (this.activeDownloads.has(id)) {
      return;
    }

    // Déjà terminé à 100% ?
    const isDone = await this.isComplete(id);
    if (isDone) {
      const meta = await this.getMetadata(id);
      this._notifyProgress(id, {
        status: "complete",
        progress: 100,
        downloadedBytes: meta?.totalBytes || 0,
        totalBytes: meta?.totalBytes || 0
      });
      return;
    }

    await this.init();
    let meta = await this.getMetadata(id);

    // Initialiser les métadonnées si première fois
    if (!meta) {
      meta = {
        docId: id,
        etag: null,
        totalBytes: 0,
        downloadedBytes: 0,
        isComplete: false,
        chunkCount: 0,
        updatedAt: Date.now()
      };
      await this.saveMetadata(meta);
    }

    const abortController = new AbortController();
    this.activeDownloads.set(id, abortController);

    try {
      const url = `/api/pdf/${id}`;
      const headers = {};

      // Si nous avons déjà téléchargé une partie, demander uniquement la suite !
      if (meta.downloadedBytes > 0) {
        headers["Range"] = `bytes=${meta.downloadedBytes}-`;
        if (meta.etag) {
          headers["If-Range"] = meta.etag;
        }
      }

      this._notifyProgress(id, {
        status: "downloading",
        progress: meta.totalBytes > 0 ? Math.round((meta.downloadedBytes / meta.totalBytes) * 100) : 0,
        downloadedBytes: meta.downloadedBytes,
        totalBytes: meta.totalBytes
      });

      const response = await fetch(url, {
        headers: headers,
        signal: abortController.signal
      });

      // Si le serveur répond 416 (Range invalide ou fin atteinte)
      if (response.status === 416) {
        console.warn(`[PdfCacheManager] Status 416 pour doc ${id}, vérification intégrité...`);
        const allChunks = await this.getAllChunks(id);
        if (allChunks.length > 0) {
          const fullBlob = new Blob(allChunks, { type: "application/pdf" });
          await this.finalizeBlob(id, fullBlob, meta.etag || "", fullBlob.size);
          this._notifyProgress(id, { status: "complete", progress: 100 });
        } else {
          await this.invalidate(id);
        }
        this.activeDownloads.delete(id);
        return;
      }

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status} lors de la requête PDF`);
      }

      const serverEtag = response.headers.get("ETag") || `doc-${id}`;
      
      // Si l'ETag a changé par rapport aux chunks précédents, le document a changé : on réinitialise
      if (meta.etag && meta.etag !== serverEtag && response.status !== 206) {
        console.log(`[PdfCacheManager] Le fichier sur le serveur a changé pour doc ${id}. Réinitialisation du cache.`);
        await this.deleteChunks(id);
        meta.downloadedBytes = 0;
        meta.chunkCount = 0;
      }
      meta.etag = serverEtag;

      // Calcul de la taille totale
      let totalBytes = meta.totalBytes;
      const contentRange = response.headers.get("Content-Range");
      if (contentRange) {
        // Ex: "bytes 4194304-10485759/10485760"
        const match = contentRange.match(/\/(\d+)$/);
        if (match) {
          totalBytes = parseInt(match[1], 10);
          meta.totalBytes = totalBytes;
        }
      } else {
        const clen = response.headers.get("Content-Length");
        if (clen) {
          totalBytes = parseInt(clen, 10);
          meta.totalBytes = totalBytes;
        }
      }

      const reader = response.body.getReader();
      let buffer = [];
      let bufferSize = 0;
      let downloadedSoFar = meta.downloadedBytes;
      let chunkIndex = meta.chunkCount || 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Flush du buffer résiduel si non vide
          if (bufferSize > 0) {
            const finalChunk = this._mergeBuffers(buffer, bufferSize);
            await this.saveChunk(id, chunkIndex, finalChunk);
            chunkIndex++;
            downloadedSoFar += bufferSize;
          }

          meta.downloadedBytes = downloadedSoFar;
          meta.chunkCount = chunkIndex;
          meta.updatedAt = Date.now();

          // Assemblage final du Blob
          const allChunks = await this.getAllChunks(id);
          const fullBlob = new Blob(allChunks, { type: "application/pdf" });
          
          await this.finalizeBlob(id, fullBlob, serverEtag, fullBlob.size);
          
          this._notifyProgress(id, {
            status: "complete",
            progress: 100,
            downloadedBytes: fullBlob.size,
            totalBytes: fullBlob.size
          });
          break;
        }

        buffer.push(value);
        bufferSize += value.byteLength;

        // Dès que le buffer atteint la taille d'un chunk (2 Mo), on persiste dans IndexedDB
        if (bufferSize >= this.chunkSize) {
          const chunkData = this._mergeBuffers(buffer, bufferSize);
          await this.saveChunk(id, chunkIndex, chunkData);
          
          downloadedSoFar += bufferSize;
          chunkIndex++;
          buffer = [];
          bufferSize = 0;

          meta.downloadedBytes = downloadedSoFar;
          meta.chunkCount = chunkIndex;
          meta.updatedAt = Date.now();
          await this.saveMetadata(meta);

          const pct = totalBytes > 0 ? Math.min(99, Math.round((downloadedSoFar / totalBytes) * 100)) : 0;
          this._notifyProgress(id, {
            status: "downloading",
            progress: pct,
            downloadedBytes: downloadedSoFar,
            totalBytes: totalBytes
          });
        }
      }

    } catch (err) {
      if (err.name === "AbortError") {
        console.log(`[PdfCacheManager] Téléchargement mis en pause pour doc ${id}`);
        this._notifyProgress(id, { status: "paused" });
      } else {
        console.warn(`[PdfCacheManager] Erreur pendant téléchargement doc ${id}:`, err);
        this._notifyProgress(id, { status: "error", error: err.message });
      }
    } finally {
      this.activeDownloads.delete(id);
    }
  }

  _mergeBuffers(chunks, totalLength) {
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

// Instance globale disponible pour l'application DocSeeker
window.pdfCacheManager = new PdfCacheManager();
