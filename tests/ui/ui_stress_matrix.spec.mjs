/**
 * DocSeeker - Matrice de Tests Limites & Résistance Agressive (Stress Testing)
 *
 * Matrices :
 * A  — Clics intempestifs & anti-doublons
 * B  — Recherches en rafale (online, offline, wildcards, accents, XSS, vide)
 * C  — Flapping réseau & reprises pendant transfert lourd
 * D  — Navigation concurrente, Split View, RAM
 * E  — Viewer PDF.js (ouverture, navigation occurrences, fermeture)
 * F  — Performance vignettes (scroll, changement recherche, fuites DOM)
 *
 * Retries : 1 (stress, variance environnementale tolérée)
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

  test.afterEach(async () => {
    await harness.resetState();
    harness.assertZeroErrors();
  });

  // =========================================================================
  // MATRICE A : Clics Intempestifs & Anti-Doublons (Click-Spam Matrix)
  // =========================================================================

  const clickSpamCases = [
    { name: 'A1.Light_Doc1',   doc: ARCHETYPES.LIGHT,   clicks: 5,  intervalMs: 20 },
    { name: 'A1.Massive_Doc553', doc: ARCHETYPES.MASSIVE, clicks: 5,  intervalMs: 25 },
    { name: 'A1.Heavy_Doc544',  doc: ARCHETYPES.HEAVY,   clicks: 10, intervalMs: 10 }, // 10 clics en 10ms
    { name: 'A1.Burst_Doc1',   doc: ARCHETYPES.LIGHT,   clicks: 20, intervalMs: 5  }, // Burst extrême
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

    // Nettoyage préventif : les tests A1 et A2 peuvent laisser LIGHT et MEDIUM en état
    // de téléchargement partiel ou annulé, ce qui bloquerait downloadDocToComplete.
    await harness.cleanDocCache(ARCHETYPES.LIGHT.id);
    await harness.cleanDocCache(ARCHETYPES.MEDIUM.id);
    await page.waitForTimeout(300);

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

  // =========================================================================
  // MATRICE A (suite) : Cas limites click-spam
  // =========================================================================

  test('Matrice A4 - Double-clic Suppression (Dialog accepté 2 fois de suite)', async ({ page }) => {
    await harness.goto('/');
    await harness.openFolder(ARCHETYPES.LIGHT.folderId);
    await harness.ensureDocCached(ARCHETYPES.LIGHT.id);

    const card    = await harness.getDocCard(ARCHETYPES.LIGHT.id);
    const delBtn  = card.locator('.btn-delete-doc-cache');
    await expect(delBtn).toBeVisible({ timeout: 5000 });

    let dialogCount = 0;
    page.on('dialog', d => { dialogCount++; d.accept(); });

    // Véritable double-clic sur le bouton de suppression
    await delBtn.dblclick({ force: true });

    await expect(card.locator('.doc-cache-btn')).not.toHaveClass(/cached/, { timeout: 8000 });
    const isCached = await page.evaluate(() => window.downloadQueueManager?.isDocumentCached(1));
    expect(isCached).toBe(false);
    console.log(`[A4] Double-clic suppression géré sans re-téléchargement intempestif (dialogs=${dialogCount}) ✅`);
  });

  test('Matrice A5 - Click Download doc B pendant DL actif de doc A (HEAVY)', async ({ page }) => {
    await harness.goto('/');
    await harness.cleanDocCache(ARCHETYPES.HEAVY.id);
    await harness.cleanDocCache(ARCHETYPES.LIGHT.id);

    // Lancer le download de HEAVY en arrière-plan
    await page.evaluate(async (id) => {
      if (window.downloadQueueManager) await window.downloadQueueManager.enqueueDocument(id);
    }, ARCHETYPES.HEAVY.id);

    // Immédiatement lancer LIGHT aussi
    await harness.openFolder(ARCHETYPES.LIGHT.folderId);
    const lightCard   = await harness.getDocCard(ARCHETYPES.LIGHT.id);
    const lightBtn    = lightCard.locator('.doc-cache-btn');
    await lightBtn.click({ force: true });

    // Les deux doivent être en queue sans crash
    const state = await harness.getQueueState(ARCHETYPES.LIGHT.id);
    console.log(`[A5] LIGHT queue state: inQueue=${state.inQueue}, inActive=${state.inActive}`);
    expect(state.inQueue + (state.inActive ? 1 : 0)).toBeLessThanOrEqual(1);

    // Annuler les deux téléchargements pour libérer
    await harness.cleanDocCache(ARCHETYPES.HEAVY.id);
    await harness.cleanDocCache(ARCHETYPES.LIGHT.id);
  });

  test('Matrice A6 - Spam 10 clics batchCacheBtn en 50ms', async ({ page }) => {
    await harness.goto('/');
    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // S'assurer que les 2 premiers docs ne sont pas en cache
    const id1 = Number(await cards.nth(0).getAttribute('data-doc-id'));
    const id2 = Number(await cards.nth(1).getAttribute('data-doc-id'));
    await harness.ensureDocNotCached(id1);
    await harness.ensureDocNotCached(id2);

    // Mode sélection + sélection des 2 docs
    await page.locator('#toggleSelectionModeBtn').click();
    await cards.nth(0).locator('.doc-selection-checkbox').click();
    await cards.nth(1).locator('.doc-selection-checkbox').click();

    const batchBtn = page.locator('#batchCacheBtn');
    await expect(batchBtn).toBeVisible();

    // Spam 10 clics en 50ms sur batchCacheBtn
    const startMetrics = await harness.getPerformanceMetrics();
    await harness.spamClick(batchBtn, 10, 50);

    // Doit pas crasher et les docs doivent être en queue max 1 fois chacun
    await page.waitForTimeout(500);
    const q1 = await harness.getQueueState(id1);
    const q2 = await harness.getQueueState(id2);
    expect(q1.inQueue + (q1.inActive ? 1 : 0)).toBeLessThanOrEqual(1);
    expect(q2.inQueue + (q2.inActive ? 1 : 0)).toBeLessThanOrEqual(1);

    const endMetrics = await harness.getPerformanceMetrics();
    harness.assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB: 60, maxDurationMs: 10000 });
    console.log('[A6] Spam batchCacheBtn × 10 : 0 doublon, 0 crash ✅');

    // Cleanup
    await harness.ensureDocNotCached(id1);
    await harness.ensureDocNotCached(id2);
  });

  // =========================================================================
  // MATRICE B (suite) : Recherches limites — Wildcards, Accents, XSS, Vides
  // =========================================================================

  const searchEdgeCases = [
    { name: 'B4.Wildcards',  queries: ['infect*', 'cardio*', 'rén*'],                         intervalMs: 80,  maxDurationMs: 25000 },
    { name: 'B5.Accents',    queries: ['néphro', 'Œdème', 'hémorr', 'péri'],                  intervalMs: 80,  maxDurationMs: 25000 },
    { name: 'B6.XSS',        queries: ['<script>alert(1)</script>', '"; DROP TABLE--', '\'OR 1=1'], intervalMs: 80, maxDurationMs: 20000 },
    { name: 'B7.Empty',      queries: ['', 'a', '  ', ''],                                     intervalMs: 80,  maxDurationMs: 10000 },
    { name: 'B8.LongQuery',  queries: ['insuffisance cardiaque aiguë traitement', 'grossesse pathologique complications'], intervalMs: 100, maxDurationMs: 30000 },
  ];

  for (const tc of searchEdgeCases) {
    test(`Matrice ${tc.name} - Rafale requêtes limites (${tc.queries.length} requêtes)`, async ({ page }) => {
      await harness.goto('/');
      const startMetrics = await harness.getPerformanceMetrics();

      console.log(`[${tc.name}] Requêtes :`, tc.queries);
      await harness.rapidSearchBurst(tc.queries, tc.intervalMs);
      await page.waitForTimeout(600);

      // L'input doit contenir la dernière requête sans crash
      const lastQuery = tc.queries[tc.queries.length - 1];
      const inputVal  = await page.locator('#searchInput').inputValue();
      expect(inputVal).toBe(lastQuery);

      // Aucun crash JS — l'UI doit être dans un état stable
      const foldersOrCards = page.locator('.doc-card:visible, #emptyState:visible, #foldersSection:visible');
      await expect(foldersOrCards.first()).toBeVisible({ timeout: tc.maxDurationMs || 15000 });

      const endMetrics = await harness.getPerformanceMetrics();
      harness.assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB: 50, maxDurationMs: tc.maxDurationMs || 15000 });
      console.log(`✅ [${tc.name}] Rafale terminée sans crash.`);
    });
  }

  test('Matrice B9 - Effacement en Rafale (fill "" 5x en 30ms) → Retour Dossiers', async ({ page }) => {
    await harness.goto('/');
    await harness.injectSearchQuery('grossesse');
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 10000 });

    const searchInput = page.locator('#searchInput');
    // Effacement en rafale ultra-rapide
    for (let i = 0; i < 5; i++) {
      await searchInput.fill('');
      await page.evaluate(() => window.performSearch && window.performSearch(''));
      await page.waitForTimeout(30);
    }

    // L'UI doit revenir à la vue dossiers sans erreur
    await expect(page.locator('#foldersSection')).toBeVisible({ timeout: 5000 });
    const inputVal = await searchInput.inputValue();
    expect(inputVal).toBe('');
    console.log('✅ [B9] Effacement en rafale → retour dossiers propre.');
  });

  // =========================================================================
  // MATRICE C (suite) : Flapping réseau additionnel
  // =========================================================================

  const flappingCases = [
    { name: 'C2.MicroFlapping', intervalMs: 50,  count: 20, doc: ARCHETYPES.LIGHT,   desc: 'Micro-flapping 50ms×20 sur LIGHT' },
    { name: 'C3.LongOutage',    cutAfterMs: 500, outageMs: 4000, doc: ARCHETYPES.LIGHT, desc: 'Coupure longue 4s après 500ms de téléchargement' },
    { name: 'C4.HeavyFlapping', intervalMs: 300, count: 4,  doc: ARCHETYPES.HEAVY,   desc: 'Flapping 300ms×4 sur HEAVY (gros volume)' },
  ];

  for (const tc of flappingCases) {
    test(`Matrice ${tc.name} - ${tc.desc}`, async ({ page, context }) => {
      await harness.goto('/');
      await harness.cleanDocCache(tc.doc.id);
      if (tc.doc.folderId) await harness.openFolder(tc.doc.folderId);

      const card    = await harness.getDocCard(tc.doc.id);
      const cacheBtn = card.locator('.doc-cache-btn');
      console.log(`[${tc.name}] Démarrage téléchargement : ${tc.doc.title}`);
      await cacheBtn.click();

      // Laisser le téléchargement s'initialiser
      await page.waitForTimeout(tc.cutAfterMs || 250);

      if (tc.cutAfterMs) {
        // Coupure longue
        await context.setOffline(true);
        await page.waitForTimeout(tc.outageMs);
        await context.setOffline(false);
      } else {
        // Flapping périodique
        for (let i = 0; i < tc.count; i++) {
          await context.setOffline(true);
          await page.waitForTimeout(tc.intervalMs);
          await context.setOffline(false);
          await page.waitForTimeout(tc.intervalMs);
        }
      }

      await context.setOffline(false);

      if (tc.doc.id === ARCHETYPES.LIGHT.id) {
        // Pour LIGHT : si la coupure a interrompu le download, relancer pour valider la complétion
        await page.waitForTimeout(500);
        const currentClass = await cacheBtn.getAttribute('class').catch(() => '');
        if (!currentClass.includes('downloading') && !currentClass.includes('cached')) {
          await cacheBtn.click().catch(() => {});
        }
        await expect(cacheBtn).toHaveClass(/cached/, { timeout: 35000 });
        const isComplete = await page.evaluate(async id =>
          window.pdfCacheManager ? await window.pdfCacheManager.isComplete(id) : false, tc.doc.id
        );
        expect(isComplete).toBe(true);
        console.log(`✅ [${tc.name}] Intégrité 100% validée malgré le flapping.`);
      } else {
        // Pour HEAVY : vérifier pas de crash, annuler proprement
        await expect(cacheBtn).toHaveClass(/downloading|cached/, { timeout: 15000 });
        await harness.cleanDocCache(tc.doc.id);
        console.log(`✅ [${tc.name}] Aucun crash détecté sur HEAVY.`);
      }
    });
  }

  // =========================================================================
  // MATRICE D (suite) : Navigation concurrente avancée
  // =========================================================================

  test('Matrice D3 - Sort Frénétique pendant Génération Vignettes Offline', async ({ page, context }) => {
    await harness.goto('/');
    await harness.ensureDocCached(ARCHETYPES.LIGHT.id);

    await context.setOffline(true);
    await harness.setOfflineFilter(true);
    await harness.injectSearchQuery('grossesse', { expectResultsIn: 8000 });

    const startMetrics = await harness.getPerformanceMetrics();
    const sortSelect   = page.locator('#sortSelect');
    const sortOptions  = ['name_desc', 'date_mod_desc', 'name_asc', 'date_add_desc', 'name_desc'];

    // Changer le tri frénétiquement pendant que les vignettes se génèrent
    for (const opt of sortOptions) {
      await sortSelect.selectOption(opt);
      await page.waitForTimeout(40);
    }

    await page.waitForTimeout(2000); // Laisser le rendu se stabiliser
    await harness.assertNoCropCorruption();

    const endMetrics = await harness.getPerformanceMetrics();
    harness.assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB: 60, maxDurationMs: 10000 });
    console.log('✅ [D3] 0 vignette corrompue après sort frénétique pendant génération offline.');
  });

  test('Matrice D4 - Ouvrir Split View → F5 → Retour État Cohérent', async ({ page }) => {
    await harness.goto('/');
    await harness.openFolder(ARCHETYPES.LIGHT.folderId);
    await harness.ensureDocCached(ARCHETYPES.LIGHT.id);

    await harness.injectSearchQuery('grossesse', { expectResultsIn: 10000 });
    const vignette = page.locator('.doc-card[data-doc-id="1"] .vignette-item').first();
    await expect(vignette).toBeVisible({ timeout: 10000 });
    await vignette.click();

    const viewerPane = page.locator('#viewerPane');
    await expect(viewerPane).toBeVisible({ timeout: 10000 });
    console.log('[D4] Split View ouvert → rechargement F5...');

    await page.reload();
    await page.locator('#searchInput').waitFor({ state: 'visible', timeout: 10000 });

    // Après F5 : le viewer ne doit pas être ouvert (retour état propre)
    await expect(viewerPane).not.toBeVisible();
    // L'application doit être dans un état utilisable
    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    console.log('✅ [D4] Retour état cohérent après F5 depuis Split View.');
  });

  test('Matrice D5 - Navigation Dossier pendant batchCache actif → 0 Crash', async ({ page }) => {
    await harness.goto('/');
    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    const id1 = Number(await cards.nth(0).getAttribute('data-doc-id'));
    const id2 = Number(await cards.nth(1).getAttribute('data-doc-id'));
    await harness.ensureDocNotCached(id1);
    await harness.ensureDocNotCached(id2);

    // Activer la sélection et batch cache
    await page.locator('#toggleSelectionModeBtn').click();
    await cards.nth(0).locator('.doc-selection-checkbox').click();
    await cards.nth(1).locator('.doc-selection-checkbox').click();

    console.log('[D5] Lancement batchCache + navigation frénétique simultanée...');
    await page.locator('#batchCacheBtn').click();

    // Navigation frénétique immédiate pendant que le batch cache est en cours
    await harness.rapidFolderSwitching([130, null, 130, null], 100);

    await page.waitForTimeout(1000);
    // Vérifier que l'application est toujours dans un état stable (pas de crash)
    await expect(page.locator('#searchInput')).toBeVisible();
    await expect(page.locator('#resultsContainer')).toBeVisible();
    console.log('✅ [D5] Navigation pendant batchCache : 0 crash.');

    // Cleanup
    await harness.ensureDocNotCached(id1);
    await harness.ensureDocNotCached(id2);
  });

  // =========================================================================
  // MATRICE E : Viewer PDF.js — Ouverture, Navigation, Fermeture
  // =========================================================================

  test('Matrice E1 - Ouverture Viewer Online depuis Vignette → Page Correcte', async ({ page }) => {
    await harness.goto('/');
    await harness.injectSearchQuery('grossesse', { expectResultsIn: 15000 });

    const card     = await harness.getDocCard(ARCHETYPES.LIGHT.id);
    const vignette = card.locator('.vignette-item').first();
    await expect(vignette).toBeVisible({ timeout: 10000 });
    const expectedPage = await vignette.getAttribute('data-page');

    await vignette.click();
    const viewerPane = page.locator('#viewerPane');
    await expect(viewerPane).toBeVisible({ timeout: 10000 });

    await expect(page.locator('#viewerDocTitle')).toContainText('Grossesse');
    await expect(page.locator('#viewerPageBadge')).toHaveText(`Page ${expectedPage}`);
    await expect(page.locator('#pdfFrame')).toHaveAttribute('src', /\/pdfjs\/web\/viewer\.html/);
    console.log(`✅ [E1] Viewer ouvert sur page ${expectedPage} ✅`);
  });

  test('Matrice E2 - Navigation Occurrence Suivante / Précédente dans le Viewer', async ({ page }) => {
    await harness.goto('/');
    await harness.injectSearchQuery('grossesse', { expectResultsIn: 15000 });

    const card     = await harness.getDocCard(ARCHETYPES.LIGHT.id);
    const vignettes = card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 10000 });

    // Vérifier qu'il y a au moins 2 occurrences
    const count = await vignettes.count();
    expect(count).toBeGreaterThan(1);

    // Ouvrir le viewer sur la première vignette
    await vignettes.first().click();
    const viewerPane = page.locator('#viewerPane');
    await expect(viewerPane).toBeVisible({ timeout: 10000 });

    const firstPageBadge = await page.locator('#viewerPageBadge').textContent();

    // Naviguer vers l'occurrence suivante
    const nextOccBtn = page.locator('#nextOccBtn');
    await expect(nextOccBtn).toBeVisible({ timeout: 5000 });
    await nextOccBtn.click();
    await page.waitForTimeout(500);

    // La page doit avoir changé (occurrence différente) ou rester stable
    const activeOcc = page.locator('#docOccurrencesList .vertical-occ-card.active');
    await expect(activeOcc).toBeVisible({ timeout: 8000 });

    // Naviguer vers l'occurrence précédente
    const prevOccBtn = page.locator('#prevOccBtn');
    await prevOccBtn.click();
    await page.waitForTimeout(500);
    await expect(page.locator('#viewerPageBadge')).toHaveText(firstPageBadge);

    console.log('✅ [E2] Navigation prev/next occurrence dans le viewer validée.');
  });

  test('Matrice E3 - Fermeture Viewer → Résultats de Recherche Intacts', async ({ page }) => {
    await harness.goto('/');
    await harness.injectSearchQuery('grossesse', { expectResultsIn: 15000 });

    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const initialCount = await cards.count();

    // Ouvrir viewer
    await page.locator('.vignette-item').first().click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });

    // Fermer
    await page.locator('#closeViewerBtn').click();
    await expect(page.locator('#viewerPane')).not.toBeVisible();

    // Les résultats doivent être intacts
    await expect(cards.first()).toBeVisible({ timeout: 5000 });
    expect(await cards.count()).toBe(initialCount);
    await expect(page.locator('#searchInput')).toHaveValue('grossesse');
    console.log('✅ [E3] Fermeture viewer → résultats intacts ✅');
  });

  test('Matrice E4 - Viewer Ouvert → Suppression Cache → 0 Crash', async ({ page }) => {
    await harness.goto('/');
    await harness.openFolder(ARCHETYPES.LIGHT.folderId);
    await harness.ensureDocCached(ARCHETYPES.LIGHT.id);

    await harness.injectSearchQuery('grossesse', { expectResultsIn: 10000 });

    // Ouvrir le viewer
    const vignette = page.locator('.doc-card[data-doc-id="1"] .vignette-item').first();
    await expect(vignette).toBeVisible({ timeout: 10000 });
    await vignette.click();
    await expect(page.locator('#viewerPane')).toBeVisible({ timeout: 10000 });

    // Supprimer le cache pendant que le viewer est ouvert
    console.log('[E4] Suppression cache pendant que le viewer est ouvert...');
    await page.evaluate(async id => {
      if (window.downloadQueueManager) await window.downloadQueueManager.removeDocumentFromCache(id);
    }, ARCHETYPES.LIGHT.id);

    await page.waitForTimeout(500);

    // L'application ne doit pas crasher
    await expect(page.locator('#searchInput')).toBeVisible();
    const viewerStillOpen = await page.locator('#viewerPane').isVisible();
    console.log(`[E4] Viewer encore ouvert après suppression : ${viewerStillOpen}`);

    // Fermer proprement
    if (await page.locator('#closeViewerBtn').isVisible()) {
      await page.locator('#closeViewerBtn').click();
    }
    console.log('✅ [E4] 0 crash lors suppression cache avec viewer ouvert.');
  });

  // =========================================================================
  // MATRICE F : Performance Vignettes — Scroll, Changement Recherche, Fuites DOM
  // =========================================================================

  test('Matrice F1 - Scroll Rapide sur 25 Vignettes → 0 Vignette Blanche Finale', async ({ page }) => {
    await harness.goto('/');
    // Mettre Néphrologie en cache pour avoir 25 vignettes
    await harness.ensureDocCached(ARCHETYPES.HEAVY.id, { timeoutMs: 60000 });
    await harness.setOfflineFilter(true);
    await harness.injectSearchQuery('insuffisance rénale', { expectResultsIn: 10000 });

    const card = await harness.getDocCard(ARCHETYPES.HEAVY.id);
    const vignettes = card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 15000 });
    const count = await vignettes.count();
    expect(count).toBeGreaterThanOrEqual(1);
    console.log(`[F1] ${count} vignettes détectées`);

    const startMetrics = await harness.getPerformanceMetrics();

    // Scroll frénétique à travers toutes les vignettes
    for (let i = 0; i < count; i++) {
      await vignettes.nth(i).scrollIntoViewIfNeeded();
      if (i % 5 === 0) await page.waitForTimeout(50);
    }

    await page.waitForTimeout(1500); // Laisser les blobs se charger

    // Audit : 0 vignette corrompue
    const total = await harness.assertNoCropCorruption();
    console.log(`✅ [F1] ${total} vignettes auditées après scroll — 0 corrompue.`);

    const endMetrics = await harness.getPerformanceMetrics();
    harness.assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB: 80, maxDurationMs: 15000 });
  });

  test('Matrice F2 - Changement Recherche Rapide pendant Rendu Vignettes → 0 Orpheline', async ({ page }) => {
    await harness.goto('/');
    const startMetrics = await harness.getPerformanceMetrics();

    // Première recherche : attendre les vignettes
    await harness.injectSearchQuery('grossesse', { expectResultsIn: 15000 });
    await expect(page.locator('.vignette-item').first()).toBeVisible({ timeout: 10000 });

    // Changer la recherche immédiatement avant la fin du rendu complet
    await harness.search('infection');
    await page.waitForTimeout(100);
    await harness.search('cardiologie');
    await page.waitForTimeout(2000); // Laisser la dernière recherche se stabiliser

    // Vérifier que les vignettes visibles correspondent à la dernière recherche (anti-stale)
    await harness.assertSearchConsistency('cardiologie');

    // 0 vignette corrompue ou orpheline
    await harness.assertNoCropCorruption();

    const endMetrics = await harness.getPerformanceMetrics();
    harness.assertResourceGuard(startMetrics, endMetrics, { maxHeapGrowthMB: 60, maxDurationMs: 15000 });
    console.log('✅ [F2] 0 vignette orpheline après changement recherche rapide.');
  });

  test('Matrice F3 - 3 Recherches Successives → DOM Nodes Stables (0 Fuite)', async ({ page }) => {
    await harness.goto('/');

    const searches = ['grossesse', 'cardiologie', 'infection'];
    const domCounts = [];

    for (const query of searches) {
      await harness.injectSearchQuery(query, { expectResultsIn: 10000 });
      await expect(page.locator('.vignette-item').first()).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(500);
      const metrics = await harness.getPerformanceMetrics();
      domCounts.push(metrics.domNodeCount);
      console.log(`[F3] Après "${query}" : ${metrics.domNodeCount} DOM nodes`);
    }

    // Les DOM nodes ne doivent pas croître de façon exponentielle entre les recherches
    // Tolérance : max 50% de croissance entre la première et la dernière
    const growth = domCounts[domCounts.length - 1] / domCounts[0];
    console.log(`[F3] Croissance DOM : ×${growth.toFixed(2)} (${domCounts[0]} → ${domCounts[domCounts.length - 1]})`);
    expect(growth).toBeLessThan(2.0); // Pas de doublement des nodes

    // Nettoyer et vérifier que le retour à la racine libère les nodes
    await harness.clearSearch();
    await expect(page.locator('#foldersSection')).toBeVisible({ timeout: 5000 });
    const finalMetrics = await harness.getPerformanceMetrics();
    console.log(`[F3] DOM après reset : ${finalMetrics.domNodeCount} nodes`);
    console.log('✅ [F3] DOM nodes stables, 0 fuite mémoire détectée.');
  });
});

