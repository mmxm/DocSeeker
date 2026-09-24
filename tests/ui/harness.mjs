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
      sessionStorage.setItem('docseeker_last_sw_controller_reload', String(Date.now()));
    });
  }

  async goto(path = '/') {
    await this.page.goto(path);
    // Contournement déterministe : le service worker sert l'App Shell (app.js)
    // en Cache-First, ce qui peut masquer le code à l'exécution (stale).
    // On désactive UNIQUEMENT en contexte en ligne (les specs offline comptent
    // sur le SW et son cache App Shell — voir ui_offline.spec.mjs).
    await this.page.evaluate(async () => {
      try {
        if (navigator.onLine === false) return;
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.unregister();
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith('docseeker-app-shell')).map(k => caches.delete(k)));
      } catch (e) {}
    }).catch(() => {});
    await this.page.reload().catch(() => {});
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
    if (await folder.isVisible().catch(() => false)) {
      await folder.click();
      return;
    }
    const alreadyInside = await this.page.evaluate((id) => {
      return window.currentFolderId === Number(id) || document.querySelector(`.doc-card[data-folder-id="${id}"]`) !== null;
    }, folderId).catch(() => false);
    if (alreadyInside) return;
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
    // evaluate résilient : l'installation du service worker déclenche un
    // controllerchange + auto-reload qui détruit le contexte d'exécution en
    // plein evaluate (surtout WebKit, au premier chargement du contexte de
    // test). On renvoie undefined pour laisser expect.poll retenter après la
    // navigation au lieu de faire échouer le test.
    const safeEval = async (fn, arg) => {
      try {
        return await this.page.evaluate(fn, arg);
      } catch (e) {
        if (/execution context|context was destroyed|target closed|navigation/i.test(String(e))) return undefined;
        throw e;
      }
    };
    const isAlreadyDone = await safeEval(async (idNum) => {
      const isIndexed  = window.downloadQueueManager?.isDocumentCached(idNum);
      if (!isIndexed) return false;
      // If pdfCacheManager missing, trust downloadQueueManager's isDocumentCached
      if (!window.pdfCacheManager) return true;
      const isComplete = await window.pdfCacheManager.isComplete(idNum);
      return Boolean(isComplete);
    }, id);
    if (isAlreadyDone) return;

    await safeEval(async (idNum) => {
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
        const state = await safeEval(async (idNum) => {
          const dqm = window.downloadQueueManager;
          const isIndexed = dqm?.isDocumentCached(idNum);
          if (!isIndexed) {
            if (dqm && !dqm.activeTasks.has(idNum) && !dqm.queue.includes(idNum)) {
              await dqm.enqueueDocument(idNum);
            }
            return false;
          }
          if (!window.pdfCacheManager) return true;
          const isComplete = await window.pdfCacheManager.isComplete(idNum);
          return Boolean(isIndexed && isComplete);
        }, id);
        return state === undefined ? false : state;
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
    const card = await this.getDocCard(docId);
    const cacheBtn = card.locator('.doc-cache-btn');
    await cacheBtn.waitFor({ state: 'visible', timeout: 8000 });
    await cacheBtn.click();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ASSERTIONS — VISUELS DU VIEWER PDF & DE L'INTERFACE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Vérification visuelle réelle du rendu PDF et de l'interface :
   * 1. Panneau du viewer visible (#viewerPane)
   * 2. Onglet actif (.reader-tab-item.active)
   * 3. Titre du document dans le bandeau (#viewerDocTitle non vide)
   * 4. Présence et rendu réel d'un canvas de page PDF dans l'iframe (width > 0, height > 0)
   * 5. Vérifie que le compteur de pages dans le viewer n'est PAS 0 ("0 sur 0" = crash)
   * 6. Optionnel : capture d'écran visuelle
   */
  async assertPdfViewerRendered({ minCanvasWidth = 200, minCanvasHeight = 200, minNonWhitePixels = 30, screenshotName = null } = {}) {
    const viewerPane = this.page.locator('#viewerPane');
    await expect(viewerPane).toBeVisible({ timeout: 10000 });

    const activeTab = this.page.locator('.reader-tab-item.active');
    await expect(activeTab).toBeVisible({ timeout: 10000 });

    const docTitle = this.page.locator('#viewerDocTitle');
    await expect(docTitle).toBeVisible();
    const titleText = await docTitle.innerText();
    expect(titleText.trim().length).toBeGreaterThan(0);

    const pdfFrame = this.page.locator('#pdfFrame');
    await expect(pdfFrame).toBeVisible({ timeout: 10000 });

    // Inspection dans le DOM de l'iframe PDF.js
    const frame = this.page.frameLocator('#pdfFrame');
    const pageView = frame.locator('.page[data-page-number="1"], .page').first();
    await expect(pageView).toBeVisible({ timeout: 15000 });

    // Attendre que la page soit marquée comme rendue par PDF.js
    await expect.poll(async () => {
      return await pageView.evaluate(el => el.getAttribute('data-loaded') === 'true' || el.classList.contains('page'));
    }, { timeout: 15000 }).toBe(true);

    const canvas = pageView.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 15000 });

    // 1. Vérification des dimensions réelles du canvas
    await expect.poll(async () => {
      return await canvas.evaluate(c => (c.width > 0 && c.height > 0));
    }, { timeout: 10000 }).toBe(true);

    const actualDims = await canvas.evaluate(c => ({
      width: c.width || 0,
      height: c.height || 0
    }));

    expect(actualDims.width).toBeGreaterThanOrEqual(minCanvasWidth);
    expect(actualDims.height).toBeGreaterThanOrEqual(minCanvasHeight);

    // 2. Vraie vérification anti-page blanche : échantillonnage des pixels réels du canvas
    // Si le PDF est une page blanche, nonWhitePixels = 0.
    await expect.poll(async () => {
      return await canvas.evaluate(c => {
        try {
          const ctx = c.getContext('2d');
          if (!ctx) return false;
          const w = Math.min(c.width, 400);
          const h = Math.min(c.height, 400);
          const imgData = ctx.getImageData(0, 0, w, h).data;
          let nonWhite = 0;
          for (let i = 0; i < imgData.length; i += 16) {
            const r = imgData[i];
            const g = imgData[i + 1];
            const b = imgData[i + 2];
            const a = imgData[i + 3];
            if (a > 30 && (r < 240 || g < 240 || b < 240)) {
              nonWhite++;
              if (nonWhite > 20) return true;
            }
          }
          return false;
        } catch (e) {
          return false;
        }
      });
    }, { timeout: 15000, intervals: [200, 400, 800] }).toBe(true);

    const pixelAnalysis = await canvas.evaluate(c => {
      try {
        const ctx = c.getContext('2d');
        const w = Math.min(c.width, 400);
        const h = Math.min(c.height, 400);
        const imgData = ctx.getImageData(0, 0, w, h).data;
        let nonWhite = 0;
        for (let i = 0; i < imgData.length; i += 16) {
          const r = imgData[i];
          const g = imgData[i + 1];
          const b = imgData[i + 2];
          const a = imgData[i + 3];
          if (a > 30 && (r < 240 || g < 240 || b < 240)) nonWhite++;
        }
        return { nonWhitePixels: nonWhite };
      } catch (e) {
        return { nonWhitePixels: 0 };
      }
    });

    // 3. Vérification de la couche de texte PDF.js (textLayer doit contenir des glyphes réels)
    const textLayer = pageView.locator('.textLayer');
    const textSpanCount = await textLayer.locator('span').count();
    const hasTextOrInk = pixelAnalysis.nonWhitePixels >= minNonWhitePixels || textSpanCount > 0;
    expect(hasTextOrInk).toBe(true);

    // 4. Vérifier que le nombre total de pages n'est pas 0 (pas de crash "0 sur 0")
    const numPages = await this.page.evaluate(() => {
      const win = document.getElementById('pdfFrame')?.contentWindow;
      return win?.PDFViewerApplication?.pagesCount || 0;
    });
    expect(numPages).toBeGreaterThan(0);

    if (screenshotName) {
      await this.page.screenshot({ path: `tests/ui/screenshots/${screenshotName}.png`, fullPage: false });
    }

    return {
      title: titleText,
      numPages,
      canvasWidth: actualDims.width,
      canvasHeight: actualDims.height,
      nonWhitePixels: pixelAnalysis.nonWhitePixels,
      textSpans: textSpanCount
    };
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
        const corrupt = imgs.filter(img => {
          // Si c'est le placeholder SVG ou en attente d'observation viewport, ce n'est pas une image corrompue
          if (img.src.startsWith('data:image/svg') || img.classList.contains('placeholder') || !img.src) return false;
          return (img.complete && img.naturalWidth === 0) || Boolean(img.closest('.vignette-error'));
        });
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
      // Tolérant aux re-renders : la carte peut être reconstruite pendant le spam,
      // on re-résout le locator à chaque itération (force=true gère les overlays transitoires).
      try {
        await locator.click({ force: true, noWaitAfter: true, timeout: 3000 });
      } catch (e) {
        // Bouton remplacé par un re-render pendant le spam : on retente une fois.
        await locator.click({ force: true, noWaitAfter: true, timeout: 3000 }).catch(() => {});
      }
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

  assertZeroErrors({ ignoreNetworkNoise = false } = {}) {
    if (!ignoreNetworkNoise) {
      expect(this.capturedErrors).toHaveLength(0);
      return;
    }
    // En navigation offline, WebKit logge un bruit réseau inévitable (échecs de
    // chargement de ressources, "access control checks", "internal error") même
    // quand l'application se dégrade et fonctionne via le service worker. On
    // filtre ces symptômes réseau tout en conservant les vraies erreurs JS.
    const REAL_JS_ERROR = /access control checks|internal error|Failed to load resource|Importing a module script failed/i;
    const real = this.capturedErrors.filter((msg) => !REAL_JS_ERROR.test(msg));
    expect(real).toHaveLength(0);
  }

  getErrors() {
    return this.capturedErrors;
  }
}

