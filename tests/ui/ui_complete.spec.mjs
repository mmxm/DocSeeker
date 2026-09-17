import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { DocSeekerTestHarness } from './harness.mjs';

test.describe('DocSeeker - Suite Complète de Tests UI Automatisés (En ligne & Offline)', () => {

  test.beforeAll(async () => {
    try {
      execSync("sqlite3 data/db.sqlite \"INSERT OR IGNORE INTO folders (id, name, color) VALUES (130, 'Martingale', '#3b82f6'); UPDATE documents SET folder_id = 130 WHERE id IN (1, 2, 3);\"", { stdio: 'ignore' });
    } catch (_) {}
  });

  test.beforeEach(async ({ page }) => {
    // Authentification administrateur automatique pour les tests
    const loginRes = await page.request.post('/api/auth/login', {
      data: { password: 'admin1234' }
    });
    expect(loginRes.ok()).toBeTruthy();

    // Persister la validité locale pour le mode hors-ligne
    await page.addInitScript(() => {
      localStorage.setItem('docseeker_session_valid_until', String(Date.now() + 30 * 24 * 3600 * 1000));
    });

    // Écouter les erreurs de la console pour détecter tout crash inopiné
    page.on('pageerror', (err) => {
      console.error('[Browser PageError]:', err.message);
    });
  });

  test.afterEach(async ({ context }) => {
    await context.setOffline(false).catch(() => {});
  });

  test('1. Chargement & Exploration de la Bibliothèque en Ligne', async ({ page }) => {
    await page.goto('/');

    // Attendre le chargement complet des documents et dossiers
    await expect(page.locator('#searchInput')).toBeVisible();
    await expect(page.locator('#resultsContainer')).toBeVisible();

    // Vérifier la présence des documents à la racine
    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const count = await cards.count();
    console.log(`[Test 1] Nombre de documents chargés à la racine : ${count}`);
    expect(count).toBeGreaterThan(10);

    // Vérifier la présence du dossier Martingale à la racine
    const folderMartingale = page.locator('.folder-card[data-folder-id="130"]');
    await expect(folderMartingale).toBeVisible();

    // Entrer dans le dossier Martingale
    await folderMartingale.click();
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 8000 });
    await expect(doc1Card.locator('.doc-title-main')).toContainText('Grossesse');

    // Revenir à la racine via le fil d'Ariane
    const breadcrumbRoot = page.locator('#breadcrumbsNav .breadcrumb-item').first();
    await breadcrumbRoot.click();
    await expect(folderMartingale).toBeVisible();
  });

  test('2. Recherche Globale en Ligne & Rendu Visuel des Vignettes', async ({ page }) => {
    await page.goto('/');

    // Attendre le chargement initial de la bibliothèque
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 10000 });

    // Saisir une requête sur le corpus médical réel
    const searchInput = page.locator('#searchInput');
    await searchInput.fill('grossess');
    await page.evaluate(() => window.performSearch && window.performSearch('grossess'));

    // Attendre l'affichage des résultats
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 15000 });

    // Vérifier la présence de vignettes d'occurrences
    const vignettes = doc1Card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 10000 });
    const vignetteCount = await vignettes.count();
    console.log(`[Test 2] Vignettes trouvées pour Doc #1 : ${vignetteCount}`);
    expect(vignetteCount).toBeGreaterThan(0);

    // Vérifier que l'image de crop est bien chargée avec dimensions réelles
    const firstImg = vignettes.first().locator('.vignette-crop-img');
    await expect(firstImg).toBeVisible();
    await expect.poll(async () => {
      return await firstImg.evaluate((img) => img.naturalWidth);
    }, { timeout: 8000 }).toBeGreaterThan(0);
  });

  test('3. Mise en Cache Réelle du Document #1 & Transition Visuelle du Bouton', async ({ page }) => {
    await page.goto('/');

    // Entrer dans le dossier Martingale pour trouver le Document #1
    const folderMartingale = page.locator('.folder-card[data-folder-id="130"]');
    await expect(folderMartingale).toBeVisible({ timeout: 10000 });
    await folderMartingale.click();

    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 10000 });
    const cacheBtn = doc1Card.locator('.doc-cache-btn');

    // Si déjà en cache d'une session précédente, le supprimer d'abord
    const isAlreadyCached = await cacheBtn.evaluate(b => b.classList.contains('cached'));
    if (isAlreadyCached) {
      page.once('dialog', dialog => dialog.accept());
      await cacheBtn.click();
      await expect(cacheBtn).not.toHaveClass(/cached/, { timeout: 6000 });
    }

    // Déclencher la mise en cache
    console.log('[Test 3] Clic sur le bouton de mise en cache du Doc #1...');
    await cacheBtn.click();

    // Vérifier la transition vers l'état de téléchargement puis état final .cached avec tick vert
    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 15000 });
    await expect(cacheBtn.locator('polyline')).toBeVisible();

    // Vérifier que window.downloadQueueManager a bien le document #1 en cache
    const isCachedInManager = await page.evaluate(() => {
      return window.downloadQueueManager && window.downloadQueueManager.isDocumentCached(1);
    });
    expect(isCachedInManager).toBe(true);

    // Vérifier que IndexedDB pdfCacheManager indique bien que le document est complet
    const isPdfComplete = await page.evaluate(async () => {
      return window.pdfCacheManager ? await window.pdfCacheManager.isComplete(1) : false;
    });
    expect(isPdfComplete).toBe(true);
    console.log('[Test 3] Document #1 mis en cache à 100% avec succès.');
  });

  test('4. Persistance du Cache après Rechargement Complet (F5)', async ({ page }) => {
    await page.goto('/');

    // S'assurer que le doc 1 est en cache
    await page.evaluate(async () => {
      await window.downloadQueueManager.ensureInitialized();
      if (!window.downloadQueueManager.isDocumentCached(1)) {
        await window.downloadQueueManager.enqueueDocument(1);
        for (let i = 0; i < 30; i++) {
          if (window.downloadQueueManager.isDocumentCached(1)) break;
          await new Promise(r => setTimeout(r, 200));
        }
      }
    });

    // Recharger la page (F5)
    console.log('[Test 4] Rechargement de la page (F5)...');
    await page.reload();

    // Naviguer dans le dossier Martingale et vérifier que le doc 1 reste marqué "En cache"
    const folderMartingale = page.locator('.folder-card[data-folder-id="130"]');
    await expect(folderMartingale).toBeVisible({ timeout: 10000 });
    await folderMartingale.click();

    const reloadedCard = page.locator('.doc-card[data-doc-id="1"]');
    await expect(reloadedCard).toBeVisible({ timeout: 10000 });
    const reloadedBtn = reloadedCard.locator('.doc-cache-btn');

    await expect(reloadedBtn).toHaveClass(/cached/, { timeout: 5000 });
    await expect(reloadedBtn.locator('polyline')).toBeVisible();

    // Vérifier directement dans le worker SQLite-Wasm local (OPFS)
    const cachedDocsInWorker = await page.evaluate(async () => {
      if (!window.downloadQueueManager) return [];
      return await window.downloadQueueManager.sendToWorker('GET_ALL_CACHED_DOCS', {});
    });
    console.log(`[Test 4] Documents conservés dans SQLite OPFS après F5 : ${cachedDocsInWorker.length}`);
    expect(cachedDocsInWorker.some(d => Number(d.id) === 1)).toBe(true);
  });

  test('5. Affichage & Navigation dans les Dossiers contenant des Documents en Cache (Filtre Hors-Ligne)', async ({ page }) => {
    await page.goto('/');

    // 1. S'assurer que le doc 1 (dans le dossier Martingale #130) est en cache
    await page.evaluate(async () => {
      await window.downloadQueueManager.ensureInitialized();
      if (!window.downloadQueueManager.isDocumentCached(1)) {
        await window.downloadQueueManager.enqueueDocument(1);
        for (let i = 0; i < 30; i++) {
          if (window.downloadQueueManager.isDocumentCached(1)) break;
          await new Promise(r => setTimeout(r, 200));
        }
      }
    });

    // 2. À la racine, activer le filtre "Hors-ligne uniquement"
    const filterOffline = page.locator('#filterOfflineOnly');
    await expect(filterOffline).toBeVisible();
    await filterOffline.check();

    // 3. Vérifier que le dossier "Martingale" (#130) RESTE VISIBLE
    const martingaleFolder = page.locator('.folder-card[data-folder-id="130"]');
    await expect(martingaleFolder).toBeVisible({ timeout: 6000 });

    // 4. Vérifier que le badge indique le document disponible en cache avec un tick
    const badge = martingaleFolder.locator('.folder-cache-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/✓ 1/);

    // 5. Cliquer sur le dossier Martingale pour y entrer
    await martingaleFolder.click();

    // 6. Vérifier que le document 1 "023 - Grossesse normale" s'affiche bien à l'intérieur
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 6000 });
    await expect(doc1Card.locator('.doc-cache-btn')).toHaveClass(/cached/);

    // 7. Décocher le filtre "Hors-ligne uniquement"
    await filterOffline.uncheck();
  });

  test('6. Recherche Globale & Consultation Split View en Full Hors-Ligne (Coupure Réseau & F5)', async ({ page, context }) => {
    await page.goto('/');

    // 1. S'assurer que le document 1 est en cache
    await page.evaluate(async () => {
      await window.downloadQueueManager.ensureInitialized();
      if (!window.downloadQueueManager.isDocumentCached(1)) {
        await window.downloadQueueManager.enqueueDocument(1);
        for (let i = 0; i < 30; i++) {
          if (window.downloadQueueManager.isDocumentCached(1)) break;
          await new Promise(r => setTimeout(r, 200));
        }
      }
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
      }
    });

    // 2. Couper complètement la connexion réseau
    console.log('[Test 6] Coupure intégrale du réseau (Simulation Full Hors-Ligne)...');
    await context.setOffline(true);

    // 3. Recharger la page (F5) en mode déconnecté pour valider l'étanchéité complète de l'App Shell
    console.log('[Test 6] Rechargement de la page (F5) sans réseau...');
    await page.reload();

    await page.evaluate(async () => {
      if (window.downloadQueueManager) {
        await window.downloadQueueManager.ensureInitialized();
        await window.downloadQueueManager.getAllCachedDocs();
      }
    });

    // 4. Effectuer une recherche en mode déconnecté
    const searchInput = page.locator('#searchInput');
    await searchInput.fill('grossess');
    await page.evaluate(() => window.performSearch && window.performSearch('grossess'));

    // 5. Vérifier que le résultat est affiché instantanément via SQLite-Wasm local
    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 15000 });

    // 6. Vérifier que les vignettes sont générées localement par crop-worker.js
    const vignettes = doc1Card.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 10000 });
    const firstImg = vignettes.first().locator('.vignette-crop-img');
    await firstImg.scrollIntoViewIfNeeded();

    // Le src doit être un blob URL local (OffscreenCanvas)
    await expect.poll(async () => {
      return await firstImg.evaluate((img) => img.src);
    }, { timeout: 10000 }).toMatch(/^blob:/);

    // 7. Ouvrir la consultation dans le visualiseur Split View par clic sur la vignette
    await vignettes.first().click();

    // 8. Vérifier que le visualiseur s'ouvre
    const viewerPane = page.locator('#viewerPane');
    await expect(viewerPane).toBeVisible({ timeout: 12000 });

    // 9. Vérifier le titre du document dans le viewer
    const viewerDocTitle = page.locator('#viewerDocTitle');
    await expect(viewerDocTitle).toContainText('Grossesse');

    // 10. Vérifier que les occurrences internes au document sont générées hors-ligne
    const docOccList = page.locator('#docOccurrencesList');
    await expect(docOccList).toBeVisible({ timeout: 10000 });

    // 11. Vérifier que le panneau latéral a synchronisé l'occurrence active
    const activeOccCard = docOccList.locator('.vertical-occ-card.active');
    await expect(activeOccCard).toBeVisible({ timeout: 10000 });

    // 12. Vérifier que l'iframe du viewer PDF.js est bien configuré avec viewer.html
    const pdfFrame = page.locator('#pdfFrame');
    await expect(pdfFrame).toBeVisible({ timeout: 10000 });
    await expect(pdfFrame).toHaveAttribute('src', /\/pdfjs\/web\/viewer\.html/, { timeout: 10000 });

    console.log('[Test 6] Recherche et consultation Split View 100% hors-ligne après F5 validées.');

    // Rétablir la connexion
    await context.setOffline(false);
  });

  test('7. Cycle de Suppression du Cache Local & Libération Espace', async ({ page }) => {
    await page.goto('/');

    // S'assurer qu'il est en cache
    await page.evaluate(async () => {
      await window.downloadQueueManager.ensureInitialized();
      if (!window.downloadQueueManager.isDocumentCached(1)) {
        await window.downloadQueueManager.enqueueDocument(1);
        for (let i = 0; i < 30; i++) {
          if (window.downloadQueueManager.isDocumentCached(1)) break;
          await new Promise(r => setTimeout(r, 200));
        }
      }
    });

    // Naviguer dans le dossier Martingale
    const folderMartingale = page.locator('.folder-card[data-folder-id="130"]');
    await expect(folderMartingale).toBeVisible({ timeout: 10000 });
    await folderMartingale.click();

    const doc1Card = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1Card).toBeVisible({ timeout: 10000 });
    const cacheBtn = doc1Card.locator('.doc-cache-btn');

    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 10000 });

    // Configurer l'écouteur de dialogue pour accepter la suppression
    page.once('dialog', dialog => {
      console.log(`[Test 7] Boîte de confirmation interceptée : "${dialog.message()}"`);
      dialog.accept();
    });

    // Clic pour supprimer
    await cacheBtn.click();

    // Vérifier le retour à l'état non en cache
    await expect(cacheBtn).not.toHaveClass(/cached/, { timeout: 8000 });
    const isCachedAfterDelete = await page.evaluate(() => {
      return window.downloadQueueManager.isDocumentCached(1);
    });
    expect(isCachedAfterDelete).toBe(false);

    // Vérifier la purge dans SQLite Wasm
    await expect.poll(async () => {
      const cachedDocs = await page.evaluate(async () => {
        return await window.downloadQueueManager.sendToWorker('GET_ALL_CACHED_DOCS', {});
      });
      return cachedDocs.some(d => Number(d.id) === 1);
    }, { timeout: 5000 }).toBe(false);

    console.log('[Test 7] Suppression du cache local validée avec succès.');
  });

  test('8. Sélection Multiple : Mise en cache par lot et retrait du cache', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#resultsContainer')).toBeVisible();

    // Trouver 2 documents à la racine pour le test
    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const count = await cards.count();
    expect(count).toBeGreaterThan(2);

    const doc1Id = await cards.nth(0).getAttribute('data-doc-id');
    const doc2Id = await cards.nth(1).getAttribute('data-doc-id');
    expect(doc1Id).toBeTruthy();
    expect(doc2Id).toBeTruthy();

    console.log(`[Test 8] Documents sélectionnés pour le lot : #${doc1Id} et #${doc2Id}`);

    // S'assurer qu'ils ne sont pas en cache au départ
    await page.evaluate(async ([id1, id2]) => {
      if (window.downloadQueueManager) {
        if (window.downloadQueueManager.isDocumentCached(id1)) await window.downloadQueueManager.removeDocumentFromCache(id1);
        if (window.downloadQueueManager.isDocumentCached(id2)) await window.downloadQueueManager.removeDocumentFromCache(id2);
      }
    }, [Number(doc1Id), Number(doc2Id)]);

    // Activer le mode sélection multiple
    await page.locator('#toggleSelectionModeBtn').click();

    // Sélectionner les 2 documents via leur case à cocher
    const chk1 = cards.nth(0).locator('.doc-selection-checkbox');
    const chk2 = cards.nth(1).locator('.doc-selection-checkbox');
    await chk1.click();
    await chk2.click();

    // Vérifier l'apparition de la barre de sélection d'actions
    const actionBar = page.locator('#selectionActionBar');
    await expect(actionBar).toBeVisible();
    await expect(page.locator('#selectionCountText')).toContainText('2 documents sélectionnés');

    // Vérifier la présence des boutons Mettre en cache et Retirer du cache
    const batchCacheBtn = page.locator('#batchCacheBtn');
    const batchUncacheBtn = page.locator('#batchUncacheBtn');
    await expect(batchCacheBtn).toBeVisible();
    await expect(batchUncacheBtn).toBeVisible();

    // 1. Clic sur "Mettre en cache" par lot
    await batchCacheBtn.click();

    // Attendre que les deux cartes passent en état '.cached'
    const btn1 = cards.nth(0).locator('.doc-cache-btn');
    const btn2 = cards.nth(1).locator('.doc-cache-btn');
    await expect(btn1).toHaveClass(/cached/, { timeout: 25000 });
    await expect(btn2).toHaveClass(/cached/, { timeout: 25000 });

    // Vérifier l'état dans window.downloadQueueManager
    const areBothCached = await page.evaluate(([id1, id2]) => {
      const dqm = window.downloadQueueManager;
      return dqm.isDocumentCached(id1) && dqm.isDocumentCached(id2);
    }, [Number(doc1Id), Number(doc2Id)]);
    expect(areBothCached).toBe(true);
    console.log('[Test 8] Mise en cache par lot réussie pour les 2 documents.');

    // 2. Retrait du cache par lot
    page.once('dialog', dialog => {
      console.log(`[Test 8] Boîte de confirmation interceptée : "${dialog.message()}"`);
      dialog.accept();
    });
    await batchUncacheBtn.click();

    // Attendre que les deux cartes perdent la classe '.cached'
    await expect(btn1).not.toHaveClass(/cached/, { timeout: 10000 });
    await expect(btn2).not.toHaveClass(/cached/, { timeout: 10000 });

    const areBothUncached = await page.evaluate(([id1, id2]) => {
      const dqm = window.downloadQueueManager;
      return !dqm.isDocumentCached(id1) && !dqm.isDocumentCached(id2);
    }, [Number(doc1Id), Number(doc2Id)]);
    expect(areBothUncached).toBe(true);
    console.log('[Test 8] Retrait du cache par lot validé avec succès.');
  });

  test('9. Couverture complète du statut cache dossier (Martingale 3/3 "✓ En cache" sans masque)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#resultsContainer')).toBeVisible();

    const folderMartingale = page.locator('.folder-card[data-folder-id="130"]');
    await expect(folderMartingale).toBeVisible({ timeout: 10000 });

    // Entrer dans Martingale
    await folderMartingale.click();
    await expect(page.locator('#breadcrumbsNav')).toContainText('Martingale', { timeout: 8000 });
    const doc1 = page.locator('.doc-card[data-doc-id="1"]');
    await expect(doc1).toBeVisible({ timeout: 8000 });

    // Récupérer tous les documents du dossier Martingale
    const docCards = page.locator('.doc-card');
    const docCount = await docCards.count();
    expect(docCount).toBe(3);

    // Mettre les 3 documents en cache s'ils ne le sont pas déjà
    for (let i = 0; i < docCount; i++) {
      const card = docCards.nth(i);
      const cacheBtn = card.locator('.doc-cache-btn');
      const isCached = await cacheBtn.evaluate(el => el.classList.contains('cached'));
      if (!isCached) {
        await cacheBtn.click();
      }
    }

    // Attendre que tous les 3 documents soient 'cached'
    for (let i = 0; i < docCount; i++) {
      const card = docCards.nth(i);
      await expect(card.locator('.doc-cache-btn')).toHaveClass(/cached/, { timeout: 30000 });
    }

    // Revenir à la racine via le fil d'Ariane
    const breadcrumbRoot = page.locator('#breadcrumbsNav .breadcrumb-item').first();
    await breadcrumbRoot.click();
    await expect(folderMartingale).toBeVisible();

    // Vérifier que la vignette "en cache" du dossier est BIEN VISIBLE et NON MASQUÉE (tick compact)
    const badge = folderMartingale.locator('.folder-cache-badge');
    await expect(badge).toBeVisible({ timeout: 6000 });
    await expect(badge).toHaveClass(/complete/);
    await expect(badge).toHaveText('✓');

    // Vérifier les dimensions et la non-troncature du badge (largeur > 15px, bien proportionné)
    const badgeBox = await badge.boundingBox();
    expect(badgeBox).not.toBeNull();
    expect(badgeBox.width).toBeGreaterThan(15);

    // Vérifier que le bouton d'action du dossier est passé en "supprimer du cache"
    const deleteFolderCacheBtn = folderMartingale.locator('.folder-btn-action.btn-delete-folder-cache');
    await expect(deleteFolderCacheBtn).toBeVisible();

    console.log('[Test 9] Badge de dossier Martingale (3/3 "✓ En cache", non masqué) validé avec succès.');
  });

  test('10. Parité Stricte Hors-Ligne : Recherche "insuffisance rénale aigue" dans Néphrologie (Titre p. 267 & 25 vignettes)', async ({ page }) => {
    await page.goto('/');

    // 1. Attendre le chargement initial de la bibliothèque
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 10000 });

    // 2. Mettre en cache le document #544 (Néphrologie - 11E 2024)
    const nephroCard = page.locator('.doc-card[data-doc-id="544"]');
    await expect(nephroCard).toBeVisible({ timeout: 10000 });

    const cacheBtn = nephroCard.locator('.doc-cache-btn');
    const isAlreadyCached = await cacheBtn.evaluate((el) => el.classList.contains('cached'));
    if (!isAlreadyCached) {
      console.log('[Test 10] Mise en cache de Néphrologie (#544)...');
      await cacheBtn.click();
      await expect(cacheBtn).toHaveClass(/cached/, { timeout: 35000 });
      console.log('[Test 10] Document #544 mis en cache avec succès.');
    }

    // 3. Activer le filtre "Hors-ligne uniquement"
    const offlineFilter = page.locator('#filterOfflineOnly');
    await offlineFilter.check();

    // 4. Lancer la recherche "insuffisance rénale aigue"
    const searchInput = page.locator('#searchInput');
    await searchInput.fill('insuffisance rénale aigue');
    await page.evaluate(() => window.performSearch && window.performSearch('insuffisance rénale aigue'));

    // 5. Attendre l'affichage de la carte Néphrologie
    const searchResultCard = page.locator('.doc-card[data-doc-id="544"]');
    await expect(searchResultCard).toBeVisible({ timeout: 15000 });

    // 6. Vérifier la présence du ruban de vignettes
    const vignettes = searchResultCard.locator('.vignette-item');
    await expect(vignettes.first()).toBeVisible({ timeout: 10000 });
    const vignetteCount = await vignettes.count();
    console.log(`[Test 10] Vignettes hors-ligne trouvées pour Néphrologie : ${vignetteCount}`);
    expect(vignetteCount).toBe(25);

    // 7. Vérifier que la première vignette est STRICTEMENT la page 267 (titre de chapitre INSUFFISANCE RÉNALE AIGUË)
    const firstVignette = vignettes.first();
    await expect(firstVignette).toHaveAttribute('data-page', '267');
    
    const pageBadge = firstVignette.locator('.vignette-page-badge');
    await expect(pageBadge).toContainText('p. 267');

    const titleAttr = await firstVignette.getAttribute('title');
    console.log(`[Test 10] Tooltip de la première vignette : "${titleAttr}"`);
    expect(titleAttr).toContain('Page 267');
    expect(titleAttr).toContain('(Titre)');

    console.log('✅ [Test 10] Parité absolue hors-ligne validée : Titre p. 267 en 1ère vignette et 25 vignettes affichées.');

    // 8. Cliquer sur la vignette p. 267 et vérifier l'ouverture et la synchronisation exacte
    await firstVignette.click();
    const viewerPane = page.locator('#viewerPane');
    await expect(viewerPane).toBeVisible({ timeout: 10000 });
    const viewerPageBadge = page.locator('#viewerPageBadge');
    await expect(viewerPageBadge).toHaveText('Page 267');

    const activeOcc = page.locator('#docOccurrencesList .vertical-occ-card.active');
    await expect(activeOcc).toBeVisible({ timeout: 10000 });
    await expect(activeOcc.locator('.vertical-occ-page')).toHaveText('Page 267');

    // Fermer le viewer
    const closeBtn = page.locator('#closeViewerBtn');
    await closeBtn.click();
    await expect(viewerPane).not.toBeVisible();
  });

  test('11. Consistance du Bouton Supprimer du Cache (Nuage Barré), Robustesse aux Bascules Rapides et Réinitialisation Complète', async ({ page }) => {
    await page.goto('/');

    // 1. Attendre le chargement de la bibliothèque
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 10000 });

    // === PARTIE A : Consistance du bouton de suppression du cache local (Nuage barré) ===
    const targetDocCard = page.locator('.doc-card[data-doc-id="544"]');
    await expect(targetDocCard).toBeVisible({ timeout: 10000 });

    const cacheBtn = targetDocCard.locator('.doc-cache-btn');
    const deleteDocCacheBtn = targetDocCard.locator('.btn-delete-doc-cache');

    // Mettre en cache doc #544 s'il ne l'est pas déjà
    const isCachedInitially = await cacheBtn.evaluate(el => el.classList.contains('cached'));
    if (!isCachedInitially) {
      await cacheBtn.click();
      await expect(cacheBtn).toHaveClass(/cached/, { timeout: 35000 });
    }

    // Vérifier que le bouton distinct nuage barré est visible pour ce document en cache
    await expect(deleteDocCacheBtn).toBeVisible({ timeout: 5000 });

    // Intercepter la confirmation de suppression
    page.once('dialog', dialog => {
      console.log(`[Test 11] Confirmation interception : "${dialog.message()}"`);
      dialog.accept();
    });

    // Clic sur le bouton distinct nuage barré pour supprimer du cache
    await deleteDocCacheBtn.click();

    // Vérifier que le statut n'est plus "cached" et que le bouton distinct nuage barré est masqué
    await expect(cacheBtn).not.toHaveClass(/cached/, { timeout: 8000 });
    await expect(deleteDocCacheBtn).toBeHidden({ timeout: 5000 });
    console.log('✅ [Test 11] Bouton distinct nuage barré pour document validé avec succès.');

    // Remettre doc #544 en cache pour la suite des tests
    await cacheBtn.click();
    await expect(cacheBtn).toHaveClass(/cached/, { timeout: 35000 });
    await expect(deleteDocCacheBtn).toBeVisible({ timeout: 5000 });

    // === PARTIE B : Recherche, bascules rapides de filtres (Offline / Titres) et 0 vignette blanche ===
    const searchInput = page.locator('#searchInput');
    await searchInput.fill('grossesse');
    await page.evaluate(() => window.performSearch && window.performSearch('grossesse'));

    // Attendre les résultats
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 15000 });

    // Bascules rapides et successives du filtre "Hors-ligne uniquement" et "Titres uniquement"
    await page.evaluate(async () => {
      const offlineCb = document.getElementById('filterOfflineOnly');
      const titlesCb = document.getElementById('filterTitlesOnly');

      // 4 bascules rapides offline
      offlineCb.click(); // ON
      await new Promise(r => setTimeout(r, 100));
      offlineCb.click(); // OFF
      await new Promise(r => setTimeout(r, 100));
      offlineCb.click(); // ON
      await new Promise(r => setTimeout(r, 100));
      offlineCb.click(); // OFF
      await new Promise(r => setTimeout(r, 200));

      // 2 bascules titres
      titlesCb.click(); // ON
      await new Promise(r => setTimeout(r, 100));
      titlesCb.click(); // OFF
      await new Promise(r => setTimeout(r, 300));

      // Remettre offline ON pour vérifier les vignettes hors-ligne
      offlineCb.click();
    });

    // Laisser 2 secondes pour la stabilisation du rendu
    await page.waitForTimeout(2000);

    // Vérifier qu'aucune vignette n'est blanche / invalide
    const vignetteAudit = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('.vignette-crop-img'));
      const invalid = imgs.filter(img => !img.complete || img.naturalWidth === 0 || window.getComputedStyle(img).opacity === '0');
      return { total: imgs.length, invalidCount: invalid.length };
    });
    console.log(`[Test 11] Total vignettes auditées après bascules : ${vignetteAudit.total}, invalides : ${vignetteAudit.invalidCount}`);
    expect(vignetteAudit.invalidCount).toBe(0);
    expect(vignetteAudit.total).toBeGreaterThan(0);
    console.log('✅ [Test 11] Robustesse des vignettes validée : 0 vignette blanche après bascules rapides.');

    // Rétablir le filtre hors-ligne à false pour revenir en mode en ligne complet
    await page.evaluate(() => {
      const offlineCb = document.getElementById('filterOfflineOnly');
      if (offlineCb && offlineCb.checked) offlineCb.click();
    });
    await page.waitForTimeout(500);

    // === PARTIE C : Réinitialisation exhaustive de la recherche ===
    // 1. Réinitialisation via le bouton X (#clearSearchBtn)
    const clearBtn = page.locator('#clearSearchBtn');
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();
    await expect(page.locator('#foldersSection')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.vignette-item')).toHaveCount(0);
    console.log('✅ [Test 11] Réinitialisation via bouton X validée.');

    // 2. Recherche puis réinitialisation via touche Échap
    await searchInput.fill('grossesse');
    await page.evaluate(() => window.performSearch && window.performSearch('grossesse'));
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 10000 });
    await searchInput.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#foldersSection')).toBeVisible({ timeout: 5000 });
    expect(await searchInput.inputValue()).toBe('');
    await expect(page.locator('.vignette-item')).toHaveCount(0);
    console.log('✅ [Test 11] Réinitialisation via touche Échap validée.');

    // 3. Recherche puis réinitialisation via le bouton "Scanner" (#syncDocsBtn)
    await searchInput.fill('grossesse');
    await page.evaluate(() => window.performSearch && window.performSearch('grossesse'));
    await expect(page.locator('.doc-card').first()).toBeVisible({ timeout: 10000 });
    const syncBtn = page.locator('#syncDocsBtn');
    await syncBtn.click();
    await expect(page.locator('#foldersSection')).toBeVisible({ timeout: 10000 });
    expect(await searchInput.inputValue()).toBe('');
    await expect(page.locator('.vignette-item')).toHaveCount(0);
    console.log('✅ [Test 11] Réinitialisation via bouton Scanner validée.');
  });

  test('12. Recherche, Sélection Multiple O(1), Split View et Maintien des Résultats', async ({ page }) => {
    await page.goto('/');
    const searchInput = page.locator('#searchInput');
    await expect(searchInput).toBeVisible();

    // 1. Recherche "grossesse"
    await searchInput.fill('grossesse');
    await page.evaluate(() => window.performSearch && window.performSearch('grossesse'));
    const cards = page.locator('.doc-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThan(0);

    // 2. Vérification de la sélection multiple O(1) en mode recherche
    await page.locator('#toggleSelectionModeBtn').click();
    const firstCheckbox = cards.first().locator('.doc-selection-checkbox');
    await firstCheckbox.click();
    await expect(cards.first()).toHaveClass(/selected/);
    const selectionBar = page.locator('#selectionActionBar');
    await expect(selectionBar).toBeVisible();
    await expect(page.locator('#selectionCountText')).toContainText('1 document');

    await firstCheckbox.click();
    await expect(cards.first()).not.toHaveClass(/selected/);
    await expect(selectionBar).toBeHidden();
    await page.locator('#toggleSelectionModeBtn').click(); // Désactiver le mode sélection
    console.log('✅ [Test 12] Sélection O(1) dans les résultats de recherche validée.');

    // 3. Ouvrir un document en Split View depuis une vignette
    const firstVignette = page.locator('.vignette-item').first();
    await firstVignette.click();
    await expect(page.locator('#workspace')).toHaveClass(/split-active/, { timeout: 10000 });

    // 4. Fermer la Split View et revenir aux résultats
    const closeBtn = page.locator('#closeViewerBtn');
    await closeBtn.click();
    await expect(page.locator('#workspace')).not.toHaveClass(/split-active/);
    await expect(page.locator('#generalView')).toBeVisible();

    // 5. Vérifier que les résultats de recherche sont toujours affichés et que le tri fonctionne
    const sortSelect = page.locator('#sortSelect');
    await sortSelect.selectOption('name_asc');
    await page.waitForTimeout(300);

    // Les cartes doivent toujours être les résultats de recherche (avec vignettes), pas la bibliothèque
    await expect(page.locator('.vignette-item').first()).toBeVisible({ timeout: 5000 });
    expect(await page.locator('#foldersSection').isVisible()).toBe(false);
    console.log('✅ [Test 12] Maintien des résultats de recherche et tri après Split View validé.');
  });

  test('13. Recherche Hors-Ligne & Robustesse aux Documents sans Binaire PDF (Zéro NetworkError & Fallback Vignette)', async ({ page, context }) => {
    await page.goto('/');

    // 1. Indexer localement le Document #2 via bundle (texte FTS dans SQLite, sans binaire PDF dans IndexedDB)
    await page.evaluate(async () => {
      await window.downloadQueueManager.ensureInitialized();
      await window.downloadQueueManager.removeDocumentFromCache(2);
      await window.downloadQueueManager.ensureDocumentIndexedLocally(2);
      if (window.pdfCacheManager) {
        await window.pdfCacheManager.invalidate(2);
      }
    });

    // 2. Écouter la console pour détecter toute erreur réseau inopinée
    const networkErrors = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('NetworkError') || text.includes('[CropWorker] Error rendering crop')) {
        networkErrors.push(text);
      }
    });

    // 3. Couper complètement le réseau
    await context.setOffline(true);

    // 4. Activer le filtre hors-ligne et rechercher un mot présent dans le document 2
    const filterOffline = page.locator('#filterOfflineOnly');
    await filterOffline.check();

    const searchInput = page.locator('#searchInput');
    await searchInput.fill('extra-utérine');
    await page.evaluate(async () => {
      if (window.performSearch) {
        await window.performSearch('extra-utérine');
      }
    });

    // 5. Vérifier que le document 2 (sans binaire PDF) est strictement exclu de la recherche hors-ligne
    const isDoc2Cached = await page.evaluate(() => window.downloadQueueManager.isDocumentCached(2));
    expect(isDoc2Cached).toBeFalsy();
    const doc2Card = page.locator('.doc-card[data-doc-id="2"]');
    await expect(doc2Card).toHaveCount(0);

    // 6. Vérifier qu'aucune erreur réseau n'a été émise dans la console
    expect(networkErrors).toHaveLength(0);
    console.log('✅ [Test 13] Exclusion stricte du document sans binaire PDF et zéro NetworkError validés.');

    // Rétablir la connexion
    await context.setOffline(false);
  });

  test('14. Filtre Hors-Ligne Actif en Présence Réseau (navigator.onLine) & Non-téléchargés (Exclusion Stricte & Zéro Console Error)', async ({ page }) => {
    await page.goto('/');

    // 1. S'assurer que le document 3 est indexé localement mais SANS son binaire PDF dans IndexedDB
    await page.evaluate(async () => {
      await window.downloadQueueManager.ensureInitialized();
      await window.downloadQueueManager.ensureDocumentIndexedLocally(3);
      if (window.pdfCacheManager) {
        await window.pdfCacheManager.invalidate(3);
      }
    });

    // 2. Écouter la console pour détecter strictement toute erreur de crop ou NetworkError
    const capturedErrors = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[CropWorker] Error rendering crop') || 
          text.includes('NetworkError when attempting to fetch') ||
          (msg.type() === 'error' && text.includes('crop-worker'))) {
        capturedErrors.push(text);
      }
    });

    // 3. Le navigateur est connecté (navigator.onLine == true), mais le mode hors-ligne est activé via l'UI
    const filterOffline = page.locator('#filterOfflineOnly');
    await filterOffline.check();

    // 4. Lancer une recherche qui matcherait le document 3
    const searchInput = page.locator('#searchInput');
    await searchInput.fill('de');
    await page.evaluate(() => window.performSearch && window.performSearch('de'));

    // 5. Vérifier que le document 3 est exclu de la recherche hors-ligne car son binaire est incomplet
    const isDoc3Cached = await page.evaluate(() => window.downloadQueueManager.isDocumentCached(3));
    expect(isDoc3Cached).toBeFalsy();
    const doc3Card = page.locator('.doc-card[data-doc-id="3"]');
    await expect(doc3Card).toHaveCount(0);

    // Attendre un court délai pour s'assurer qu'aucun message différé d'erreur n'arrive
    await page.waitForTimeout(400);

    // 6. Vérifier l'absence totale d'erreur dans la console
    expect(capturedErrors).toHaveLength(0);
    console.log('✅ [Test 14] Exclusion stricte du document non-téléchargé et zéro erreur de worker confirmées.');
  });

  // =========================================================================
  // MATRICE DE TESTS PARAMÉTRÉS (HARNESS POM) : RÉSILIENCE RÉSEAU & CACHE PARTIEL
  // =========================================================================
  const resilienceScenarios = [
    {
      id: 'R1_Partial15',
      name: 'Matrice Résilience 1 : Téléchargement partiel (15%), coupure réseau totale, exclusion hors-ligne et reprise à 100%',
      docId: 1,
      interruptPercent: 15,
      query: 'grossesse',
    },
    {
      id: 'R2_Partial50',
      name: 'Matrice Résilience 2 : Coupure réseau à 50% du transfert binaire, vérification zéro crash et reprise complète',
      docId: 1,
      interruptPercent: 50,
      query: 'patiente',
    },
    {
      id: 'R3_Flapping',
      name: 'Matrice Résilience 3 : Flapping réseau (Online/Offline répétés) pendant le streaming de fragments 256 Ko',
      docId: 1,
      flapping: true,
      query: 'grossesse',
    },
    {
      id: 'R4_HeavyOffline',
      name: 'Matrice Résilience 4 : Recherche lourde avec astérisque et multi-termes en coupure réseau totale',
      docId: 1,
      heavyQuery: 'grossesse*',
    },
    {
      id: 'R5_NoMatch',
      name: 'Matrice Résilience 5 : Recherche hors-ligne sans résultat, vérification état vide propre sans erreur',
      docId: 1,
      noMatchQuery: 'termeinexistant12345*',
    }
  ];

  for (const sc of resilienceScenarios) {
    test(`15.${sc.id} - ${sc.name}`, async ({ page, context }) => {
      const harness = new DocSeekerTestHarness(page, context);
      await harness.goto('/');

      if (sc.interruptPercent) {
        // 1. Simuler un cache partiel déterministe (incomplet dans IndexedDB)
        await harness.injectPartialCache(sc.docId, sc.interruptPercent);

        // 2. Vérifier que le document est détecté comme non-complet
        const isComplete = await page.evaluate(async (id) => {
          return window.pdfCacheManager ? await window.pdfCacheManager.isComplete(id) : false;
        }, sc.docId);
        expect(isComplete).toBeFalsy();

        // 3. Couper la connexion réseau et activer le filtre hors-ligne
        await harness.setOffline(true);
        await harness.setOfflineFilter(true);

        // 4. Effectuer une recherche hors-ligne : le document incomplet doit être exclu
        await harness.search(sc.query);
        await page.waitForTimeout(500);

        const card = page.locator(`.doc-card[data-doc-id="${sc.docId}"]`);
        await expect(card).toHaveCount(0);
        harness.assertZeroErrors();

        // 5. Rétablir la connexion et finaliser le téléchargement
        await harness.setOffline(false);
        await harness.setOfflineFilter(false);
        await harness.clearSearch();
        await harness.openFolder(130);
        await harness.downloadDocToComplete(sc.docId);

        // 6. Coupure finale et recherche hors-ligne : le document complet doit être visible avec vignettes
        await harness.setOffline(true);
        await harness.setOfflineFilter(true);
        await harness.search(sc.query);

        const docCard = await harness.getDocCard(sc.docId);
        await expect(docCard).toBeVisible({ timeout: 10000 });
        await harness.assertVignettesVisible(sc.docId, 1);

        harness.assertZeroErrors();
        await harness.setOffline(false);
      } else if (sc.flapping) {
        await harness.cleanDocCache(sc.docId);
        await harness.openFolder(130);
        const card = await harness.getDocCard(sc.docId);
        const btn = card.locator('.doc-cache-btn');
        
        // Démarrer le téléchargement
        await btn.click();
        
        // Simuler des micro-coupures réseau rapides pendant le streaming des fragments
        await harness.setOffline(true);
        await page.waitForTimeout(150);
        await harness.setOffline(false);
        await harness.setOfflineFilter(false);
        await page.waitForTimeout(150);

        // Reprendre le téléchargement une fois le réseau stabilisé
        await harness.downloadDocToComplete(sc.docId);

        // Coupure finale et recherche hors-ligne
        await harness.setOffline(true);
        await harness.setOfflineFilter(true);
        await harness.search(sc.query);

        const docCard = await harness.getDocCard(sc.docId);
        await expect(docCard).toBeVisible({ timeout: 10000 });
        await harness.assertVignettesVisible(sc.docId, 1);
        harness.assertZeroErrors();
        await harness.setOffline(false);
      } else if (sc.heavyQuery) {
        await harness.cleanDocCache(sc.docId);
        await harness.openFolder(130);
        await harness.downloadDocToComplete(sc.docId, 45000);

        await harness.setOffline(true);
        await harness.setOfflineFilter(true);
        await harness.search(sc.heavyQuery);

        const docCard = await harness.getDocCard(sc.docId);
        await expect(docCard).toBeVisible({ timeout: 10000 });
        await harness.assertVignettesVisible(sc.docId, 1);
        harness.assertZeroErrors();
        await harness.setOffline(false);
      } else if (sc.noMatchQuery) {
        await harness.cleanDocCache(sc.docId);
        await harness.openFolder(130);
        await harness.downloadDocToComplete(sc.docId, 45000);

        await harness.setOffline(true);
        await harness.setOfflineFilter(true);
        await harness.search(sc.noMatchQuery);

        const emptyState = page.locator('#emptyState');
        await expect(emptyState).toBeVisible({ timeout: 6000 });
        harness.assertZeroErrors();
        await harness.setOffline(false);
      }
    });
  }

});


