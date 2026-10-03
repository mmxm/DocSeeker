import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';

test.describe('Améliorations Navigation, Volet Accueil et Onglets', () => {
  let h;

  test.beforeEach(async ({ page, context }) => {
    h = new DocSeekerTestHarness(page, context);
    await h.authenticate();
    await h.goto('/');
    // Attendre que la bibliothèque soit prête
    await page.waitForSelector('#resultsPane', { state: 'visible', timeout: 10000 });
  });

  test.afterEach(async () => {
    await h.resetState();
    await h.assertZeroErrors();
  });

  test('NAV-1 : Le volet latéral d\'accueil est positionné sous l\'en-tête (ne couvre ni la barre d\'onglets ni la recherche)', async ({ page }) => {
    // 1. Ouvrir un onglet pour afficher la barre d'onglets, puis revenir à l'accueil
    await page.evaluate(() => {
      window.tabManager.openTab(1, 'Document Test', 1);
      window.tabManager.returnToHome();
    });

    // Vérifier que la barre d'onglets est visible
    const tabBar = page.locator('#readerTopTabBar');
    await expect(tabBar).toBeVisible({ timeout: 8000 });

    // 2. Vérifier que la barre d'onglets et le header de recherche sont tous deux visibles sur l'accueil
    await expect(tabBar).toBeVisible();
    const appHeader = page.locator('#appHeader');
    await expect(appHeader).toBeVisible();
    const searchInput = page.locator('#searchInput');
    await expect(searchInput).toBeVisible();

    // 3. Ouvrir le volet latéral d'accueil
    const toggleBtn = page.locator('#mainSidebarToggleBtn');
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();

    const drawer = page.locator('#mainSidebarDrawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveClass(/open/);
    await expect(toggleBtn).toHaveClass(/active/);

    // 4. Vérifier la géométrie : le volet doit commencer sous le header et ne pas le recouvrir
    const headerBox = await appHeader.boundingBox();
    const drawerBox = await drawer.boundingBox();
    const tabBarBox = await tabBar.boundingBox();

    expect(headerBox).not.toBeNull();
    expect(drawerBox).not.toBeNull();
    expect(tabBarBox).not.toBeNull();

    // Le sommet du volet est situé sous l'en-tête (avec une tolérance de 2px de subpixel rendering)
    expect(drawerBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 2);

    // La barre de recherche reste interactive et non masquée
    await searchInput.fill('test position');
    expect(await searchInput.inputValue()).toBe('test position');
    await searchInput.fill('');

    // 5. Fermer le volet via le bouton de fermeture interne
    const closeBtn = page.locator('#closeMainSidebarBtn');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(drawer).not.toHaveClass(/open/);
    await expect(toggleBtn).not.toHaveClass(/active/);

    // 6. Rouvrir puis refermer via le toggle button
    await toggleBtn.click();
    await expect(drawer).toHaveClass(/open/);
    await toggleBtn.click();
    await expect(drawer).not.toHaveClass(/open/);
  });

  test('NAV-2 : Navigation dans l\'arborescence avec les flèches Précédent et Suivant', async ({ page }) => {
    const backBtn = page.locator('#folderNavBackBtn');
    const forwardBtn = page.locator('#folderNavForwardBtn');
    const breadcrumbsNav = page.locator('#breadcrumbsNav');

    await expect(backBtn).toBeVisible();
    await expect(forwardBtn).toBeVisible();

    // 1. À la racine, les deux boutons doivent être désactivés
    await expect(backBtn).toBeDisabled();
    await expect(forwardBtn).toBeDisabled();

    // 2. Trouver un dossier et entrer dedans
    const folderCard = page.locator('.folder-card').first();
    const folderCount = await folderCard.count();
    let folderName = '';

    if (folderCount > 0) {
      folderName = (await folderCard.locator('.goodnotes-row-title, .folder-name').first().textContent() || '').trim();
      await folderCard.click();
    } else {
      // Si aucun dossier n'existe dans le jeu de test, utiliser window.enterFolder
      await page.evaluate(() => {
        window.enterFolder({ id: 9999, name: 'Dossier Test' });
      });
      folderName = 'Dossier Test';
    }

    // 3. Après être entré dans le dossier, Précédent est activé, Suivant est désactivé
    await expect(backBtn).toBeEnabled({ timeout: 6000 });
    await expect(forwardBtn).toBeDisabled();
    await expect(breadcrumbsNav).toContainText(folderName);

    // 4. Cliquer sur Précédent : retour à la racine
    await backBtn.click();
    await expect(backBtn).toBeDisabled();
    await expect(forwardBtn).toBeEnabled();

    // Vérifier que le fil d'Ariane est revenu à la racine
    const activeCrumb = page.locator('.breadcrumb-item.active');
    await expect(activeCrumb).toHaveAttribute('data-folder-id', 'root');

    // 5. Cliquer sur Suivant : retour dans le dossier
    await forwardBtn.click();
    await expect(backBtn).toBeEnabled();
    await expect(forwardBtn).toBeDisabled();
    await expect(breadcrumbsNav).toContainText(folderName);
  });

  test('NAV-3 : Réorganisation des onglets par drag & drop', async ({ page }) => {
    // 1. Initialiser 3 onglets distincts via tabManager
    await page.evaluate(() => {
      const tm = window.tabManager;
      if (tm) {
        tm.openTabs = [
          { id: 'tab-alpha', docId: 101, title: 'Onglet Alpha', docType: 'pdf' },
          { id: 'tab-beta', docId: 102, title: 'Onglet Beta', docType: 'pdf' },
          { id: 'tab-gamma', docId: 103, title: 'Onglet Gamma', docType: 'md' }
        ];
        tm.activeTabId = 'tab-alpha';
        tm.renderTabsUI();
      }
    });

    const tabStrip = page.locator('#readerTabsStrip');
    await expect(tabStrip).toBeVisible();

    // 2. Vérifier l'ordre initial
    let tabItems = tabStrip.locator('.reader-tab-item');
    await expect(tabItems).toHaveCount(3);
    await expect(tabItems.nth(0)).toHaveAttribute('data-tab-id', 'tab-alpha');
    await expect(tabItems.nth(1)).toHaveAttribute('data-tab-id', 'tab-beta');
    await expect(tabItems.nth(2)).toHaveAttribute('data-tab-id', 'tab-gamma');

    // Vérifier que tous les onglets possèdent l'attribut draggable="true"
    for (let i = 0; i < 3; i++) {
      await expect(tabItems.nth(i)).toHaveAttribute('draggable', 'true');
    }

    // 3. Déplacer 'tab-alpha' après 'tab-gamma' via simulation d'événements Drag & Drop réalistes
    await page.evaluate(() => {
      const strip = document.getElementById('readerTabsStrip');
      const tabs = strip.querySelectorAll('.reader-tab-item');
      const source = tabs[0]; // tab-alpha
      const target = tabs[2]; // tab-gamma

      // Dragstart sur la source
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));

      // Dragover sur la cible (partie droite pour déposer après)
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width - 2
      }));

      // Drop sur la cible
      target.dispatchEvent(new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width - 2
      }));

      // Dragend sur la source
      source.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });

    // 4. Vérifier le nouvel ordre dans le DOM : Beta (0), Gamma (1), Alpha (2)
    tabItems = tabStrip.locator('.reader-tab-item');
    await expect(tabItems.nth(0)).toHaveAttribute('data-tab-id', 'tab-beta');
    await expect(tabItems.nth(1)).toHaveAttribute('data-tab-id', 'tab-gamma');
    await expect(tabItems.nth(2)).toHaveAttribute('data-tab-id', 'tab-alpha');

    // 5. Déplacer maintenant 'tab-gamma' avant 'tab-beta'
    await page.evaluate(() => {
      const strip = document.getElementById('readerTabsStrip');
      const tabs = strip.querySelectorAll('.reader-tab-item');
      const source = tabs[1]; // tab-gamma
      const target = tabs[0]; // tab-beta

      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));

      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 2 // partie gauche pour déposer avant
      }));

      target.dispatchEvent(new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 2
      }));

      source.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });

    // 6. Vérifier l'ordre final : Gamma (0), Beta (1), Alpha (2)
    tabItems = tabStrip.locator('.reader-tab-item');
    await expect(tabItems.nth(0)).toHaveAttribute('data-tab-id', 'tab-gamma');
    await expect(tabItems.nth(1)).toHaveAttribute('data-tab-id', 'tab-beta');
    await expect(tabItems.nth(2)).toHaveAttribute('data-tab-id', 'tab-alpha');

    // 7. Vérifier que cliquer sur un onglet réorganisé fonctionne et l'active
    await tabItems.nth(0).click();
    await expect(tabItems.nth(0)).toHaveClass(/active/);
  });

  test('NAV-4 : Préservation de la progression de lecture lors du basculement PDF -> Accueil -> PDF', async ({ page }) => {
    // 1. Obtenir un document PDF réel disponible avec du contenu
    const targetDoc = await page.evaluate(async () => {
      const res = await fetch('/api/documents');
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.documents || []);
      const pdfs = list.filter(d => d.total_pages >= 5 && !d.filename?.endsWith('.md') && d.file_size > 0 && d.file_size < 5000000);
      return pdfs[0] || list.find(d => d.total_pages >= 5 && !d.filename?.endsWith('.md'));
    });
    expect(targetDoc).not.toBeNull();
    const docId = targetDoc.id;
    const docTitle = targetDoc.title || targetDoc.filename;

    // 2. Ouvrir le document dans un onglet
    await page.evaluate(({ id, title }) => {
      window.tabManager.openTab(id, title, 1);
    }, { id: docId, title: docTitle });

    await expect(page.locator('#workspace')).toHaveClass(/split-active/, { timeout: 10000 });
    await h.assertPdfViewerRendered();
    // Laisser PDF.js finaliser son rendu et son cadrage initial (hash #page=1)
    await page.waitForTimeout(800);

    // 3. Faire défiler le document (ex: scrollTop = 500)
    await page.evaluate(() => {
      const win = document.getElementById('pdfFrame')?.contentWindow;
      const container = win?.document?.getElementById('viewerContainer');
      if (container) {
        container.scrollTop = 500;
        container.dispatchEvent(new Event('scroll'));
      }
    });
    await page.waitForTimeout(400);

    const savedStateBeforeHome = await page.evaluate(() => {
      const tab = window.tabManager.openTabs.find(t => t.id === window.tabManager.activeTabId);
      const win = document.getElementById('pdfFrame')?.contentWindow;
      const container = win?.document?.getElementById('viewerContainer');
      return {
        tabScrollTop: tab?.scrollTop,
        containerScrollTop: container?.scrollTop,
        page: win?.PDFViewerApplication?.page
      };
    });
    expect(savedStateBeforeHome.containerScrollTop).toBeGreaterThanOrEqual(400);

    // 4. Basculer vers l'onglet Accueil via le bouton Accueil
    const homeBtn = page.locator('#readerHomeBtn');
    await expect(homeBtn).toBeVisible();
    await homeBtn.click();

    // Vérifier que le mode Accueil est bien actif
    await expect(page.locator('body')).toHaveClass(/home-tab-active/);
    await expect(page.locator('#viewerPane')).toBeHidden();
    await expect(page.locator('#resultsPane')).toBeVisible();

    // Vérifier que dans le tabManager, l'état de l'onglet PDF a bien conservé son scroll
    const tabStateInHome = await page.evaluate((id) => {
      const tab = window.tabManager.openTabs.find(t => Number(t.docId) === Number(id));
      return {
        page: tab?.page,
        scrollTop: tab?.scrollTop
      };
    }, docId);
    expect(tabStateInHome.scrollTop).toBeGreaterThanOrEqual(400);

    // 5. Revenir sur l'onglet du PDF en cliquant dessus dans la barre d'onglets
    const pdfTab = page.locator('.reader-tab-item').first();
    await pdfTab.click();

    // Vérifier que le viewer est immédiatement réaffiché
    await expect(page.locator('#workspace')).toHaveClass(/split-active/);
    await expect(page.locator('#viewerPane')).toBeVisible();
    await h.assertPdfViewerRendered();

    // 6. Vérifier que la progression de lecture (scrollTop) est intacte
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const win = document.getElementById('pdfFrame')?.contentWindow;
        const container = win?.document?.getElementById('viewerContainer');
        return container?.scrollTop || 0;
      });
    }, { timeout: 6000 }).toBeGreaterThanOrEqual(400);

    const finalState = await page.evaluate(() => {
      const win = document.getElementById('pdfFrame')?.contentWindow;
      const container = win?.document?.getElementById('viewerContainer');
      return {
        scrollTop: container?.scrollTop,
        page: win?.PDFViewerApplication?.page
      };
    });
    expect(finalState.scrollTop).toBeGreaterThanOrEqual(400);
  });

  test('NAV-5 : Préservation de la progression de lecture lors du basculement PDF A -> PDF B -> PDF A (avec occurrences)', async ({ page }) => {
    // 1. Obtenir deux documents PDF réels distincts de taille légère (< 2 Mo)
    const testDocs = await page.evaluate(async () => {
      const res = await fetch('/api/documents');
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.documents || []);
      const pdfs = list.filter(d => d.total_pages >= 5 && !d.filename?.endsWith('.md') && d.file_size > 0 && d.file_size < 5000000);
      return pdfs.length >= 2 ? pdfs.slice(0, 2) : list.filter(d => d.total_pages >= 5 && !d.filename?.endsWith('.md')).slice(0, 2);
    });
    expect(testDocs.length).toBeGreaterThanOrEqual(2);
    const docA = testDocs[0];
    const docB = testDocs[1];

    // 2. Ouvrir Doc A avec une occurrence simulée sur la page 1
    await page.evaluate(({ id, title }) => {
      window.tabManager.openTab(id, title, 1, [
        { occ_id: 'occ_test_1', page_number: 1, rect: [50, 50, 150, 70], y_ratio: 0.1 }
      ], [50, 50, 150, 70], 0.1, 'occ_test_1', 'recherche test');
    }, { id: docA.id, title: docA.title || docA.filename });

    await expect(page.locator('#workspace')).toHaveClass(/split-active/, { timeout: 10000 });
    await h.assertPdfViewerRendered();
    await page.waitForTimeout(800);

    // 3. L'utilisateur lit et scrolle plus bas dans Doc A (ex: scrollTop = 650)
    await page.evaluate(() => {
      const win = document.getElementById('pdfFrame')?.contentWindow;
      const container = win?.document?.getElementById('viewerContainer');
      if (container) {
        container.scrollTop = 650;
        container.dispatchEvent(new Event('scroll'));
      }
    });
    await page.waitForTimeout(400);

    // 4. Ouvrir Doc B dans un deuxième onglet
    await page.evaluate(({ id, title }) => {
      window.tabManager.openTab(id, title, 1);
    }, { id: docB.id, title: docB.title || docB.filename });

    await expect(page.locator('.reader-tab-item')).toHaveCount(2);
    await h.assertPdfViewerRendered();
    await page.waitForTimeout(800);

    // Défiler également dans Doc B (scrollTop = 420)
    await page.evaluate(() => {
      const win = document.getElementById('pdfFrame')?.contentWindow;
      const container = win?.document?.getElementById('viewerContainer');
      if (container) {
        container.scrollTop = 420;
        container.dispatchEvent(new Event('scroll'));
      }
    });
    await page.waitForTimeout(400);

    // 5. Revenir sur l'onglet Doc A (premier onglet)
    const tabA = page.locator('.reader-tab-item').first();
    await tabA.click();
    await h.assertPdfViewerRendered();

    // Vérifier que Doc A a conservé son scroll et n'a PAS été réinitialisé à 0 ni écrasé par l'occurrence
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const win = document.getElementById('pdfFrame')?.contentWindow;
        const container = win?.document?.getElementById('viewerContainer');
        return container?.scrollTop || 0;
      });
    }, { timeout: 6000 }).toBeGreaterThanOrEqual(550);

    // 6. Revenir sur l'onglet Doc B (deuxième onglet)
    const tabB = page.locator('.reader-tab-item').nth(1);
    await tabB.click();
    await h.assertPdfViewerRendered();

    // Vérifier que Doc B a également conservé son scroll
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const win = document.getElementById('pdfFrame')?.contentWindow;
        const container = win?.document?.getElementById('viewerContainer');
        return container?.scrollTop || 0;
      });
    }, { timeout: 6000 }).toBeGreaterThanOrEqual(350);
  });

  test('NAV-6 : Retour sur l\'onglet d\'une note Markdown sans erreur PDF invalide ou corrompu (MD -> Accueil -> MD et MD -> PDF -> MD)', async ({ page }) => {
    // Collecter les erreurs et warnings de la console
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' || msg.text().includes('Invalid PDF structure') || msg.text().includes('Réouverture à chaud')) {
        consoleErrors.push(msg.text());
      }
    });

    // 1. Créer une note Markdown via l'API
    const noteName = `note_tabs_test_${Date.now()}.md`;
    const createRes = await page.request.post('/api/files', {
      data: {
        filename: noteName,
        content: '# Ma super note markdown\n\nContenu de test pour la validation des onglets.'
      }
    });
    expect(createRes.ok()).toBeTruthy();
    const noteData = await createRes.json();
    const noteDocId = noteData.doc_id;

    // 2. Obtenir un petit PDF disponible
    const pdfDoc = await page.evaluate(async () => {
      const res = await fetch('/api/documents');
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.documents || []);
      const pdfs = list.filter(d => d.total_pages >= 5 && !d.filename?.endsWith('.md') && d.file_size > 0 && d.file_size < 5000000);
      return pdfs[0] || list.find(d => d.total_pages >= 5 && !d.filename?.endsWith('.md'));
    });
    expect(pdfDoc).not.toBeNull();

    // 3. Ouvrir la note Markdown dans un onglet
    await page.evaluate(({ id, filename }) => {
      const title = filename.replace(/\.md$/, '');
      window.tabManager.openTab(id, title, 1, [], null, 0, null, null, true, filename);
    }, { id: noteDocId, filename: noteName });

    // Vérifier que le visualiseur est actif avec le conteneur Markdown visible et l'iframe PDF cachée
    await expect(page.locator('#workspace')).toHaveClass(/split-active/);
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#pdfFrame')).toBeHidden();

    // 4. Basculer vers l'onglet Accueil via le bouton Accueil
    const homeBtn = page.locator('#readerHomeBtn');
    await homeBtn.click();
    await expect(page.locator('body')).toHaveClass(/home-tab-active/);

    // Simuler le changement de liste chargée (ex: navigation dossier / recherche)
    await page.evaluate(() => {
      window.currentLoadedDocs = [];
    });

    // 5. Revenir sur l'onglet de la note Markdown
    const mdTab = page.locator('.reader-tab-item').first();
    await mdTab.click();

    // Vérifier que le conteneur Markdown réapparaît immédiatement SANS charger PDF.js
    await expect(page.locator('#workspace')).toHaveClass(/split-active/);
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#pdfFrame')).toBeHidden();

    // 6. Ouvrir le document PDF dans un second onglet
    await page.evaluate(({ id, title }) => {
      window.tabManager.openTab(id, title, 1);
    }, { id: pdfDoc.id, title: pdfDoc.title || pdfDoc.filename });

    await expect(page.locator('.reader-tab-item')).toHaveCount(2);
    await expect(page.locator('#pdfFrame')).toBeVisible({ timeout: 10000 });
    await h.assertPdfViewerRendered();

    // 7. Revenir de l'onglet PDF à l'onglet Markdown
    await mdTab.click();

    // Vérifier que la note Markdown est réaffichée sans erreur PDF
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#pdfFrame')).toBeHidden();

    // Vérifier qu'aucune erreur "Invalid PDF structure" n'a été émise
    const invalidPdfErrors = consoleErrors.filter(e => e.includes('Invalid PDF structure') || e.includes('InvalidPDFException'));
    expect(invalidPdfErrors).toHaveLength(0);

    // Nettoyage de la note créée
    await page.request.delete(`/api/files/${encodeURIComponent(noteName)}`).catch(() => {});
  });
});

