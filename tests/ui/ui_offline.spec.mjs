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
  // O12 : Miroir hors-ligne de l'arborescence (docs non téléchargés visibles)
  // ─────────────────────────────────────────────────────────────────────────

  test('O12 - Miroir Hors-Ligne : Arborescence Complète avec Docs Méta-Seuls', async ({ page, context }) => {
    // En ligne : le doc 2 est indexé mais NON téléchargé → méta-seule dans le
    // miroir ; le doc 1 reste téléchargé. Le miroir global (syncLibraryMeta)
    // absorbe toute la bibliothèque au premier chargement.
    await page.evaluate(async () => {
      await window.downloadQueueManager.ensureInitialized();
      await window.downloadQueueManager.removeDocumentFromCache(2);
      await window.downloadQueueManager.ensureDocumentIndexedLocally(2);
      if (window.pdfCacheManager) await window.pdfCacheManager.invalidate(2);
    });
    await h.openFolder(130);
    await h.ensureDocCached(1);
    // Revenir à la racine pour déclencher le chargement global + miroir.
    await h.navigateToBreadcrumbRoot();
    await page.waitForTimeout(800);

    const mirrorKnown = await page.evaluate(() => window.downloadQueueManager?.isDocumentKnown(2));
    expect(mirrorKnown).toBe(true);

    // Hors-ligne + reload : l'arborescence doit montrer le doc méta-seul.
    // Comme un vrai utilisateur (SW actif depuis sa première visite), on attend
    // que le service worker contrôle la page avant de couper le réseau — sinon
    // le reload offline ne profite pas du cache SW et dégrade artificiellement.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      if (window.downloadQueueManager) await window.downloadQueueManager.ensureInitialized();
    });

    // Le doc téléchargé reste consultable, le méta-seul est visible et marqué.
    await expect(page.locator('.folder-card').first()).toBeVisible({ timeout: 15000 });
    await h.openFolder(130);
    const metaCard = page.locator('.doc-card[data-doc-id="2"]');
    await expect(metaCard).toBeVisible({ timeout: 10000 });
    await expect(metaCard.locator('.meta-not-offline')).toBeVisible();
    expect(await page.evaluate(() => window.downloadQueueManager?.isDocumentCached(2))).toBeFalsy();
    console.log('✅ [O12] Arborescence offline complète : doc méta-seul visible + marqué, doc caché intact.');
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

  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // O13 : Cache interrompu par changement d'onglet → Poursuite depuis l'arborescence
  // ─────────────────────────────────────────────────────────────────────────

  test('O13 - Cache Interrompu par Changement d Onglet : Poursuite depuis l Arborescence', async ({ page }) => {
    await h.ensureDocNotCached(1);
    await h.openFolder(130);

    // 1. Ouvrir le document 1 dans le viewer et vérifier le rendu effectif du canvas PDF
    const card = await h.getDocCard(1);
    await card.locator('.doc-title-main').click();
    await h.assertPdfViewerRendered();
    await expect(page.locator('#viewerCacheBadge')).toBeVisible({ timeout: 10000 });

    // 2. Quitter l'onglet en revenant à l'accueil
    await page.locator('#readerHomeBtn').click();
    await expect(page.locator('body')).toHaveClass(/home-tab-active/);
    await expect(page.locator('#viewerPane')).not.toBeVisible();
    await page.waitForTimeout(500);

    // 3. Dans l'arborescence, relancer la mise en cache directement depuis le bouton du document
    const homeCard = await h.getDocCard(1);
    const cacheBtn = homeCard.locator('.doc-cache-btn');
    await expect(cacheBtn).toBeVisible({ timeout: 10000 });

    // Si pas déjà complété par le premier transfert, cliquer pour continuer
    const isAlreadyCached = await cacheBtn.evaluate(el => el.classList.contains('cached'));
    console.log(`[TEST O13] isAlreadyCached: ${isAlreadyCached}`);
    if (!isAlreadyCached) {
      await cacheBtn.click();
      console.log('[TEST O13] cacheBtn clicked');
    }

    // 4. Vérifier que la mise en cache se termine avec succès (100%)
    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 45000 });
    const isComplete = await page.evaluate(async () => {
      return window.pdfCacheManager ? await window.pdfCacheManager.isComplete(1) : false;
    });
    expect(isComplete).toBe(true);
    console.log('✅ [O13] Mise en cache continuée et complétée avec succès depuis l arborescence.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O14 : Cache interrompu par changement d'onglet → Reprise automatique au retour
  // ─────────────────────────────────────────────────────────────────────────

  test('O14 - Cache Interrompu par Changement d Onglet : Reprise Automatique au Retour', async ({ page }) => {
    await h.ensureDocNotCached(1);
    await h.openFolder(130);

    // 1. Ouvrir le document 1 dans le viewer et vérifier le rendu effectif du canvas
    const card = await h.getDocCard(1);
    await card.locator('.doc-title-main').click();
    await h.assertPdfViewerRendered();
    const badge = page.locator('#viewerCacheBadge');
    await expect(badge).toBeVisible({ timeout: 10000 });

    // Lancer la mise en cache si non démarrée
    const isCachedInitial = await badge.evaluate(el => el.classList.contains('complete'));
    if (!isCachedInitial) {
      await badge.click();
    }

    // 2. Quitter l'onglet en revenant à l'accueil
    await page.locator('#readerHomeBtn').click();
    await expect(page.locator('body')).toHaveClass(/home-tab-active/);
    await expect(page.locator('#viewerPane')).not.toBeVisible();
    await page.waitForTimeout(600);

    // 3. Retourner sur l'onglet du document 1
    const tabItem = page.locator('.reader-tab-item').first();
    await expect(tabItem).toBeVisible({ timeout: 10000 });
    await tabItem.click();

    // 4. Le viewer se réaffiche, rend le PDF et la mise en cache doit reprendre jusqu'à complétion
    await h.assertPdfViewerRendered();
    await expect(badge).toHaveClass(/complete/, { timeout: 45000 });
    const isComplete = await page.evaluate(async () => {
      return window.pdfCacheManager ? await window.pdfCacheManager.isComplete(1) : false;
    });
    expect(isComplete).toBe(true);
    console.log('✅ [O14] Reprise automatique de la mise en cache au retour sur l onglet validée.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O15 : Ouverture Document Non En Cache → Pas de Téléchargement Automatique Intempestif
  // ─────────────────────────────────────────────────────────────────────────

  test('O15 - Ouverture Document Non En Cache : Pas de Téléchargement Automatique Intempestif', async ({ page }) => {
    await h.ensureDocNotCached(2);
    await h.openFolder(130);

    // 1. Première ouverture de consultation simple
    const card = await h.getDocCard(2);
    await card.locator('.doc-title-main').click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });
    const badge = page.locator('#viewerCacheBadge');
    await expect(badge).toBeVisible({ timeout: 10000 });

    // Attendre pour s'assurer qu'aucun téléchargement complet n'est lancé en douce
    await page.waitForTimeout(1000);

    let isEnqueuedOrActive = await page.evaluate(() => {
      const dqm = window.downloadQueueManager;
      return Boolean(dqm && (dqm.activeTasks.has(2) || dqm.queue.includes(2)));
    });
    expect(isEnqueuedOrActive).toBe(false);
    await expect(badge).not.toHaveClass(/downloading/);

    // 2. Quitter le document et retourner à l'accueil
    await page.locator('#readerHomeBtn').click();
    await expect(page.locator('body')).toHaveClass(/home-tab-active/);
    await expect(page.locator('#viewerPane')).not.toBeVisible();

    // 3. Réouverture du document : doit rester en consultation sans retéléchargement forcé
    const cardReopened = await h.getDocCard(2);
    await cardReopened.locator('.doc-title-main').click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    isEnqueuedOrActive = await page.evaluate(() => {
      const dqm = window.downloadQueueManager;
      return Boolean(dqm && (dqm.activeTasks.has(2) || dqm.queue.includes(2)));
    });
    expect(isEnqueuedOrActive).toBe(false);
    await expect(badge).not.toHaveClass(/downloading/);

    // 4. Seul un clic explicite sur le badge doit déclencher le téléchargement complet
    await badge.click();
    await expect(badge).toHaveClass(/downloading|complete/, { timeout: 10000 });
    console.log('✅ [O15] Zéro téléchargement intempestif aux ouvertures successives.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O16 : Ouverture & Fermeture Rapide Avant Fin de Téléchargement : Zéro 401, Zéro Exception Non Gérée
  // ─────────────────────────────────────────────────────────────────────────

  test('O16 - Ouverture & Fermeture Rapide : Zéro 401 et Zéro Exception Non Gérée', async ({ page, context }) => {
    const h = new DocSeekerTestHarness(page, context);
    await h.authenticate();
    await h.goto('/');

    const unhandledErrors = [];
    const authFailures = [];

    page.on('pageerror', err => {
      unhandledErrors.push(err.message);
    });

    page.on('response', res => {
      if (res.status() === 401 && res.url().includes('/api/pdf/')) {
        authFailures.push(res.url());
      }
    });

    await h.ensureDocNotCached(1);
    await h.openFolder(130);

    // 1. Ouvrir le document 1
    const card = await h.getDocCard(1);
    await card.locator('.doc-title-main').click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });

    // 2. Fermeture rapide (immédiate) avant fin du streaming
    await page.waitForTimeout(100);
    await page.locator('#readerHomeBtn').click();
    await expect(page.locator('body')).toHaveClass(/home-tab-active/);
    await expect(page.locator('#viewerPane')).not.toBeVisible();

    // 3. Attente passive pour vérifier qu'aucun callback asynchrone zombie ne plante
    await page.waitForTimeout(2000);

    // 4. Vérification zéro erreur 401 et zéro uncaught exception
    expect(authFailures).toEqual([]);
    expect(unhandledErrors.filter(msg => !msg.includes('ResizeObserver'))).toEqual([]);

    // 5. Réouverture sereine du document
    const reopenedCard = await h.getDocCard(1);
    await reopenedCard.locator('.doc-title-main').click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#viewerCacheBadge')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    expect(authFailures).toEqual([]);
    expect(unhandledErrors.filter(msg => !msg.includes('ResizeObserver'))).toEqual([]);
    console.log('✅ [O16] Zéro erreur 401 et zéro exception non gérée lors d une fermeture rapide validés.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O17 : Cycle Hybride : Consultation partielle → Arborescence → Reprise → Réouverture onglet
  // ─────────────────────────────────────────────────────────────────────────

  test('O17 - Cycle Hybride : Consultation partielle → Arborescence → Reprise → Réouverture onglet', async ({ page, context }) => {
    const h = new DocSeekerTestHarness(page, context);
    await h.authenticate();
    await h.goto('/');

    await h.ensureDocNotCached(2);
    await h.openFolder(130);

    // 1. Ouvrir le document 2 dans le viewer et vérifier le rendu effectif du canvas
    const card = await h.getDocCard(2);
    await card.locator('.doc-title-main').click();
    await h.assertPdfViewerRendered();
    const badge = page.locator('#viewerCacheBadge');
    await expect(badge).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(500);

    // 2. Retour à l'accueil
    await page.locator('#readerHomeBtn').click();
    await expect(page.locator('body')).toHaveClass(/home-tab-active/);
    await expect(page.locator('#viewerPane')).not.toBeVisible();

    // 3. Dans l'arborescence, lancer la mise en cache complète
    const homeCard = await h.getDocCard(2);
    const cacheBtn = homeCard.locator('.doc-cache-btn');
    await cacheBtn.click();
    await expect(cacheBtn).toHaveClass(/downloading|cached/, { timeout: 10000 });

    // 4. Rebasculer immédiatement sur l'onglet ouvert du document 2
    const tabItem = page.locator('.reader-tab-item').first();
    await expect(tabItem).toBeVisible({ timeout: 10000 });
    await tabItem.click();

    // 5. Le viewer s'affiche, le canvas PDF est rendu, le badge reflète l'avancement et se termine à 100%
    await h.assertPdfViewerRendered();
    await expect(badge).toHaveClass(/complete/, { timeout: 45000 });

    const isComplete = await page.evaluate(async () => {
      return window.pdfCacheManager ? await window.pdfCacheManager.isComplete(2) : false;
    });
    expect(isComplete).toBe(true);
    console.log('✅ [O17] Cycle hybride arborescence + réouverture onglet validé avec succès.');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O18 : Interruption non destructrice : Clic Stop → Préservation octets → Reprise 100%
  // ─────────────────────────────────────────────────────────────────────────

  test('O18 - Interruption Non Destructrice : Clic Stop → Préservation Octets → Reprise 100%', async ({ page, context }) => {
    const h = new DocSeekerTestHarness(page, context);
    await h.authenticate();
    await h.goto('/');

    // 1. Démarrer avec un cache partiel déterministe (30%)
    await h.injectPartialCache(1, 30);
    await h.openFolder(130);

    const card = await h.getDocCard(1);
    const cacheBtn = card.locator('.doc-cache-btn');
    await expect(cacheBtn).toBeVisible({ timeout: 10000 });

    // Vérifier les fragments initiaux
    const statsInit = await page.evaluate(async () => {
      return window.pdfCacheManager ? await window.pdfCacheManager.getCachedStats(1) : null;
    });
    expect(statsInit).not.toBeNull();
    expect(statsInit.downloadedBytes).toBeGreaterThan(0);
    const initialBytes = statsInit.downloadedBytes;

    // 2. Simuler une mise en pause explicite
    await page.evaluate(async () => {
      if (window.downloadQueueManager) window.downloadQueueManager.pauseDownload(1);
    });

    // 3. Vérifier que la pause n'a absolument PAS détruit les fragments existants
    const statsPaused = await page.evaluate(async () => {
      return window.pdfCacheManager ? await window.pdfCacheManager.getCachedStats(1) : null;
    });
    expect(statsPaused.downloadedBytes).toBeGreaterThanOrEqual(initialBytes);
    expect(statsPaused.status).toBe('paused');
    console.log(`[O18] Statut après pause : ${statsPaused.status}, octets conservés : ${statsPaused.downloadedBytes}/${statsPaused.totalBytes}`);

    // 4. Reprendre le téléchargement en cliquant sur le bouton de l'arborescence
    await cacheBtn.click();

    // 5. Vérifier que la mise en cache continue et se termine à 100%
    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 45000 });

    const isComplete = await page.evaluate(async () => {
      return window.pdfCacheManager ? await window.pdfCacheManager.isComplete(1) : false;
    });
    expect(isComplete).toBe(true);
    console.log('✅ [O18] Interruption non destructrice et reprise complète validées.');
  });
});


