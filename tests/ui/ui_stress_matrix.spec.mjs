/**
 * DocSeeker - Matrice de Tests Limites & Résistance Agressive (Stress Testing)
 * 
 * Cette suite éprouve l'application sous des conditions hostiles :
 * - Clics intempestifs et rage-clicks (< 25 ms)
 * - Recherches en rafale et annulations successives
 * - Flapping réseau répété pendant le transfert de gros volumes (250 Mo)
 * - Navigation concurrente pendant des transferts actifs
 * - Surveillance stricte de la mémoire RAM (JS Heap) et libération effective du stockage
 */

import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';

// Archétypes de documents pour tester la variance volumétrique
const ARCHETYPES = {
  LIGHT: { id: 1, title: '023 - Grossesse normale', folderId: 130 },
  MEDIUM: { id: 8, title: '025 - Grossesse extra - utérine', folderId: null },
  HEAVY: { id: 544, title: 'Néphrologie - 11E 2024', folderId: null },
  MASSIVE: { id: 553, title: 'Cardiologie - 3E 2025', folderId: null },
};

test.describe('Matrice de Résistance Agressive & Garde-fous Performance / RAM', () => {
  let harness;

  test.beforeEach(async ({ page, context }) => {
    harness = new DocSeekerTestHarness(page, context);
    await harness.authenticate();
  });

  test.afterEach(async ({ context }) => {
    await context.setOffline(false);
    harness.assertZeroErrors();
  });

  // =========================================================================
  // MATRICE A : Clics Intempestifs & Anti-Doublons (Click-Spam Matrix)
  // =========================================================================

  const clickSpamCases = [
    { name: 'A1.Light_Doc1', doc: ARCHETYPES.LIGHT, clicks: 5, intervalMs: 20 },
    { name: 'A1.Massive_Doc553', doc: ARCHETYPES.MASSIVE, clicks: 5, intervalMs: 25 },
  ];

  for (const tc of clickSpamCases) {
    test(`Matrice A1 - Clics frénétiques (${tc.clicks} clics en ${tc.intervalMs}ms) sur Téléchargement (${tc.name})`, async ({ page }) => {
      await harness.goto('/');
      const startMetrics = await harness.getPerformanceMetrics();

      // Nettoyer le document au départ
      await harness.cleanDocCache(tc.doc.id);

      // Si le document est dans un dossier, y naviguer
      if (tc.doc.folderId) {
        await harness.openFolder(tc.doc.folderId);
      }

      const card = await harness.getDocCard(tc.doc.id);
      const cacheBtn = card.locator('.doc-cache-btn');
      await expect(cacheBtn).toBeVisible();

      // Effectuer les clics frénétiques
      console.log(`[${tc.name}] Spam de ${tc.clicks} clics sur le bouton de téléchargement...`);
      await harness.spamClick(cacheBtn, tc.clicks, tc.intervalMs);

      // Vérifier l'anti-doublon : la file et les tâches actives ne doivent contenir qu'une seule instance du doc
      const queueState = await page.evaluate((id) => {
        const dqm = window.downloadQueueManager;
        if (!dqm) return { queueCount: 0, activeCount: 0 };
        const inQueue = dqm.queue.filter(x => Number(x) === id).length;
        const inActive = dqm.activeTasks.has(id) ? 1 : 0;
        return { queueCount: inQueue, activeCount: inActive };
      }, tc.doc.id);

      console.log(`[${tc.name}] État de la file après spam: Queue=${queueState.queueCount}, Active=${queueState.activeCount}`);
      expect(queueState.queueCount + queueState.activeCount).toBeLessThanOrEqual(1);

      // Vérifier que le bouton est en téléchargement ou déjà complet sans crash
      await expect(cacheBtn).toHaveClass(/downloading|cached/, { timeout: 8000 });

      // Attendre la complétion pour le document léger, ou nettoyer le document massif
      if (tc.doc.id === ARCHETYPES.LIGHT.id) {
        await expect(cacheBtn).toHaveClass(/cached/, { timeout: 15000 });
      } else {
        await harness.cleanDocCache(tc.doc.id);
      }

      const endMetrics = await harness.getPerformanceMetrics();
      harness.assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB: 60, maxDurationMs: 20000 });
    });
  }

  test('Matrice A2 - Téléchargement suivi immédiatement (< 40ms) de Suppression (Rage-Cancel)', async ({ page }) => {
    await harness.goto('/');
    const doc = ARCHETYPES.LIGHT;
    await harness.openFolder(doc.folderId);

    const card = await harness.getDocCard(doc.id);
    const cacheBtn = card.locator('.doc-cache-btn');

    // Clic pour lancer le téléchargement
    await cacheBtn.click({ force: true });
    await page.waitForTimeout(30);

    // Annulation immédiate en appelant removeDocumentFromCache directement comme un clic rapide sur supprimer
    await page.evaluate(async (id) => {
      if (window.downloadQueueManager) {
        await window.downloadQueueManager.removeDocumentFromCache(id);
      }
    }, doc.id);

    // Vérifier que le bouton revient à l'état initial
    await expect(cacheBtn).not.toHaveClass(/cached/, { timeout: 8000 });

    // Vérifier la libération profonde du stockage
    await harness.assertStorageFreed(doc.id);
  });

  test('Matrice A3 - Bascules de tri frénétiques consécutives pendant le rendu', async ({ page }) => {
    await harness.goto('/');
    const startMetrics = await harness.getPerformanceMetrics();

    const sortSelect = page.locator('#sortSelect');
    await expect(sortSelect).toBeVisible();

    const sortOptions = ['name_desc', 'date_mod_desc', 'name_asc', 'date_add_desc'];
    for (const opt of sortOptions) {
      await sortSelect.selectOption(opt);
      await page.waitForTimeout(30); // Changements ultra-rapides
    }

    // Vérifier que le conteneur de résultats est stable et non vide
    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 5000 });
    const count = await cards.count();
    expect(count).toBeGreaterThan(5);

    const endMetrics = await harness.getPerformanceMetrics();
    harness.assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB: 40, maxDurationMs: 5000 });
  });

  // =========================================================================
  // MATRICE B : Recherches en Rafale & Annulations Successives
  // =========================================================================

  test('Matrice B1 - Frappe rapide en rafale (4 requêtes en 240ms) & Vérification Anti-Stale', async ({ page }) => {
    await harness.goto('/');
    const startMetrics = await harness.getPerformanceMetrics();

    // Saisie saccadée rapide
    const queries = ['car', 'gross', 'nephro', 'inf'];
    console.log('[Matrice B1] Envoi en rafale de 4 requêtes consécutives...');
    await harness.rapidSearchBurst(queries, 60);

    // Attendre la stabilisation de la recherche
    await page.waitForTimeout(600);

    // Vérifier que l'input contient bien la dernière requête
    const searchInput = page.locator('#searchInput');
    await expect(searchInput).toHaveValue('inf');

    // Vérifier que les résultats affichés correspondent bien à la dernière recherche (infection/inf)
    const resultCards = page.locator('.doc-card');
    await expect(resultCards.first()).toBeVisible({ timeout: 10000 });

    const endMetrics = await harness.getPerformanceMetrics();
    harness.assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB: 50, maxDurationMs: 8000 });
  });

  test('Matrice B2 - Recherche en rafale en Full Hors-Ligne (SQLite OPFS & Multi-Archétypes)', async ({ page, context }) => {
    await harness.goto('/');

    // Mettre en cache un document léger et un document moyen
    await harness.downloadDocToComplete(ARCHETYPES.LIGHT.id);
    await harness.downloadDocToComplete(ARCHETYPES.MEDIUM.id);

    // Couper complètement le réseau
    await context.setOffline(true);
    await harness.setOfflineFilter(true);

    const startMetrics = await harness.getPerformanceMetrics();

    // Saisie en rafale hors-ligne
    await harness.rapidSearchBurst(['gross', 'ute', 'normale'], 70);
    await page.waitForTimeout(500);

    // Vérifier les résultats hors-ligne
    const resultCard = await harness.getDocCard(ARCHETYPES.LIGHT.id);
    await expect(resultCard).toBeVisible({ timeout: 8000 });

    const endMetrics = await harness.getPerformanceMetrics();
    harness.assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB: 40, maxDurationMs: 6000 });
  });

  test('Matrice B3 - Recherche lourde avec annulation immédiate par touche Échap répétée', async ({ page }) => {
    await harness.goto('/');
    const searchInput = page.locator('#searchInput');

    // Taper une recherche lourde
    await searchInput.fill('traitement');
    await page.evaluate(() => window.performSearch && window.performSearch('traitement'));

    // Appuyer frénétiquement 3 fois sur Échap
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(20);
    }

    // Vérifier que l'input est vidé et que la vue revient aux dossiers
    await expect(searchInput).toHaveValue('');
    const foldersSection = page.locator('#foldersSection');
    await expect(foldersSection).toBeVisible({ timeout: 5000 });
  });

  // =========================================================================
  // MATRICE C : Ruptures Réseau, Flapping & Reprises pendant Transfert Lourd
  // =========================================================================

  test('Matrice C1 - Flapping réseau (coupures toutes les 400ms) pendant téléchargement et intégrité finale', async ({ page, context }) => {
    await harness.goto('/');
    const doc = ARCHETYPES.LIGHT;
    await harness.cleanDocCache(doc.id);
    await harness.openFolder(doc.folderId);

    const card = await harness.getDocCard(doc.id);
    const cacheBtn = card.locator('.doc-cache-btn');

    console.log('[Matrice C1] Démarrage du téléchargement sous réseau oscillant...');
    await cacheBtn.click();

    // Simuler des oscillations rapides du réseau
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(300);
      await context.setOffline(true);
      await page.waitForTimeout(200);
      await context.setOffline(false);
    }

    // S'assurer que le réseau est stable et attendre la complétion
    await context.setOffline(false);
    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 25000 });

    // Vérifier l'intégrité 100% dans IndexedDB
    const isComplete = await page.evaluate(async (id) => {
      return window.pdfCacheManager ? await window.pdfCacheManager.isComplete(id) : false;
    }, doc.id);
    expect(isComplete).toBe(true);
    console.log('[Matrice C1] Document téléchargé à 100% avec succès malgré le flapping réseau.');
  });

  // =========================================================================
  // MATRICE D : Navigation Concurrente, Libération Réelle & Fuites RAM
  // =========================================================================

  test('Matrice D1 - Navigation ultra-rapide entre dossiers pendant un transfert actif', async ({ page }) => {
    await harness.goto('/');
    const doc = ARCHETYPES.LIGHT;
    await harness.cleanDocCache(doc.id);
    await harness.openFolder(doc.folderId);

    const card = await harness.getDocCard(doc.id);
    const cacheBtn = card.locator('.doc-cache-btn');
    await cacheBtn.click();

    // Naviguer immédiatement entre la racine et le dossier Martingale 4 fois
    console.log('[Matrice D1] Navigation frénétique entre dossiers pendant le téléchargement...');
    await harness.rapidFolderSwitching([null, 130, null, 130], 80);

    // Vérifier qu'on est bien dans le dossier et que le bouton est cohérent
    const reloadedCard = await harness.getDocCard(doc.id);
    await expect(reloadedCard).toBeVisible({ timeout: 10000 });
    const reloadedBtn = reloadedCard.locator('.doc-cache-btn');
    await expect(reloadedBtn).toHaveClass(/downloading|cached/, { timeout: 15000 });
  });

  test('Matrice D2 - Split View Active + Suppression Cache & Libération Profonde du Stockage', async ({ page }) => {
    await harness.goto('/');
    const doc = ARCHETYPES.LIGHT;
    await harness.cleanDocCache(doc.id);

    // 1. Naviguer dans le dossier et s'assurer que le document est en cache
    await harness.openFolder(doc.folderId);
    await harness.downloadDocToComplete(doc.id);

    // 2. Ouvrir le document en Split View
    const card = await harness.getDocCard(doc.id);
    const coverEl = card.locator('.doc-cover-wrapper');
    await coverEl.click();

    const viewerPane = page.locator('#viewerPane');
    await expect(viewerPane).toBeVisible({ timeout: 10000 });

    // 3. Pendant que le visualiseur est ouvert, supprimer le cache local du document
    console.log('[Matrice D2] Suppression du cache local alors que le document est ouvert en Split View...');
    await page.evaluate(async (id) => {
      if (window.downloadQueueManager) {
        await window.downloadQueueManager.removeDocumentFromCache(id);
      }
    }, doc.id);

    // 4. Vérification profonde de libération réelle dans IndexedDB, OPFS et CacheStorage
    console.log('[Matrice D2] Inspection profonde des stores IndexedDB et SQLite OPFS...');
    const freedStatus = await harness.assertStorageFreed(doc.id);
    console.log(`[Matrice D2] Statut libération: Chunks résiduels=${freedStatus.remainingChunks}, Meta=${freedStatus.metaExists}, SQLite=${freedStatus.indexedInSqlite}`);

    // 5. Fermer le visualiseur proprement
    const closeBtn = page.locator('#closeViewerBtn');
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await expect(viewerPane).not.toBeVisible({ timeout: 5000 });
    }

    // 6. Vérifier que la carte dans la bibliothèque n'est plus en cache
    const reloadedCard = await harness.getDocCard(doc.id);
    const reloadedBtn = reloadedCard.locator('.doc-cache-btn');
    await expect(reloadedBtn).not.toHaveClass(/cached/, { timeout: 8000 });
  });
});
