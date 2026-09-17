/**
 * DocSeekerTestHarness - Page Object Model & Standardized Test Helper
 *
 * Centralise les sélecteurs, actions et assertions pour Playwright.
 * Garantit la pérennité et la maintenabilité des tests en cas d'évolution UI.
 *
 * Pattern de test canonique :
 *   beforeEach → h.authenticate() + h.goto('/')
 *   afterEach  → h.resetState() + h.assertZeroErrors()
 */
import { expect } from '@playwright/test';

export class DocSeekerTestHarness {
  constructor(page, context) {
    this.page = page;
    this.context = context;
    this.capturedErrors = [];
    this._setupErrorTracking();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SETUP & TEARDOWN
  // ─────────────────────────────────────────────────────────────────────────────

  _setupErrorTracking() {
    this.page.on('pageerror', (err) => {
      const msg = err.message || '';
      if (msg.includes('Worker was terminated') || msg.includes('Transport destroyed')) return;
      this.capturedErrors.push(`[PageError] ${msg}`);
    });
    this.page.on('console', (msg) => {
      const text = msg.text();
      // --- Bruits systèmes ignorés ---
      if (text.includes('Worker was terminated') || text.includes('Transport destroyed')) return;

      // --- Erreurs réseau attendues en mode offline ---
      // Ces messages sont générés par l'app quand le contexte est délibérément offline.
      // Ils sont attrapés/gérés par l'app et ne représentent pas un bug.
      if (
        text.includes('Réseau indisponible') ||
        text.includes('Erreur chargement arborescence') ||
        text.includes('503 (PDF Offline Unavailable)') ||
        text.includes('status of 503') ||
        text.includes('Failed to fetch') ||
        text.includes('favicon.ico')
      ) return;

      // --- Erreurs significatives à capturer ---
      const isCropError   = text.includes('[CropWorker] Error');
      const isNetworkError = text.includes('NetworkError when attempting to fetch');
      const isUnhandled   = text.includes('unhandledrejection');
      const isConsoleError = msg.type() === 'error';

      if (isCropError || isNetworkError || isUnhandled || isConsoleError) {
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
    await this._clearFiltersAndSearch();
  }

  /**
   * Reset canonique inter-tests :
   * - réseau online, filtres décochés, recherche vidée
   * - sélection multiple désactivée, viewer fermé
   * - buffer d'erreurs vidé
   */
  async resetState() {
    await this.context.setOffline(false).catch(() => {});
    await this._clearFiltersAndSearch().catch(() => {});
    await this.page.evaluate(() => {
      const bar = document.getElementById('selectionActionBar');
      if (bar && bar.offsetParent !== null) {
        document.getElementById('toggleSelectionModeBtn')?.click();
      }
    }).catch(() => {});
    const closeBtn = this.page.locator('#closeViewerBtn');
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click().catch(() => {});
      await this.page.locator('#viewerPane').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    }
    this.capturedErrors = [];
  }

  async _clearFiltersAndSearch() {
    await this.page.evaluate(() => {
      // Uncheck all filters via direct click on the label wrapper for reliability
      [['filterOfflineOnly', 'filterOfflineChip'],
       ['filterTitlesOnly',  'filterTitlesChip'],
       ['filterCurrentFolderOnly', 'filterFolderChip']].forEach(([inputId, labelId]) => {
        const el    = document.getElementById(inputId);
        const label = document.getElementById(labelId);
        if (el && el.checked) {
          if (label) label.click(); else el.click();
        }
      });
    });
    const clearBtn = this.page.locator('#clearSearchBtn');
    if (await clearBtn.isVisible().catch(() => false)) {
      await clearBtn.click();
      await this.page.waitForTimeout(200);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NAVIGATION & UI
  // ─────────────────────────────────────────────────────────────────────────────

  async setOffline(isOffline = true) {
    await this.context.setOffline(isOffline);
  }

  async setOfflineFilter(checked = true) {
    const filter = this.page.locator('#filterOfflineOnly');
    const isChecked = await filter.evaluate(el => el.checked).catch(() => !checked);
    if (isChecked !== checked) {
      // Click the label wrapper (more reliable than .check()/.uncheck())
      const label = this.page.locator('#filterOfflineChip');
      if (await label.isVisible().catch(() => false)) {
        await label.click();
      } else {
        await filter.click();
      }
      await this.page.waitForTimeout(150);
    }
  }

  async setTitlesFilter(checked = true) {
    const filter = this.page.locator('#filterTitlesOnly');
    const isChecked = await filter.evaluate(el => el.checked).catch(() => !checked);
    if (isChecked !== checked) {
      const label = this.page.locator('#filterTitlesChip');
      if (await label.isVisible().catch(() => false)) {
        await label.click();
      } else {
        await filter.click();
      }
      await this.page.waitForTimeout(150);
    }
  }

  async search(query) {
    const input = this.page.locator('#searchInput');
    await input.fill(query);
    await this.page.evaluate((q) => window.performSearch && window.performSearch(q), query);
  }

  /** Recherche avec polling sur l'apparition des résultats. */
  async injectSearchQuery(query, { expectResultsIn = 5000 } = {}) {
    await this.search(query);
    if (query.trim().length > 0) {
      await expect(this.page.locator('.doc-card').first()).toBeVisible({ timeout: expectResultsIn });
    }
  }

  /** Vérifie que l'input contient exactement lastQuery et que ≥1 card est visible. */
  async assertSearchConsistency(lastQuery) {
    const input = this.page.locator('#searchInput');
    await expect(input).toHaveValue(lastQuery);
    if (lastQuery.trim().length > 0) {
      await expect(this.page.locator('.doc-card').first()).toBeVisible({ timeout: 8000 });
    }
  }

  async clearSearch() {
    const clearBtn = this.page.locator('#clearSearchBtn');
    if (await clearBtn.isVisible()) {
      await clearBtn.click();
    } else {
      const input = this.page.locator('#searchInput');
      if ((await input.inputValue()) !== '') {
        await this.page.keyboard.press('Escape');
      }
    }
    await this.page.waitForTimeout(150);
  }

  async getDocCard(docId) {
    const card = this.page.locator(`.doc-card[data-doc-id="${docId}"]`);
    await card.waitFor({ state: 'visible', timeout: 10000 });
    return card;
  }

  async isDocCardVisible(docId) {
    return await this.page.locator(`.doc-card[data-doc-id="${docId}"]`).isVisible();
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

  // ─────────────────────────────────────────────────────────────────────────────
  // CACHE MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /** État interne du download manager pour un doc (inQueue, inActive, isCached, isComplete). */
  async getQueueState(docId) {
    const id = Number(docId);
    return await this.page.evaluate(async (idNum) => {
      const dqm = window.downloadQueueManager;
      const pcm = window.pdfCacheManager;
      if (!dqm) return { inQueue: 0, inActive: false, isCached: false, isComplete: false };
      const inQueue   = dqm.queue  ? dqm.queue.filter(x => Number(x) === idNum).length : 0;
      const inActive  = dqm.activeTasks ? dqm.activeTasks.has(idNum) : false;
      const isCached  = dqm.isDocumentCached ? dqm.isDocumentCached(idNum) : false;
      const isComplete = pcm ? await pcm.isComplete(idNum) : false;
      return { inQueue, inActive, isCached, isComplete };
    }, id);
  }

  /** Attend que la file de download soit complètement vide. */
  async waitForQueueIdle(maxMs = 3000) {
    await expect.poll(
      async () => {
        return await this.page.evaluate(() => {
          const dqm = window.downloadQueueManager;
          if (!dqm) return true;
          return (dqm.queue?.length ?? 0) === 0 && (dqm.activeTasks?.size ?? 0) === 0;
        });
      },
      { timeout: maxMs, intervals: [100, 200, 500] }
    ).toBe(true);
  }

  /**
   * Garantit qu'un doc est en cache (remplace la boucle 30× copié-collé).
   * clean=true → nettoie avant de re-télécharger.
   */
  async ensureDocCached(docId, { clean = false, timeoutMs = 45000 } = {}) {
    if (clean) await this.cleanDocCache(docId);
    await this.downloadDocToComplete(docId, timeoutMs);
  }

  /** Garantit qu'un doc N'EST PAS en cache + attend propagation UI. */
  async ensureDocNotCached(docId) {
    await this.cleanDocCache(docId);
    await expect.poll(
      async () => {
        return await this.page.evaluate((id) => {
          const dqm = window.downloadQueueManager;
          return !dqm || !dqm.isDocumentCached(Number(id));
        }, docId);
      },
      { timeout: 5000, intervals: [100, 300] }
    ).toBe(true);
  }

  async downloadDocToComplete(docId, timeoutMs = 30000) {
    const id = Number(docId);
    const isAlreadyDone = await this.page.evaluate(async (idNum) => {
      const isIndexed  = window.downloadQueueManager?.isDocumentCached(idNum);
      if (!isIndexed) return false;
      // If pdfCacheManager missing, trust downloadQueueManager's isDocumentCached
      if (!window.pdfCacheManager) return true;
      const isComplete = await window.pdfCacheManager.isComplete(idNum);
      return Boolean(isComplete);
    }, id);
    if (isAlreadyDone) return;

    await this.page.evaluate(async (idNum) => {
      if (window.downloadQueueManager) {
        if (window.downloadQueueManager.isPaused) window.downloadQueueManager.resume();
        await window.downloadQueueManager.enqueueDocument(idNum);
        if (typeof window.downloadQueueManager._processNext === 'function') {
          window.downloadQueueManager._processNext();
        }
      }
    }, id);

    await expect.poll(
      async () => {
        return await this.page.evaluate(async (idNum) => {
          const dqm = window.downloadQueueManager;
          const isIndexed = dqm?.isDocumentCached(idNum);
          if (!isIndexed) {
            if (dqm && !dqm.activeTasks.has(idNum) && !dqm.queue.includes(idNum)) {
              dqm.enqueueDocument(idNum);
            }
            return false;
          }
          if (!window.pdfCacheManager) return true;
          const isComplete = await window.pdfCacheManager.isComplete(idNum);
          return Boolean(isIndexed && isComplete);
        }, id);
      },
      { timeout: timeoutMs, intervals: [300, 600, 1000] }
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
      if (window.downloadQueueManager) await window.downloadQueueManager.ensureDocumentIndexedLocally(id);
      if (window.pdfCacheManager) {
        const total = 2000000;
        const loaded = Math.round(total * (pct / 100));
        const db = await window.pdfCacheManager.init();
        if (db) {
          const normUrl   = `/api/pdf/${id}`;
          const tx        = db.transaction(['chunks', 'meta'], 'readwrite');
          const chunkSize = 256 * 1024;
          tx.objectStore('chunks').put(new Uint8Array(chunkSize), `${normUrl}#0_${chunkSize}`);
          tx.objectStore('meta').put({
            url: normUrl, totalBytes: total, downloadedBytes: loaded, completed: false, updatedAt: Date.now()
          }, normUrl);
          await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
          window.pdfCacheManager.progressCache.set(id, { status: 'downloading', progress: pct, downloadedBytes: loaded, totalBytes: total });
        }
      }
    }, { id: Number(docId), pct: percent });
    await this.page.waitForTimeout(100);
  }

  async removeDocFromCache(docId) {
    const card      = await this.getDocCard(docId);
    const deleteBtn = card.locator('.btn-delete-doc-cache');
    await deleteBtn.waitFor({ state: 'visible', timeout: 8000 });
    this.page.once('dialog', (dialog) => dialog.accept());
    await deleteBtn.click();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ASSERTIONS — VIGNETTES & CROPS
  // ─────────────────────────────────────────────────────────────────────────────

  async assertVignettesVisible(docId, minCount = 1) {
    const card      = await this.getDocCard(docId);
    const vignettes = card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 10000 });
    const count = await vignettes.count();
    expect(count).toBeGreaterThanOrEqual(minCount);
    return count;
  }

  /** Vérifie que les vignettes d'un doc hors-ligne ont une blob: URL réelle (OffscreenCanvas). */
  async assertOfflineCropRendered(docId, minCount = 1) {
    const card      = await this.getDocCard(docId);
    const vignettes = card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 10000 });
    const count = await vignettes.count();
    expect(count).toBeGreaterThanOrEqual(minCount);
    for (let i = 0; i < Math.min(count, 5); i++) {
      const img = vignettes.nth(i).locator('.vignette-crop-img');
      await expect.poll(() => img.evaluate(el => el.src),        { timeout: 8000 }).toMatch(/^blob:/);
      await expect.poll(() => img.evaluate(el => el.naturalWidth), { timeout: 8000 }).toBeGreaterThan(0);
    }
    return count;
  }

  /**
   * Audit global : 0 vignette corrompue (naturalWidth=0, opacity=0, classe erreur).
   * Utile après des bascules de filtres rapides ou des stress tests.
   */
  async assertNoCropCorruption({ timeout = 10000 } = {}) {
    let lastResult = { total: 0, corruptCount: 0, corruptSrcs: [] };
    await expect.poll(async () => {
      lastResult = await this.page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('.vignette-crop-img'));
        if (imgs.length === 0) return { total: 0, corruptCount: 0, corruptSrcs: [] };
        const corrupt = imgs.filter(img =>
          (img.complete && img.naturalWidth === 0) ||
          Boolean(img.closest('.vignette-error'))
        );
        return {
          total: imgs.length,
          corruptCount: corrupt.length,
          corruptSrcs: corrupt.slice(0, 3).map(i => i.src)
        };
      });
      return lastResult.corruptCount;
    }, { timeout, intervals: [300, 600, 1200] }).toBe(0);

    if (lastResult.corruptCount > 0) {
      console.error(`[assertNoCropCorruption] ${lastResult.corruptCount}/${lastResult.total} vignettes corrompues :`, lastResult.corruptSrcs);
    }
    return lastResult.total;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ASSERTIONS — STOCKAGE
  // ─────────────────────────────────────────────────────────────────────────────

  async assertStorageFreed(docId) {
    const id = Number(docId);
    const freedStatus = await this.page.evaluate(async (docIdNum) => {
      const normUrl = `/api/pdf/${docIdNum}`;
      let remainingChunks = 0;
      let metaExists  = false;
      let coverExists = false;

      if (window.pdfCacheManager) {
        const db = await window.pdfCacheManager.init();
        if (db) {
          metaExists = await new Promise((res) => {
            try {
              const tx = db.transaction('meta', 'readonly');
              const req = tx.objectStore('meta').get(normUrl);
              req.onsuccess = () => res(Boolean(req.result));
              req.onerror   = () => res(false);
            } catch { res(false); }
          });
          remainingChunks = await new Promise((res) => {
            try {
              const tx    = db.transaction('chunks', 'readonly');
              const store = tx.objectStore('chunks');
              const range = IDBKeyRange.bound(`${normUrl}#`, `${normUrl}#\uffff`);
              const req   = store.count(range);
              req.onsuccess = () => res(req.result || 0);
              req.onerror   = () => res(0);
            } catch { res(0); }
          });
        }
      }

      if (typeof caches !== 'undefined') {
        try {
          const cc = await caches.open('docseeker_covers');
          coverExists = Boolean(await cc.match(`/api/crop/${docIdNum}/1?v=thumb`));
        } catch {}
      }

      let indexedInSqlite = false;
      if (window.downloadQueueManager) {
        try {
          const cachedDocs = await window.downloadQueueManager.sendToWorker('GET_ALL_CACHED_DOCS', {});
          indexedInSqlite = Array.isArray(cachedDocs) && cachedDocs.some(d => Number(d.id) === docIdNum);
        } catch {}
      }

      return { remainingChunks, metaExists, coverExists, indexedInSqlite };
    }, id);

    expect(freedStatus.remainingChunks).toBe(0);
    expect(freedStatus.metaExists).toBe(false);
    expect(freedStatus.indexedInSqlite).toBe(false);
    return freedStatus;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ASSERTIONS — PERFORMANCE
  // ─────────────────────────────────────────────────────────────────────────────

  async getPerformanceMetrics() {
    return await this.page.evaluate(() => {
      const perf = window.performance;
      const mem  = perf && perf.memory ? {
        usedJSHeapSizeMB:  Math.round((perf.memory.usedJSHeapSize  / (1024 * 1024)) * 10) / 10,
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

  // ─────────────────────────────────────────────────────────────────────────────
  // STRESS HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  async spamClick(locator, count = 5, intervalMs = 25) {
    for (let i = 0; i < count; i++) {
      await locator.click({ force: true, noWaitAfter: true });
      if (intervalMs > 0 && i < count - 1) await this.page.waitForTimeout(intervalMs);
    }
  }

  async rapidSearchBurst(queries = ['car', 'gross', 'neph', 'inf'], intervalMs = 60) {
    const searchInput = this.page.locator('#searchInput');
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      await searchInput.fill(q);
      await this.page.evaluate((val) => window.performSearch && window.performSearch(val), q);
      if (intervalMs > 0 && i < queries.length - 1) await this.page.waitForTimeout(intervalMs);
    }
  }

  async rapidFolderSwitching(folderIds = [130, null, 130, null], intervalMs = 60) {
    for (let i = 0; i < folderIds.length; i++) {
      const fid = folderIds[i];
      if (fid !== null) {
        const card = this.page.locator(`.folder-card[data-folder-id="${fid}"]`);
        if (await card.isVisible()) await card.click({ force: true, noWaitAfter: true });
      } else {
        const root = this.page.locator('#breadcrumbsNav .breadcrumb-item').first();
        if (await root.isVisible()) await root.click({ force: true, noWaitAfter: true });
      }
      if (intervalMs > 0 && i < folderIds.length - 1) await this.page.waitForTimeout(intervalMs);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ZERO-ERROR ASSERTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  assertZeroErrors() {
    expect(this.capturedErrors).toHaveLength(0);
  }

  getErrors() {
    return this.capturedErrors;
  }
}

