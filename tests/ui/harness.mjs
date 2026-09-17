/**
 * DocSeekerTestHarness - Page Object Model & Standardized Test Helper
 * 
 * Centralise les sélecteurs, actions et assertions pour Playwright.
 * Garantit la pérennité et la maintenabilité des tests en cas d'évolution UI.
 */
import { expect } from '@playwright/test';

export class DocSeekerTestHarness {
  constructor(page, context) {
    this.page = page;
    this.context = context;
    this.capturedErrors = [];
    this._setupErrorTracking();
  }

  _setupErrorTracking() {
    this.page.on('pageerror', (err) => {
      const msg = err.message || '';
      if (msg.includes('Worker was terminated') || msg.includes('Transport destroyed')) {
        return;
      }
      this.capturedErrors.push(`[PageError] ${msg}`);
    });
    this.page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('Worker was terminated') || text.includes('Transport destroyed')) {
        return;
      }
      if (
        text.includes('[CropWorker] Error') ||
        text.includes('NetworkError when attempting to fetch') ||
        text.includes('unhandledrejection') ||
        (msg.type() === 'error' && 
         !text.includes('favicon.ico') && 
         !text.includes('503 (PDF Offline Unavailable)') && 
         !text.includes('status of 503'))
      ) {
        this.capturedErrors.push(`[Console ${msg.type()}] ${text}`);
      }
    });
  }

  async authenticate() {
    const loginRes = await this.page.request.post('/api/auth/login', {
      data: { password: 'admin1234' }
    });
    expect(loginRes.ok()).toBeTruthy();

    await this.page.addInitScript(() => {
      localStorage.setItem('docseeker_session_valid_until', String(Date.now() + 30 * 24 * 3600 * 1000));
    });
  }

  async goto(path = '/') {
    await this.page.goto(path);
    await this.page.locator('#searchInput').waitFor({ state: 'visible', timeout: 10000 });
    await this.page.locator('#resultsContainer').waitFor({ state: 'visible', timeout: 10000 });

    // Réinitialiser les filtres et la recherche pour repartir d'un état propre
    const filter = this.page.locator('#filterOfflineOnly');
    if (await filter.isChecked()) {
      await filter.uncheck();
    }
    const clearBtn = this.page.locator('#clearSearchBtn');
    if (await clearBtn.isVisible()) {
      await clearBtn.click();
      await this.page.waitForTimeout(200);
    }
  }

  async setOffline(isOffline = true) {
    await this.context.setOffline(isOffline);
  }

  async setOfflineFilter(checked = true) {
    const filter = this.page.locator('#filterOfflineOnly');
    if (checked) {
      await filter.check();
    } else {
      await filter.uncheck();
    }
  }

  async search(query) {
    const input = this.page.locator('#searchInput');
    await input.fill(query);
    await this.page.evaluate((q) => window.performSearch && window.performSearch(q), query);
  }

  async clearSearch() {
    const clearBtn = this.page.locator('#clearSearchBtn');
    if (await clearBtn.isVisible()) {
      await clearBtn.click();
    } else {
      await this.page.keyboard.press('Escape');
    }
  }

  async getDocCard(docId) {
    const card = this.page.locator(`.doc-card[data-doc-id="${docId}"]`);
    await card.waitFor({ state: 'visible', timeout: 10000 });
    return card;
  }

  async isDocCardVisible(docId) {
    const card = this.page.locator(`.doc-card[data-doc-id="${docId}"]`);
    return await card.isVisible();
  }

  async openFolder(folderId) {
    const folder = this.page.locator(`.folder-card[data-folder-id="${folderId}"]`);
    await folder.waitFor({ state: 'visible', timeout: 10000 });
    await folder.click();
  }

  async navigateToBreadcrumbRoot() {
    const root = this.page.locator('#breadcrumbsNav .breadcrumb-item').first();
    await root.click();
  }

  async downloadDocToComplete(docId, timeoutMs = 25000) {
    const id = Number(docId);
    const isAlreadyDone = await this.page.evaluate(async (idNum) => {
      const isIndexed = window.downloadQueueManager?.isDocumentCached(idNum);
      const isComplete = window.pdfCacheManager ? await window.pdfCacheManager.isComplete(idNum) : false;
      return Boolean(isIndexed && isComplete);
    }, id);
    if (isAlreadyDone) return;

    await this.page.evaluate(async (idNum) => {
      if (window.downloadQueueManager) {
        await window.downloadQueueManager.enqueueDocument(idNum);
      }
    }, id);

    // Attendre que le document soit vérifié 100% complet
    await expect.poll(
      async () => {
        return await this.page.evaluate(async (idNum) => {
          const isIndexed = window.downloadQueueManager?.isDocumentCached(idNum);
          const isComplete = window.pdfCacheManager ? await window.pdfCacheManager.isComplete(idNum) : false;
          return Boolean(isIndexed && isComplete);
        }, id);
      },
      { timeout: timeoutMs, intervals: [200, 400, 800] }
    ).toBe(true);
  }

  async cleanDocCache(docId) {
    await this.page.evaluate(async (id) => {
      if (window.downloadQueueManager) await window.downloadQueueManager.removeDocumentFromCache(id);
      if (window.pdfCacheManager) await window.pdfCacheManager.invalidate(id);
    }, Number(docId));
    await this.page.waitForTimeout(100);
  }

  async injectPartialCache(docId, percent = 20) {
    await this.cleanDocCache(docId);
    await this.page.evaluate(async ({ id, pct }) => {
      if (window.downloadQueueManager) {
        await window.downloadQueueManager.ensureDocumentIndexedLocally(id);
      }
      if (window.pdfCacheManager) {
        const total = 2000000;
        const loaded = Math.round(total * (pct / 100));
        const db = await window.pdfCacheManager.init();
        if (db) {
          const normUrl = `/api/pdf/${id}`;
          const tx = db.transaction(['chunks', 'meta'], 'readwrite');
          const chunkStore = tx.objectStore('chunks');
          const metaStore = tx.objectStore('meta');

          const chunkSize = 256 * 1024;
          const chunkData = new Uint8Array(chunkSize);
          chunkStore.put(chunkData, `${normUrl}#0_${chunkSize}`);

          metaStore.put({
            url: normUrl,
            totalBytes: total,
            downloadedBytes: loaded,
            completed: false,
            updatedAt: Date.now()
          }, normUrl);

          await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
          window.pdfCacheManager.progressCache.set(id, {
            status: 'downloading',
            progress: pct,
            downloadedBytes: loaded,
            totalBytes: total
          });
        }
      }
    }, { id: Number(docId), pct: percent });
    await this.page.waitForTimeout(100);
  }

  async removeDocFromCache(docId) {
    const card = await this.getDocCard(docId);
    const deleteBtn = card.locator('.btn-delete-doc-cache');
    await deleteBtn.waitFor({ state: 'visible', timeout: 8000 });
    this.page.once('dialog', (dialog) => dialog.accept());
    await deleteBtn.click();
  }

  async assertVignettesVisible(docId, minCount = 1) {
    const card = await this.getDocCard(docId);
    const vignettes = card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 10000 });
    const count = await vignettes.count();
    expect(count).toBeGreaterThanOrEqual(minCount);
    return count;
  }

  async getPerformanceMetrics() {
    return await this.page.evaluate(() => {
      const perf = window.performance;
      const mem = perf && perf.memory ? {
        usedJSHeapSizeMB: Math.round((perf.memory.usedJSHeapSize / (1024 * 1024)) * 10) / 10,
        totalJSHeapSizeMB: Math.round((perf.memory.totalJSHeapSize / (1024 * 1024)) * 10) / 10,
        jsHeapSizeLimitMB: Math.round((perf.memory.jsHeapSizeLimit / (1024 * 1024)) * 10) / 10,
      } : null;
      const domNodeCount = document.getElementsByTagName('*').length;
      return { memory: mem, domNodeCount, timestamp: perf.now() };
    });
  }

  assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB = 120, maxDurationMs = 25000 } = {}) {
    const duration = endMetrics.timestamp - startMetrics.timestamp;
    expect(duration).toBeLessThanOrEqual(maxDurationMs);

    if (startMetrics.memory && endMetrics.memory) {
      const heapGrowthMB = endMetrics.memory.usedJSHeapSizeMB - startMetrics.memory.usedJSHeapSizeMB;
      console.log(`[ResourceGuard] Durée: ${Math.round(duration)}ms | Delta RAM: ${heapGrowthMB.toFixed(1)} MB (Avant: ${startMetrics.memory.usedJSHeapSizeMB} MB -> Après: ${endMetrics.memory.usedJSHeapSizeMB} MB) | DOM: ${startMetrics.domNodeCount} -> ${endMetrics.domNodeCount}`);
      expect(heapGrowthMB).toBeLessThanOrEqual(maxHeapGrowthMB);
    }
  }

  async assertStorageFreed(docId) {
    const id = Number(docId);
    const freedStatus = await this.page.evaluate(async (docIdNum) => {
      const normUrl = `/api/pdf/${docIdNum}`;
      let remainingChunks = 0;
      let metaExists = false;
      let coverExists = false;

      // 1. Inspecter IndexedDB (pdfCacheManager)
      if (window.pdfCacheManager) {
        const db = await window.pdfCacheManager.init();
        if (db) {
          // Vérifier meta
          metaExists = await new Promise((res) => {
            try {
              const tx = db.transaction('meta', 'readonly');
              const req = tx.objectStore('meta').get(normUrl);
              req.onsuccess = () => res(Boolean(req.result));
              req.onerror = () => res(false);
            } catch (e) {
              res(false);
            }
          });

          // Vérifier chunks résiduels
          remainingChunks = await new Promise((res) => {
            try {
              const tx = db.transaction('chunks', 'readonly');
              const store = tx.objectStore('chunks');
              const prefix = `${normUrl}#`;
              const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
              const req = store.count(range);
              req.onsuccess = () => res(req.result || 0);
              req.onerror = () => res(0);
            } catch (e) {
              res(0);
            }
          });
        }
      }

      // 2. Inspecter CacheStorage ('docseeker_covers')
      if (typeof caches !== 'undefined') {
        try {
          const coverCache = await caches.open('docseeker_covers');
          const coverMatch = await coverCache.match(`/api/crop/${docIdNum}/1?v=thumb`);
          coverExists = Boolean(coverMatch);
        } catch (e) {}
      }

      // 3. Inspecter SQLite OPFS via worker
      let indexedInSqlite = false;
      if (window.downloadQueueManager) {
        try {
          const cachedDocs = await window.downloadQueueManager.sendToWorker('GET_ALL_CACHED_DOCS', {});
          indexedInSqlite = Array.isArray(cachedDocs) && cachedDocs.some(d => Number(d.id) === docIdNum);
        } catch (e) {}
      }

      return {
        remainingChunks,
        metaExists,
        coverExists,
        indexedInSqlite
      };
    }, id);

    expect(freedStatus.remainingChunks).toBe(0);
    expect(freedStatus.metaExists).toBe(false);
    expect(freedStatus.indexedInSqlite).toBe(false);
    return freedStatus;
  }

  async spamClick(locator, count = 5, intervalMs = 25) {
    for (let i = 0; i < count; i++) {
      await locator.click({ force: true, noWaitAfter: true });
      if (intervalMs > 0 && i < count - 1) {
        await this.page.waitForTimeout(intervalMs);
      }
    }
  }

  async rapidSearchBurst(queries = ['car', 'gross', 'neph', 'inf'], intervalMs = 60) {
    const searchInput = this.page.locator('#searchInput');
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      await searchInput.fill(q);
      await this.page.evaluate((val) => window.performSearch && window.performSearch(val), q);
      if (intervalMs > 0 && i < queries.length - 1) {
        await this.page.waitForTimeout(intervalMs);
      }
    }
  }

  async rapidFolderSwitching(folderIds = [130, null, 130, null], intervalMs = 60) {
    for (let i = 0; i < folderIds.length; i++) {
      const fid = folderIds[i];
      if (fid !== null) {
        const card = this.page.locator(`.folder-card[data-folder-id="${fid}"]`);
        if (await card.isVisible()) {
          await card.click({ force: true, noWaitAfter: true });
        }
      } else {
        const rootBreadcrumb = this.page.locator('#breadcrumbsNav .breadcrumb-item').first();
        if (await rootBreadcrumb.isVisible()) {
          await rootBreadcrumb.click({ force: true, noWaitAfter: true });
        }
      }
      if (intervalMs > 0 && i < folderIds.length - 1) {
        await this.page.waitForTimeout(intervalMs);
      }
    }
  }

  assertZeroErrors() {
    expect(this.capturedErrors).toHaveLength(0);
  }

  getErrors() {
    return this.capturedErrors;
  }
}

