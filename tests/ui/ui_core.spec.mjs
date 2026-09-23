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

    // Le badge de cache de dossier a été supprimé (redondant) : la carte ne doit plus l'afficher
    await expect(martingaleFolder.locator('.folder-cache-badge')).toHaveCount(0);

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

    // Badge de dossier supprimé : la carte ne doit plus l'afficher
    await expect(folderMartingale.locator('.folder-cache-badge')).toHaveCount(0);

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

    if (!await cacheBtn.evaluate(el => el.classList.contains('cached'))) {
      await cacheBtn.click();
      await expect(cacheBtn).toHaveClass(/cached/, { timeout: 35000 });
    }

    // Supprimer puis remettre en cache via le bouton unique sans boîte de dialogue
    await cacheBtn.click();
    await expect(cacheBtn).not.toHaveClass(/cached/, { timeout: 8000 });
    console.log('✅ [Core-11] Retrait du cache sans dialogue validé.');

    await page.waitForTimeout(300);
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

  // =========================================================================
  // Core-12 : Bascules d'onglets multiples en cours de téléchargement (Isolation Cache)
  // =========================================================================

  test('Core-12 - Changements d Onglets Multiples en Cours de Téléchargement', async ({ page }) => {
    // 1. Ouvrir le dossier Martingale contenant doc 1 et doc 2
    await h.openFolder(130);
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    const doc2Card = page.locator('.doc-card[data-doc-id="2"]');
    await expect(doc1Card).toBeVisible({ timeout: 10000 });
    await expect(doc2Card).toBeVisible({ timeout: 10000 });

    // Nettoyer le cache pour s'assurer d'une progression dynamique
    await h.cleanDocCache(1);
    await h.cleanDocCache(2);

    // 2. Ouvrir Doc 1 dans le viewer
    await doc1Card.locator('.doc-title-main').click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.reader-tab-item')).toHaveCount(1);

    // Déclencher le téléchargement de Doc 1
    await page.evaluate(() => {
      if (window.downloadQueueManager) {
        window.downloadQueueManager.enqueueDocument(1);
      }
    });

    // 3. Ouvrir Doc 2 dans un deuxième onglet via window.tabManager.openTab
    await page.evaluate(() => {
      if (window.tabManager) {
        window.tabManager.openTab(2, 'Document 2', 1);
      }
      if (window.downloadQueueManager) {
        window.downloadQueueManager.enqueueDocument(2);
      }
    });

    await expect(page.locator('.reader-tab-item')).toHaveCount(2);

    // 4. Effectuer plusieurs bascules d'onglets successives pendant le téléchargement
    const tab1 = page.locator('.reader-tab-item').first();
    const tab2 = page.locator('.reader-tab-item').nth(1);

    for (let i = 0; i < 4; i++) {
      // Bascule vers tab 1
      await tab1.click();
      await expect(tab1).toHaveClass(/active/);
      await page.waitForTimeout(300);

      // Bascule vers tab 2
      await tab2.click();
      await expect(tab2).toHaveClass(/active/);
      await page.waitForTimeout(300);
    }

    // 5. Vérifier que les onglets et le viewer sont sains, avec vérification visuelle du rendu PDF
    await h.assertPdfViewerRendered();

    // Vérifier que le badge de cache est cohérent
    const badge = page.locator('#viewerCacheBadge');
    if (await badge.isVisible()) {
      const text = await badge.innerText();
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('undefined');
    }

    // Fermer l'un des onglets pour tester la stabilité
    await tab2.locator('.reader-tab-close').click();
    await expect(page.locator('.reader-tab-item')).toHaveCount(1);
    await expect(tab1).toHaveClass(/active/);

    // Re-vérifier le rendu visuel après fermeture de l'onglet
    await h.assertPdfViewerRendered();

    console.log('✅ [Core-12] Changements d onglets multiples en cours de téléchargement validés sans crash ni glitch.');
  });

  // =========================================================================
  // Core-13 : Cycle Hybride - Démarrage PDF.js, Interruption Accueil, Cache IDB,
  // Reprise Manuelle sans Duplication & 100% Cache (Vérification Visuelle Réelle)
  // =========================================================================

  test('Core-13 - Cycle Hybride : Démarrage PDF.js, Interruption Accueil, Cache IDB, Reprise Manuelle sans Duplication & 100% Cache', async ({ page }) => {
    // 1. Ouvrir le dossier Martingale (doc 1)
    await h.openFolder(130);
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 10000 });

    // Nettoyer le cache pour un test pur
    await h.cleanDocCache(1);

    // 2. Démarrage de la mise en cache dans PDF.js via ouverture du PDF dans l'UI
    await doc1Card.locator('.doc-title-main').click();

    // Vraie vérification visuelle de l'affichage du PDF et de l'interface
    const visualInfo = await h.assertPdfViewerRendered({ minCanvasWidth: 200, minCanvasHeight: 200 });
    console.log(`[Core-13] PDF.js rendu visuel validé : "${visualInfo.title}", ${visualInfo.numPages} pages, canvas ${visualInfo.canvasWidth}x${visualInfo.canvasHeight}px ✅`);

    // Laisser PDF.js télécharger ses premiers fragments
    await page.waitForTimeout(600);

    // 3. Interruption par retour à l'accueil
    const homeBtn = page.locator('#readerHomeBtn');
    await expect(homeBtn).toBeVisible();
    await homeBtn.click();

    // Vérifier que le viewer est masqué et que l'accueil est de retour
    await expect(page.locator('#viewerPane')).toBeHidden();
    await expect(page.locator('#generalView')).toBeVisible();

    // 4. Vérification du cache partiel dans IndexedDB (docseeker_pdf_chunks_v2)
    const idbStats = await page.evaluate(async () => {
      if (!window.pdfCacheManager) return null;
      return await window.pdfCacheManager.getCachedStats(1);
    });
    console.log('[Core-13] État fragments IndexedDB post-interruption :', idbStats);
    expect(idbStats).not.toBeNull();
    expect(idbStats.downloadedBytes).toBeGreaterThan(0);

    // 5. Clic sur le bouton de mise en cache manuel (Style iCloud Sync)
    const cacheBtn = doc1Card.locator('.doc-cache-btn');
    await expect(cacheBtn).toBeVisible();
    await cacheBtn.click();

    // 6. Vérification qu'il n'y a pas de duplication et qu'à la fin tout est en cache à 100%
    await h.downloadDocToComplete(1, 30000);
    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 10000 });

    const finalStats = await page.evaluate(async () => {
      if (!window.pdfCacheManager) return null;
      return await window.pdfCacheManager.getCachedStats(1);
    });
    expect(finalStats.status).toBe('complete');
    expect(finalStats.progress).toBe(100);
    console.log(`[Core-13] Document 1 finalisé à 100% dans IndexedDB (${finalStats.downloadedBytes} octets) ✅`);

    // 7. Rouvrir le document et vérifier visuellement le rendu instantané depuis le cache local
    await doc1Card.locator('.doc-title-main').click();
    const finalVisual = await h.assertPdfViewerRendered({ minCanvasWidth: 200, minCanvasHeight: 200 });
    console.log(`[Core-13] Réouverture post-cache 100% validée visuellement : canvas ${finalVisual.canvasWidth}x${finalVisual.canvasHeight}px ✅`);

    console.log('✅ [Core-13] Cycle hybride PDF.js -> Interruption -> Reprise Manuelle validé avec succès.');
  });

  // =========================================================================
  // Core-14 : Suppression du Cache depuis le Badge du Reader en Plein Téléchargement
  // =========================================================================

  test('Core-14 - Suppression du Cache depuis le Badge du Reader en Plein Téléchargement', async ({ page }) => {
    // 1. Ouvrir le dossier Martingale
    await h.openFolder(130);
    const doc2Card = page.locator('.doc-card[data-doc-id="2"]');
    await expect(doc2Card).toBeVisible({ timeout: 10000 });

    // Nettoyer le cache
    await h.cleanDocCache(2);

    // 2. Ouvrir Doc 2 dans le viewer
    await doc2Card.locator('.doc-title-main').click();
    await h.assertPdfViewerRendered();

    // Déclencher le téléchargement
    await page.evaluate(() => {
      if (window.downloadQueueManager) {
        window.downloadQueueManager.enqueueDocument(2);
      }
    });

    const badge = page.locator('#viewerCacheBadge');
    await expect(badge).toBeVisible({ timeout: 10000 });

    // 3. Cliquer sur le badge de cache pour déclencher la suppression en plein téléchargement sans dialogue
    await badge.click();

    // 4. Vérifier que le cache est purgé et que le badge passe à l'état cloud (non téléchargé)
    await expect(badge).toHaveClass(/cloud/, { timeout: 10000 });
    await h.assertPdfViewerRendered();

    console.log('✅ [Core-14] Suppression du cache depuis le badge viewer en cours de téléchargement validée.');
  });

  // =========================================================================
  // Core-15 : Non-Héritage de la Recherche Intra-Document entre Onglets
  // (Régression du bug : la recherche « Y » tapée dans B rejouée sur A)
  // =========================================================================

  test('Core-15 - Aucun Héritage de Recherche Intra-Doc entre Documents (Onglets A/B)', async ({ page }) => {
    // 1. Recherche globale "grossesse" (contexte : l'état global est alimenté)
    await h.search('grossesse');
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 10000 });

    // 2. Ouvrir le PDF B (doc 1) via vignette — hérite de la recherche globale (comportement voulu)
    await doc1Card.locator('.vignette-item').first().click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#inDocDrawerSearchInput')).toHaveValue(/grossesse/, { timeout: 10000 });

    // 3. Taper « Y » (= complication) dans la recherche intra-doc de B
    const drawerInput = page.locator('#inDocDrawerSearchInput');
    await drawerInput.fill('complication');
    await drawerInput.press('Enter');
    await expect(page.locator('#viewerDocSearchResultCount')).toContainText('résultat', { timeout: 10000 });
    await expect(drawerInput).toHaveValue('complication');
    // Garde-fou anti-erreur silencieuse : les extraits doivent être réellement rendus
    // (dans le tiroir visible ; #docOccurrencesList desktop vit dans #resultsPane, masqué en vue doc)
    await expect(page.locator('#inDocDrawerOccurrencesList .vertical-occ-card').first()).toBeVisible({ timeout: 10000 });

    // 4. Ouvrir le PDF A (doc 3) dans un 2e onglet SANS recherche explicite
    await page.evaluate(() => window.tabManager.openTab(3, 'Document 3', 1));
    await expect(page.locator('.reader-tab-item')).toHaveCount(2);
    await page.waitForTimeout(2500);

    // 5. ASSERTIONS CLÉS — A ne doit PAS hériter de « complication »
    await expect(page.locator('#inDocDrawerSearchInput')).not.toHaveValue('complication');
    const frameUrl = await page.evaluate(() => document.getElementById('pdfFrame')?.contentWindow?.location?.href || '');
    expect(frameUrl).not.toMatch(/search=[^&]/);

    const overlayCount = await page.evaluate(() =>
      document.getElementById('pdfFrame')?.contentWindow?.document.querySelectorAll('.active-occ-overlay').length ?? 0
    );
    expect(overlayCount).toBe(0);

    // 6. Recherche explicitement relancée sur A : doit fonctionner normalement
    const drawerInputA = page.locator('#inDocDrawerSearchInput');
    await drawerInputA.fill('grossesse');
    await drawerInputA.press('Enter');
    await page.waitForTimeout(1500);
    await expect(page.locator('#viewerDocSearchResultCount')).toContainText('résultat', { timeout: 10000 });
    await expect(drawerInputA).toHaveValue('grossesse');

    // 7. Retour sur l'onglet B : B doit restaurer SA recherche (complication), pas celle de A
    const tabB = page.locator('.reader-tab-item').first();
    await tabB.click();
    await page.waitForTimeout(2000);
    await expect(page.locator('#inDocDrawerSearchInput')).toHaveValue('complication', { timeout: 10000 });
    await expect(page.locator('#viewerDocSearchResultCount')).toContainText('résultat');

    console.log('✅ [Core-15] Recherche intra-doc isolée par onglet : A vierge, recherche relancée OK, B restauré avec « complication ».');
  });

  // =========================================================================
  // Core-16 : Persistance des onglets ouverts (opt-in, localStorage)
  // Rouvrir la page → mêmes onglets, même recherche, même position.
  // =========================================================================

  test('Core-16 - Persistance des Onglets Ouverts : Recherche et Position Restaurées', async ({ page }) => {
    // L'opt-in est piloté par la checkbox des Réglages ; on l'actionne par
    // clic JS (en mode lecture, la vue Réglages est à largeur nulle côté CSS —
    // hors sujet ici : le test vise la persistance, pas le layout du volet).
    const togglePersist = () => page.evaluate(() => document.getElementById('settingsPersistTabs')?.click());

    // 1. Activer l'opt-in
    await togglePersist();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('docseeker_persist_tabs_enabled')), { timeout: 5000 })
      .toBe('1');

    // 2. Ouvrir un document (séquence Core-15 : la recherche globale alimente
    // les vignettes de la carte) et lancer une recherche intra-doc
    await h.search('grossesse');
    const docCard = page.locator('.doc-card[data-doc-id="1"]');
    await expect(docCard).toBeVisible({ timeout: 10000 });
    await docCard.locator('.vignette-item').first().click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });
    const drawerInput = page.locator('#inDocDrawerSearchInput');
    await drawerInput.fill('grossesse');
    await drawerInput.press('Enter');
    await expect(page.locator('#viewerDocSearchResultCount')).toContainText('résultat', { timeout: 10000 });

    // 3. Recharger : le snapshot doit exister et l'onglet doit être restauré
    await expect.poll(() => page.evaluate(() => !!localStorage.getItem('docseeker_open_tabs_snapshot')), { timeout: 10000 }).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });

    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.reader-tab-item')).toHaveCount(1);
    await expect(page.locator('#inDocDrawerSearchInput')).toHaveValue('grossesse', { timeout: 15000 });
    await expect(page.locator('#viewerDocSearchResultCount')).toContainText('résultat', { timeout: 15000 });
    // La recherche relancée produit de vraies occurrences + surbrillance PDF.js
    // (poll : le dispatch « find » suit la restauration de quelques centaines de ms)
    await expect
      .poll(() => page.evaluate(() => {
        try { return document.getElementById('pdfFrame').contentWindow.PDFViewerApplication.findController?.state?.query?.[0] || null; } catch { return null; }
      }), { timeout: 15000 })
      .toBe('grossesse');

    // 4. Désactiver l'opt-in → snapshot purgé, pas de restauration au prochain chargement
    await togglePersist();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('docseeker_persist_tabs_enabled')), { timeout: 5000 })
      .toBe(null);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('docseeker_open_tabs_snapshot'))).toBe(null);
    console.log('✅ [Core-16] Persistance des onglets : restauration complète, purge correcte à la désactivation.');
  });

  // =========================================================================
  // Core-17 : Masquage de la barre d'onglets — gain de hauteur RÉEL
  // (Régression du bug : translateY laissait un bandeau blanc de 40px — la
  // barre doit être RETIRÉE DU FLUX et le workspace passer à hauteur pleine.)
  // =========================================================================

  test('Core-17 - Masquage Barre d Onglets : Workspace à Hauteur Pleine + Bouton de Rappel', async ({ page }) => {
    // 1. Ouvrir un document (séquence Core-15 : la recherche globale alimente les vignettes)
    await h.search('grossesse');
    const docCard = page.locator('.doc-card[data-doc-id="1"]');
    await expect(docCard).toBeVisible({ timeout: 10000 });
    await docCard.locator('.vignette-item').first().click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.reader-top-tab-bar')).toBeVisible({ timeout: 10000 });

    // 2. Mesures AVANT masquage : la barre occupe ~40px dans le flux
    const before = await page.evaluate(() => ({
      vh: window.innerHeight,
      ws: document.querySelector('.main-workspace')?.getBoundingClientRect().height ?? 0,
      bar: document.querySelector('.reader-top-tab-bar')?.getBoundingClientRect().height ?? 0,
      restoreVisible: getComputedStyle(document.getElementById('readerTabBarRestoreBtn')).display !== 'none',
    }));
    expect(before.vh).toBeGreaterThan(400);
    expect(before.bar).toBeGreaterThan(30); // la barre occupe bien une ligne
    expect(before.restoreVisible).toBe(false); // le rappel est caché tant que la barre est là

    // 3. Masquer via le chevron de la barre lecteur
    await page.locator('#toggleTabBarBtn').click();
    const hidden = await page.evaluate(() => ({
      bodyFlag: document.body.classList.contains('tabbar-hidden'),
      barDisplay: getComputedStyle(document.querySelector('.reader-top-tab-bar')).display,
      barRect: document.querySelector('.reader-top-tab-bar')?.getBoundingClientRect().height ?? 0,
      ws: document.querySelector('.main-workspace')?.getBoundingClientRect().height ?? 0,
      restoreVisible: getComputedStyle(document.getElementById('readerTabBarRestoreBtn')).display !== 'none',
    }));
    expect(hidden.bodyFlag).toBe(true);
    expect(hidden.barDisplay).toBe('none'); // RETIRÉE DU FLUX (pas seulement translée)
    expect(hidden.barRect).toBe(0); // aucune trace dans le layout
    expect(hidden.restoreVisible).toBe(true); // le rappel est apparu
    // Le gain doit être ~exactement la hauteur de la barre (±2px de subpixel) :
    // c'est l'assertion qui aurait attrapé le bug du bandeau blanc (gain 0).
    expect(hidden.ws - before.ws).toBeGreaterThanOrEqual(before.bar - 2);
    expect(Math.abs(hidden.ws + 0 - before.vh)).toBeLessThanOrEqual(2); // workspace = plein écran

    // 4. Restaurer via le petit bouton de rappel fixe
    await page.locator('#readerTabBarRestoreBtn').click();
    const restored = await page.evaluate(() => ({
      bodyFlag: document.body.classList.contains('tabbar-hidden'),
      barDisplay: getComputedStyle(document.querySelector('.reader-top-tab-bar')).display,
      ws: document.querySelector('.main-workspace')?.getBoundingClientRect().height ?? 0,
      restoreVisible: getComputedStyle(document.getElementById('readerTabBarRestoreBtn')).display !== 'none',
    }));
    expect(restored.bodyFlag).toBe(false);
    expect(restored.barDisplay).not.toBe('none');
    expect(restored.restoreVisible).toBe(false);
    expect(Math.abs(restored.ws - before.ws)).toBeLessThanOrEqual(2); // hauteur d'origine retrouvée

    console.log(`✅ [Core-17] Masquage barre : workspace ${Math.round(before.ws)}px → ${Math.round(hidden.ws)}px (+${Math.round(hidden.ws - before.ws)}px réels), rappel fonctionnel.`);
  });
});

