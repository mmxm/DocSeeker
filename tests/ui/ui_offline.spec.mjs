/**
 * DocSeeker - Tests Résilience Réseau & Offline (ui_offline.spec.mjs)
 *
 * Couvre : cache partiel, flapping, exclusions strictes, vignettes blob URL,
 * polices propriétaires (régression disableFontFace), parité online/offline.
 * Pattern canonique identique à ui_core : beforeEach / afterEach.
 * Retries : 0 (contexts isolés, déterministes).
 */
import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Scénarios paramétrés — Résilience
// ─────────────────────────────────────────────────────────────────────────────

const resilienceScenarios = [
  {
    id: 'O4', docId: 1, interruptPercent: 15, query: 'grossesse',
    name: 'Cache partiel 15% → exclusion hors-ligne → reprise 100%',
  },
  {
    id: 'O5', docId: 1, interruptPercent: 50, query: 'patiente',
    name: 'Cache partiel 50% → exclusion hors-ligne → reprise 100%',
  },
  {
    id: 'O6', docId: 1, flapping: true, query: 'grossesse',
    name: 'Flapping réseau (Online/Offline répétés) → reprise complète',
  },
  {
    id: 'O7', docId: 1, heavyQuery: 'grossesse*',
    name: 'Recherche lourde avec wildcard en coupure réseau totale',
  },
  {
    id: 'O8', docId: 1, noMatchQuery: 'termeinexistant12345*',
    name: 'Recherche sans résultat hors-ligne → état vide propre, 0 erreur',
  },
];

test.describe('DocSeeker - Résilience Réseau & Cache Partiel', () => {

  for (const sc of resilienceScenarios) {
    test(`${sc.id} - ${sc.name}`, async ({ page, context }) => {
      const h = new DocSeekerTestHarness(page, context);
      await h.authenticate();
      await h.goto('/');

      if (sc.interruptPercent) {
        // Cache partiel déterministe
        await h.injectPartialCache(sc.docId, sc.interruptPercent);
        const isComplete = await page.evaluate(async id =>
          window.pdfCacheManager ? await window.pdfCacheManager.isComplete(id) : false, sc.docId
        );
        expect(isComplete).toBeFalsy();

        // Offline → doc partiel exclu
        await h.setOffline(true);
        await h.setOfflineFilter(true);
        await h.search(sc.query);
        await page.waitForTimeout(500);
        await expect(page.locator(`.doc-card[data-doc-id="${sc.docId}"]`)).toHaveCount(0);
        h.assertZeroErrors();

        // Reprise réseau → download complet
        await h.setOffline(false);
        await h.setOfflineFilter(false);
        await h.clearSearch();
        await h.openFolder(130);
        await h.ensureDocCached(sc.docId, { clean: true, timeoutMs: 45000 });

        // Vérification hors-ligne avec le doc complet
        await h.setOffline(true);
        await h.setOfflineFilter(true);
        await h.search(sc.query);
        await expect(await h.getDocCard(sc.docId)).toBeVisible({ timeout: 10000 });
        await h.assertVignettesVisible(sc.docId, 1);
        h.assertZeroErrors();
        await h.setOffline(false);

      } else if (sc.flapping) {
        await h.ensureDocNotCached(sc.docId);
        await h.openFolder(130);
        const card    = await h.getDocCard(sc.docId);
        const btn     = card.locator('.doc-cache-btn');
        await btn.click();

        // Micro-coupures réseau pendant le streaming
        await context.setOffline(true); await page.waitForTimeout(150);
        await context.setOffline(false); await page.waitForTimeout(150);

        await h.downloadDocToComplete(sc.docId, 45000);

        await h.setOffline(true);
        await h.setOfflineFilter(true);
        await h.search(sc.query);
        await expect(await h.getDocCard(sc.docId)).toBeVisible({ timeout: 10000 });
        await h.assertVignettesVisible(sc.docId, 1);
        h.assertZeroErrors();
        await h.setOffline(false);

      } else if (sc.heavyQuery) {
        await h.ensureDocCached(sc.docId, { clean: true, timeoutMs: 45000 });
        await h.openFolder(130);

        await h.setOffline(true);
        await h.setOfflineFilter(true);
        await h.search(sc.heavyQuery);
        await expect(await h.getDocCard(sc.docId)).toBeVisible({ timeout: 10000 });
        await h.assertVignettesVisible(sc.docId, 1);
        h.assertZeroErrors();
        await h.setOffline(false);

      } else if (sc.noMatchQuery) {
        await h.ensureDocCached(sc.docId, { clean: true, timeoutMs: 45000 });
        await h.openFolder(130);

        await h.setOffline(true);
        await h.setOfflineFilter(true);
        await h.search(sc.noMatchQuery);

        await expect(page.locator('#emptyState')).toBeVisible({ timeout: 6000 });
        h.assertZeroErrors();
        await h.setOffline(false);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests non-paramétrés — Fonctionnalités offline spécifiques
// ─────────────────────────────────────────────────────────────────────────────

test.describe('DocSeeker - Offline : Tests Spécifiques', () => {
  let h;

  test.beforeEach(async ({ page, context }) => {
    h = new DocSeekerTestHarness(page, context);
    await h.authenticate();
    await h.goto('/');
  });

  test.afterEach(async () => {
    await h.resetState();
    h.assertZeroErrors();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O1 : Full Offline F5 + Split View + blob URL
  // ─────────────────────────────────────────────────────────────────────────

  test('O1 - Full Offline F5 : Recherche, Vignettes Blob & Split View', async ({ page, context }) => {
    await h.openFolder(130);
    await h.ensureDocCached(1);

    await context.setOffline(true);
    console.log('[O1] Rechargement F5 sans réseau...');
    await page.reload();
    await page.evaluate(async () => {
      if (window.downloadQueueManager) await window.downloadQueueManager.ensureInitialized();
    });

    await h.injectSearchQuery('grossess', { expectResultsIn: 15000 });

    // Vignettes avec blob URL
    const vigCount = await h.assertOfflineCropRendered(1, 1);
    console.log(`[O1] ${vigCount} vignettes blob: URL offline ✅`);

    // Split View
    await page.locator('.doc-card[data-doc-id="1"] .vignette-item').first().click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 12000 });
    await expect(page.locator('#viewerDocTitle')).toContainText('Grossesse');
    await expect(page.locator('#pdfFrame')).toHaveAttribute('src', /\/pdfjs\/web\/viewer\.html/, { timeout: 10000 });
    console.log('[O1] Split View full offline validé ✅');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O2 : Exclusion doc sans binaire PDF (NetworkError = 0)
  // ─────────────────────────────────────────────────────────────────────────

  test('O2 - Exclusion Doc sans Binaire PDF (Zéro NetworkError)', async ({ page, context }) => {
    // Doc 2 : texte indexé dans SQLite mais sans binaire PDF dans IndexedDB
    await page.evaluate(async () => {
      await window.downloadQueueManager.ensureInitialized();
      await window.downloadQueueManager.removeDocumentFromCache(2);
      await window.downloadQueueManager.ensureDocumentIndexedLocally(2);
      if (window.pdfCacheManager) await window.pdfCacheManager.invalidate(2);
    });

    const networkErrors = [];
    page.on('console', msg => {
      if (msg.text().includes('NetworkError') || msg.text().includes('[CropWorker] Error')) {
        networkErrors.push(msg.text());
      }
    });

    await context.setOffline(true);
    await h.setOfflineFilter(true);
    await h.search('extra-utérine');
    await page.waitForTimeout(500);

    expect(await page.evaluate(() => window.downloadQueueManager?.isDocumentCached(2))).toBeFalsy();
    await expect(page.locator('.doc-card[data-doc-id="2"]')).toHaveCount(0);
    expect(networkErrors).toHaveLength(0);
    console.log('✅ [O2] Exclusion stricte + zéro NetworkError.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O3 : Filtre offline actif sans coupure réseau (navigator.onLine = true)
  // ─────────────────────────────────────────────────────────────────────────

  test('O3 - Filtre Offline Actif sans Coupure Réseau (Exclusion Stricte)', async ({ page }) => {
    await page.evaluate(async () => {
      await window.downloadQueueManager.ensureInitialized();
      await window.downloadQueueManager.ensureDocumentIndexedLocally(3);
      if (window.pdfCacheManager) await window.pdfCacheManager.invalidate(3);
    });

    const cropErrors = [];
    page.on('console', msg => {
      if (msg.text().includes('[CropWorker] Error') || msg.text().includes('NetworkError')) {
        cropErrors.push(msg.text());
      }
    });

    await h.setOfflineFilter(true);
    await h.search('de');
    await page.waitForTimeout(400);

    expect(await page.evaluate(() => window.downloadQueueManager?.isDocumentCached(3))).toBeFalsy();
    await expect(page.locator('.doc-card[data-doc-id="3"]')).toHaveCount(0);
    expect(cropErrors).toHaveLength(0);
    console.log('✅ [O3] Exclusion stricte doc non-téléchargé + zéro erreur worker.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O9 : Parité vignettes online vs offline (même nombre, même page de tête)
  // ─────────────────────────────────────────────────────────────────────────

  test('O9 - Parité Vignettes Online vs Offline (Nombre & Page de Tête)', async ({ page, context }) => {
    await h.openFolder(130);
    await h.ensureDocCached(1);

    // 1. Mesure online
    await h.injectSearchQuery('grossesse', { expectResultsIn: 15000 });
    const card = await h.getDocCard(1);
    await expect(card.locator('.vignette-item').first()).toBeVisible({ timeout: 10000 });
    const onlineCount = await card.locator('.vignette-item').count();
    const onlineFirstPage = await card.locator('.vignette-item').first().getAttribute('data-page');
    console.log(`[O9] Online : ${onlineCount} vignettes, première page : ${onlineFirstPage}`);

    // 2. Mesure offline
    await context.setOffline(true);
    await h.setOfflineFilter(true);
    await h.search('grossesse');
    await page.waitForTimeout(600);

    const offlineCard = await h.getDocCard(1);
    const offlineCount = await offlineCard.locator('.vignette-item').count();
    const offlineFirstPage = await offlineCard.locator('.vignette-item').first().getAttribute('data-page');
    console.log(`[O9] Offline : ${offlineCount} vignettes, première page : ${offlineFirstPage}`);

    expect(offlineCount).toBe(onlineCount);
    expect(offlineFirstPage).toBe(onlineFirstPage);
    console.log('✅ [O9] Parité online/offline stricte validée.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O10 : Vignettes polices propriétaires — régression disableFontFace
  //       Vérifie qu'aucune vignette de Néphrologie n'est corrompue (tofu boxes)
  // ─────────────────────────────────────────────────────────────────────────

  test('O10 - Qualité Vignettes Offline : Zéro Corruption Police (Régression disableFontFace)', async ({ page, context }) => {
    // Mettre Néphrologie en cache (polices propriétaires WarnockPro/Helvetica LT)
    const nephroCard = page.locator('.doc-card[data-doc-id="544"]');
    await expect(nephroCard).toBeVisible({ timeout: 10000 });
    const cacheBtn = nephroCard.locator('.doc-cache-btn');
    if (!await cacheBtn.evaluate(el => el.classList.contains('cached'))) {
      await cacheBtn.click();
      await expect(cacheBtn).toHaveClass(/cached/, { timeout: 45000 });
    }

    // Activer offline + filtre
    await context.setOffline(true);
    await h.setOfflineFilter(true);
    await h.search('insuffisance rénale aigue');

    const card = await h.getDocCard(544);
    const vignettes = card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 15000 });

    // Attendre que les blobs soient générés
    await page.waitForTimeout(2000);

    // Audit : 0 vignette avec naturalWidth = 0 (signe d'une image corrompue/vide)
    const auditResult = await page.evaluate(() => {
      const imgs    = Array.from(document.querySelectorAll('.doc-card[data-doc-id="544"] .vignette-crop-img'));
      const corrupt = imgs.filter(img => !img.complete || img.naturalWidth === 0);
      return { total: imgs.length, corruptCount: corrupt.length };
    });
    console.log(`[O10] Vignettes Néphrologie : ${auditResult.total} total, ${auditResult.corruptCount} corrompues`);
    expect(auditResult.total).toBeGreaterThan(0);
    expect(auditResult.corruptCount).toBe(0);
    console.log('✅ [O10] Zéro tofu-box, disableFontFace opérationnel.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O11 : Parité Stricte Néphrologie — p.267 en tête + 25 vignettes + viewer
  // ─────────────────────────────────────────────────────────────────────────

  test('O11 - Parité Stricte Hors-Ligne Néphrologie (p.267 Tête + 25 Vignettes)', async ({ page, context }) => {
    const cacheBtn = page.locator('.doc-card[data-doc-id="544"] .doc-cache-btn');
    await expect(cacheBtn).toBeVisible({ timeout: 10000 });
    if (!await cacheBtn.evaluate(el => el.classList.contains('cached'))) {
      console.log('[O11] Mise en cache Néphrologie (#544)...');
      await cacheBtn.click();
      await expect(cacheBtn).toHaveClass(/cached/, { timeout: 45000 });
    }

    await context.setOffline(true);
    await h.setOfflineFilter(true);
    await h.search('insuffisance rénale aigue');

    const card = await h.getDocCard(544);
    await expect(card).toBeVisible({ timeout: 15000 });
    const vignettes = card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 10000 });
    const count = await vignettes.count();
    console.log(`[O11] Vignettes : ${count}`);
    expect(count).toBe(25);

    // Première vignette = page 267 (titre de chapitre IRA)
    const firstVig = vignettes.first();
    await expect(firstVig).toHaveAttribute('data-page', '267');
    await expect(firstVig.locator('.vignette-page-badge')).toContainText('p. 267');
    const titleAttr = await firstVig.getAttribute('title');
    expect(titleAttr).toContain('Page 267');
    expect(titleAttr).toContain('(Titre)');

    // Clic → viewer → badge page 267 synchronisé
    await firstVig.click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#viewerPageBadge')).toHaveText('Page 267');
    // La liste desktop #docOccurrencesList vit dans #resultsPane, masqué en mode lecteur ;
    // les extraits visibles sont dans le tiroir #inDocDrawerOccurrencesList.
    const activeOcc = page.locator('#inDocDrawerOccurrencesList .vertical-occ-card.active');
    await expect(activeOcc).toBeVisible({ timeout: 10000 });
    await expect(activeOcc.locator('.vertical-occ-page')).toHaveText('Page 267');

    await page.locator('#closeViewerBtn').click();
    await expect(page.locator('#viewerPane')).not.toBeVisible();
    console.log('✅ [O11] Parité absolue Néphrologie offline validée.');
  });
});
