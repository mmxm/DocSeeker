/**
 * DocSeeker - Tests Cœur UI (ui_core.spec.mjs)
 *
 * Couvre les fonctionnalités fondamentales : bibliothèque, cache, sélection, split-view.
 * Pattern canonique : beforeEach → authenticate + goto('/') | afterEach → resetState + assertZeroErrors
 * Retries : 0 (tests déterministes)
 */
import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';

test.describe('DocSeeker - Tests Cœur UI', () => {
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

  // =========================================================================
  // Core-1 : Chargement & Exploration de la Bibliothèque en Ligne
  // =========================================================================

  test('Core-1 - Chargement & Exploration de la Bibliothèque en Ligne', async ({ page }) => {
    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const count = await cards.count();
    console.log(`[Core-1] Documents chargés : ${count}`);
    expect(count).toBeGreaterThan(10);

    // Dossier Martingale visible à la racine
    const folderMartingale = page.locator('.folder-card[data-folder-id="130"]');
    await expect(folderMartingale).toBeVisible();

    // Entrer dans Martingale → doc 1 visible avec titre
    await folderMartingale.click();
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 8000 });
    await expect(doc1Card.locator('.doc-title-main')).toContainText('Grossesse');

    // Retour racine via fil d'Ariane
    await h.navigateToBreadcrumbRoot();
    await expect(folderMartingale).toBeVisible();
  });

  // =========================================================================
  // Core-2 : Recherche Globale en Ligne & Vignettes réelles
  // =========================================================================

  test('Core-2 - Recherche Globale en Ligne & Rendu Visuel des Vignettes', async ({ page }) => {
    await h.injectSearchQuery('grossess', { expectResultsIn: 15000 });
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 15000 });

    const vignettes = doc1Card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 10000 });
    const vignetteCount = await vignettes.count();
    console.log(`[Core-2] Vignettes doc #1 : ${vignetteCount}`);
    expect(vignetteCount).toBeGreaterThan(0);

    // Image réelle chargée (naturalWidth > 0)
    const firstImg = vignettes.first().locator('.vignette-crop-img');
    await expect(firstImg).toBeVisible();
    await expect.poll(() => firstImg.evaluate(img => img.naturalWidth), { timeout: 8000 }).toBeGreaterThan(0);
  });

  // =========================================================================
  // Core-3 : Download cache + transition bouton
  // =========================================================================

  test('Core-3 - Mise en Cache & Transition Visuelle du Bouton', async ({ page }) => {
    await h.openFolder(130);
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 10000 });
    const cacheBtn = doc1Card.locator('.doc-cache-btn');

    // Nettoyer si déjà en cache
    const isCached = await cacheBtn.evaluate(b => b.classList.contains('cached'));
    if (isCached) {
      page.once('dialog', d => d.accept());
      await cacheBtn.click();
      await expect(cacheBtn).not.toHaveClass(/cached/, { timeout: 6000 });
    }

    console.log('[Core-3] Déclenchement mise en cache doc #1...');
    await cacheBtn.click();
    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 15000 });
    await expect(cacheBtn.locator('polyline')).toBeVisible();

    const isCachedInManager = await page.evaluate(() => window.downloadQueueManager?.isDocumentCached(1));
    expect(isCachedInManager).toBe(true);

    const isPdfComplete = await page.evaluate(async () =>
      window.pdfCacheManager ? await window.pdfCacheManager.isComplete(1) : false
    );
    expect(isPdfComplete).toBe(true);
    console.log('[Core-3] Doc #1 mis en cache à 100% ✅');
  });

  // =========================================================================
  // Core-4 : Persistance SQLite OPFS post-F5
  // =========================================================================

  test('Core-4 - Persistance du Cache après Rechargement Complet (F5)', async ({ page }) => {
    // Garantir que le doc 1 est en cache
    await h.openFolder(130);
    await h.ensureDocCached(1);

    // Recharger la page
    console.log('[Core-4] Rechargement (F5)...');
    await page.reload();
    // Attendre l'init complète du worker offline après reload
    await page.locator('#searchInput').waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(async () => {
      if (window.downloadQueueManager) await window.downloadQueueManager.ensureInitialized();
    });

    const folderMartingale = page.locator('.folder-card[data-folder-id="130"]');
    await expect(folderMartingale).toBeVisible({ timeout: 10000 });
    await folderMartingale.click();

    const reloadedBtn = page.locator('.doc-card[data-doc-id="1"] .doc-cache-btn');
    await expect(reloadedBtn).toHaveClass(/cached/, { timeout: 12000 });

    const cachedInWorker = await page.evaluate(async () =>
      window.downloadQueueManager ? await window.downloadQueueManager.sendToWorker('GET_ALL_CACHED_DOCS', {}) : []
    );
    console.log(`[Core-4] Documents SQLite OPFS après F5 : ${cachedInWorker.length}`);
    expect(cachedInWorker.some(d => Number(d.id) === 1)).toBe(true);
  });

  // =========================================================================
  // Core-5 : Filtre offline + badge dossier
  // =========================================================================

  test('Core-5 - Filtre Hors-Ligne & Badge de Dossier', async ({ page }) => {
    // Garantir que le doc 1 est en cache
    await h.openFolder(130);
    await h.ensureDocCached(1);
    await h.navigateToBreadcrumbRoot();

    await h.setOfflineFilter(true);

    const martingaleFolder = page.locator('.folder-card[data-folder-id="130"]');
    await expect(martingaleFolder).toBeVisible({ timeout: 6000 });

    const badge = martingaleFolder.locator('.folder-cache-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/✓ 1/);

    await martingaleFolder.click();
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 6000 });
    await expect(doc1Card.locator('.doc-cache-btn')).toHaveClass(/cached/);
  });

  // =========================================================================
  // Core-6 : Suppression cache + libération profonde stockage
  // =========================================================================

  test('Core-6 - Suppression Cache Local & Libération Profonde du Stockage', async ({ page }) => {
    await h.openFolder(130);
    await h.ensureDocCached(1);

    const cacheBtn = page.locator('.doc-card[data-doc-id="1"] .doc-cache-btn');
    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 10000 });

    page.once('dialog', d => {
      console.log(`[Core-6] Confirmation : "${d.message()}"`);
      d.accept();
    });
    await cacheBtn.click();

    await expect(cacheBtn).not.toHaveClass(/cached/, { timeout: 8000 });
    const isCachedAfter = await page.evaluate(() => window.downloadQueueManager?.isDocumentCached(1));
    expect(isCachedAfter).toBe(false);

    // Vérification SQLite OPFS
    await expect.poll(async () => {
      const docs = await page.evaluate(async () =>
        window.downloadQueueManager ? await window.downloadQueueManager.sendToWorker('GET_ALL_CACHED_DOCS', {}) : []
      );
      return docs.some(d => Number(d.id) === 1);
    }, { timeout: 5000 }).toBe(false);

    console.log('[Core-6] Suppression validée ✅');
  });

  // =========================================================================
  // Core-7 : Sélection multiple O(1) + batch cache/uncache
  // =========================================================================

  test('Core-7 - Sélection Multiple O(1), Lot Cache & Uncache', async ({ page }) => {
    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    expect(await cards.count()).toBeGreaterThan(2);

    const doc1Id = Number(await cards.nth(0).getAttribute('data-doc-id'));
    const doc2Id = Number(await cards.nth(1).getAttribute('data-doc-id'));
    console.log(`[Core-7] Lot : #${doc1Id} et #${doc2Id}`);

    // Nettoyer les deux docs au départ
    await h.ensureDocNotCached(doc1Id);
    await h.ensureDocNotCached(doc2Id);

    // Mode sélection multiple
    await page.locator('#toggleSelectionModeBtn').click();
    await cards.nth(0).locator('.doc-selection-checkbox').click();
    await cards.nth(1).locator('.doc-selection-checkbox').click();

    const actionBar = page.locator('#selectionActionBar');
    await expect(actionBar).toBeVisible();
    await expect(page.locator('#selectionCountText')).toContainText('2 documents sélectionnés');

    // Batch cache
    await page.locator('#batchCacheBtn').click();
    await expect(cards.nth(0).locator('.doc-cache-btn')).toHaveClass(/cached/, { timeout: 25000 });
    await expect(cards.nth(1).locator('.doc-cache-btn')).toHaveClass(/cached/, { timeout: 25000 });
    console.log('[Core-7] Mise en cache par lot réussie ✅');

    // Batch uncache
    page.once('dialog', d => { console.log(`[Core-7] Confirmation lot : "${d.message()}"`); d.accept(); });
    await page.locator('#batchUncacheBtn').click();
    await expect(cards.nth(0).locator('.doc-cache-btn')).not.toHaveClass(/cached/, { timeout: 10000 });
    await expect(cards.nth(1).locator('.doc-cache-btn')).not.toHaveClass(/cached/, { timeout: 10000 });
    console.log('[Core-7] Retrait du cache par lot validé ✅');
  });

  // =========================================================================
  // Core-8 : Badge dossier 3/3 complet
  // =========================================================================

  test('Core-8 - Badge Dossier 3/3 "✓ En Cache" (Couverture Complète)', async ({ page }) => {
    test.setTimeout(120000); // 3 docs × 30s chacun
    const folderMartingale = page.locator('.folder-card[data-folder-id="130"]');
    await expect(folderMartingale).toBeVisible({ timeout: 10000 });
    await folderMartingale.click();

    await expect(page.locator('#breadcrumbsNav')).toContainText('Martingale', { timeout: 8000 });
    // Attendre qu'un doc CONNU du dossier soit visible avant de compter (anti-race)
    await expect(page.locator('.doc-card[data-doc-id="1"]')).toBeVisible({ timeout: 10000 });
    const docCards = page.locator('.doc-card');
    const docCount = await docCards.count();
    expect(docCount).toBe(3);

    // Mettre les 3 docs en cache
    for (let i = 0; i < docCount; i++) {
      const cacheBtn = docCards.nth(i).locator('.doc-cache-btn');
      if (!await cacheBtn.evaluate(el => el.classList.contains('cached'))) {
        await cacheBtn.click();
      }
    }
    for (let i = 0; i < docCount; i++) {
      await expect(docCards.nth(i).locator('.doc-cache-btn')).toHaveClass(/cached/, { timeout: 30000 });
    }

    // Retour racine
    await h.navigateToBreadcrumbRoot();
    await expect(folderMartingale).toBeVisible();

    // Badge ✓ complet non tronqué
    const badge = folderMartingale.locator('.folder-cache-badge');
    await expect(badge).toBeVisible({ timeout: 6000 });
    await expect(badge).toHaveClass(/complete/);
    await expect(badge).toHaveText('✓');
    const badgeBox = await badge.boundingBox();
    expect(badgeBox).not.toBeNull();
    expect(badgeBox.width).toBeGreaterThan(15);

    // Bouton d'action dossier → supprimer du cache
    await expect(folderMartingale.locator('.folder-btn-action.btn-delete-folder-cache')).toBeVisible();
    console.log('[Core-8] Badge dossier 3/3 ✓ validé ✅');
  });

  // =========================================================================
  // Core-9 : Résultats maintenus après split-view + tri
  // =========================================================================

  test('Core-9 - Résultats de Recherche Maintenus après Split View & Tri', async ({ page }) => {
    await h.injectSearchQuery('grossesse');

    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThan(0);

    // Ouvrir Split View depuis la première vignette
    const firstVignette = page.locator('.vignette-item').first();
    await firstVignette.click();
    await expect(page.locator('#workspace')).toHaveClass(/split-active/, { timeout: 10000 });

    // Fermer
    await page.locator('#closeViewerBtn').click();
    await expect(page.locator('#workspace')).not.toHaveClass(/split-active/);
    await expect(page.locator('#generalView')).toBeVisible();

    // Tri → résultats toujours affichés avec vignettes
    await page.locator('#sortSelect').selectOption('name_asc');
    await page.waitForTimeout(300);
    await expect(page.locator('.vignette-item').first()).toBeVisible({ timeout: 5000 });
    expect(await page.locator('#foldersSection').isVisible()).toBe(false);
    console.log('✅ [Core-9] Maintien résultats après Split View et tri validé.');
  });

  // =========================================================================
  // Core-10 : Reset recherche (X, Échap, Scanner)
  // =========================================================================

  test('Core-10 - Réinitialisation Recherche : Bouton X, Échap, Scanner', async ({ page }) => {
    const searchInput = page.locator('#searchInput');

    // 1. Via bouton X
    await h.injectSearchQuery('grossesse');
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 10000 });
    await page.locator('#clearSearchBtn').click();
    await expect(page.locator('#foldersSection')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.vignette-item')).toHaveCount(0);
    console.log('✅ [Core-10] Réinitialisation via X.');

    // 2. Via Échap
    await h.injectSearchQuery('grossesse');
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 10000 });
    await searchInput.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#foldersSection')).toBeVisible({ timeout: 5000 });
    expect(await searchInput.inputValue()).toBe('');
    console.log('✅ [Core-10] Réinitialisation via Échap.');

    // 3. Via bouton Scanner
    await h.injectSearchQuery('grossesse');
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 10000 });
    await page.locator('#syncDocsBtn').click();
    await expect(page.locator('#foldersSection')).toBeVisible({ timeout: 10000 });
    expect(await searchInput.inputValue()).toBe('');
    await expect(page.locator('.vignette-item')).toHaveCount(0);
    console.log('✅ [Core-10] Réinitialisation via Scanner.');
  });

  // =========================================================================
  // Core-11 : Nuage barré & Robustesse bascules filtres rapides
  // =========================================================================

  test('Core-11 - Bouton Nuage Barré & Bascules Filtres Frénétiques (0 Vignette Blanche)', async ({ page }) => {
    // Garantir que Néphrologie est en cache
    const nephroCard = page.locator('.doc-card[data-doc-id="544"]');
    await expect(nephroCard).toBeVisible({ timeout: 10000 });
    const cacheBtn = nephroCard.locator('.doc-cache-btn');
    const deleteBtn = nephroCard.locator('.btn-delete-doc-cache');

    if (!await cacheBtn.evaluate(el => el.classList.contains('cached'))) {
      await cacheBtn.click();
      await expect(cacheBtn).toHaveClass(/cached/, { timeout: 35000 });
    }
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });

    // Supprimer puis remettre en cache
    page.once('dialog', d => d.accept());
    await deleteBtn.click();
    await expect(cacheBtn).not.toHaveClass(/cached/, { timeout: 8000 });
    await expect(deleteBtn).toBeHidden({ timeout: 5000 });
    console.log('✅ [Core-11] Bouton nuage barré validé.');

    await cacheBtn.click();
    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 35000 });

    // Bascules frénétiques de filtres
    await h.injectSearchQuery('grossesse');
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 15000 });

    await page.evaluate(async () => {
      const offlineCb = document.getElementById('filterOfflineOnly');
      const titlesCb  = document.getElementById('filterTitlesOnly');
      for (let i = 0; i < 4; i++) { offlineCb.click(); await new Promise(r => setTimeout(r, 80)); }
      titlesCb.click(); await new Promise(r => setTimeout(r, 80)); titlesCb.click();
      await new Promise(r => setTimeout(r, 200));
      offlineCb.click(); // remettre offline ON
    });

    await page.waitForTimeout(2000);
    await h.assertNoCropCorruption();
    console.log('✅ [Core-11] 0 vignette blanche après bascules rapides.');

    // Remettre filtre offline OFF
    const offlineCb = page.locator('#filterOfflineOnly');
    if (await offlineCb.isChecked()) await offlineCb.uncheck();
  });
});
