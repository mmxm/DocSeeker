/**
 * DocSeeker - Tests UI Prise de Notes Markdown & Corbeille (ui_markdown_and_trash.spec.mjs)
 *
 * Valide les fonctionnalités :
 * 1. Bouton "+ Nouvelle note" dans la barre latérale
 * 2. Ouverture de l'éditeur Markdown avec titre éditable et éditeur WYSIWYG
 * 3. Vue Corbeille (accès via la barre latérale, badge de comptage, liste et actions)
 */
import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';

test.describe('DocSeeker - Prise de Notes Markdown & Corbeille', () => {
  let h;

  test.beforeEach(async ({ page, context }) => {
    h = new DocSeekerTestHarness(page, context);
    await h.authenticate();
    await h.goto('/');
  });

  test.afterEach(async () => {
    await h.resetState();
    h.assertZeroErrors({ ignoreNetworkNoise: true });
  });

  test('MD-1 : Présence du bouton Nouvelle Note et du conteneur d\'éditeur', async ({ page }) => {
    // 1. Vérifier la présence du bouton Nouvelle Note dans la barre d'outils
    const newNoteBtn = page.locator('#newMarkdownNoteBtn');
    await expect(newNoteBtn).toBeVisible();

    // 2. Ouvrir la barre latérale
    await page.locator('#mainSidebarToggleBtn').click();
    await expect(page.locator('#mainSidebarDrawer')).toHaveClass(/open/);

    // 3. Vérifier la présence de l'onglet Corbeille
    const trashBtn = page.locator('#navBtnTrash');
    await expect(trashBtn).toBeVisible();
  });

  test('MD-2 : Navigation vers la vue Corbeille', async ({ page }) => {
    // 1. Ouvrir la barre latérale et cliquer sur Corbeille
    await page.locator('#mainSidebarToggleBtn').click();
    await page.locator('#navBtnTrash').click();

    // 2. Vérifier l'affichage de la vue Corbeille
    await expect(page.locator('#viewTrash')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('#emptyTrashBtn')).toBeVisible();
  });

  test('MD-3 : Création d\'une note Markdown et affichage dans l\'éditeur', async ({ page }) => {
    const noteTitle = `Test Note ${Date.now()}`;

    // Configurer le prompt pour le titre de la note
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });

    // 1. Cliquer sur "Nouvelle note" dans la barre d'outils de documents
    await page.locator('#newMarkdownNoteBtn').click();

    // 2. Vérifier que le conteneur Markdown s'affiche
    const mdContainer = page.locator('#markdownEditorContainer');
    await expect(mdContainer).toBeVisible({ timeout: 10000 });

    // 3. Vérifier que le titre affiché correspond
    const titleInput = page.locator('#markdownTitleInput');
    await expect(titleInput).toHaveValue(noteTitle);

    // 4. Vérifier que la zone d'édition Milkdown est montée
    const milkdownRoot = page.locator('#milkdownRoot');
    await expect(milkdownRoot).toBeVisible();
  });

  test('MD-4 : Cycle complet création, mise en corbeille et restauration', async ({ page }) => {
    const noteTitle = `Cycle Test ${Date.now()}`;

    // 1. Création de la note
    const createPromise = page.waitForResponse(resp => resp.url().includes('/api/files') && resp.request().method() === 'POST');
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await createPromise;
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#markdownTitleInput')).toHaveValue(noteTitle);

    // 2. Mise en corbeille depuis l'éditeur
    const deletePromise = page.waitForResponse(resp => resp.url().includes('/api/files/') && resp.request().method() === 'DELETE');
    page.once('dialog', async dialog => {
      await dialog.accept();
    });
    await page.locator('#markdownTrashBtn').click();
    await deletePromise;

    // 3. Ouvrir la vue Corbeille
    await page.locator('#mainSidebarToggleBtn').click();
    await page.locator('#navBtnTrash').click();
    await expect(page.locator('#viewTrash')).toBeVisible({ timeout: 6000 });

    // 4. Vérifier que la note supprimée apparaît dans la liste des cartes de corbeille
    const trashCard = page.locator('.trash-card', { hasText: noteTitle });
    await expect(trashCard).toBeVisible({ timeout: 8000 });

    // 5. Restaurer la note depuis la corbeille
    const restorePromise = page.waitForResponse(resp => resp.url().includes('/restore'));
    await trashCard.locator('.btn-restore-trash').click();
    await restorePromise;

    // 6. Vérifier que la note n'est plus dans la corbeille
    await expect(trashCard).not.toBeVisible({ timeout: 8000 });
  });
});
