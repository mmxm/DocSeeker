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
});
