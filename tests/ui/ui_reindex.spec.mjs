/**
 * DocSeeker - Test UI Réindexation Bibliothèque (ui_reindex.spec.mjs)
 *
 * Valide le bouton de réindexation complète dans les Réglages :
 * 1. Présence du bouton dans la section Maintenance
 * 2. Dialogue de confirmation rappelant la conservation des dossiers
 * 3. Appel de l'API /api/documents/reindex-all et notification toast
 * 4. Préservation de l'arborescence des dossiers
 */
import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';

test.describe('DocSeeker - Bouton Réindexer toute la bibliothèque', () => {
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

  test('Reindex-1 : Le bouton de réindexation complète fonctionne et préserve les dossiers', async ({ page }) => {
    // 1. Récupérer les dossiers avant réindexation pour vérifier leur intégrité
    const foldersBeforeRes = await page.request.get('/api/folders');
    expect(foldersBeforeRes.ok()).toBe(true);
    const foldersBefore = (await foldersBeforeRes.json()).folders || [];
    console.log(`[TEST Reindex-1] Dossiers initiaux avant réindexation : ${foldersBefore.length}`);

    // 2. Ouvrir la vue Réglages via la barre latérale
    await page.locator('#mainSidebarToggleBtn').click();
    await expect(page.locator('#mainSidebarDrawer')).toHaveClass(/open/);
    await page.locator('#navBtnSettings').click();
    await expect(page.locator('#viewSettings')).toBeVisible({ timeout: 6000 });

    // 3. Vérifier le bouton et son libellé
    const reindexBtn = page.locator('#settingsReindexAllBtn');
    await expect(reindexBtn).toBeVisible();
    await expect(reindexBtn).toHaveText('Réindexer les documents');

    // 4. Configurer la confirmation et intercepter la réponse réseau
    let dialogMessage = '';
    page.once('dialog', async dialog => {
      dialogMessage = dialog.message();
      console.log('[TEST Reindex-1] Confirmation dialog reçu :', dialogMessage.slice(0, 50));
      await dialog.accept();
    });

    const responsePromise = page.waitForResponse(
      resp => resp.url().includes('/api/documents/reindex-all') && resp.status() === 200,
      { timeout: 30000 }
    );

    // 5. Clic sur le bouton de réindexation
    await reindexBtn.click();

    // Vérifier le message de confirmation
    expect(dialogMessage).toContain('arborescence seront scrupuleusement conservés');

    // Vérifier la réponse API
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const resJson = await response.json();
    expect(resJson.status).toBe('ok');
    expect(typeof resJson.total_queued).toBe('number');
    expect(resJson.total_queued).toBeGreaterThan(0);
    console.log(`[TEST Reindex-1] API a retourné succès avec ${resJson.total_queued} documents mis en file d'attente.`);

    // 6. Vérifier l'affichage du toast de succès
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 5000 });
    await expect(toast).toContainText('Réindexation lancée');

    // 7. Vérifier que les dossiers sont toujours présents et intacts après réindexation
    const foldersAfterRes = await page.request.get('/api/folders');
    expect(foldersAfterRes.ok()).toBe(true);
    const foldersAfter = (await foldersAfterRes.json()).folders || [];
    expect(foldersAfter.length).toBe(foldersBefore.length);
    console.log(`✅ [Reindex-1] Réindexation déclenchée avec succès et ${foldersAfter.length} dossier(s) scrupuleusement conservés.`);
  });
});
