import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';

test('Reproduire le statut du dossier parent quand tous les fichiers sont en cache', async ({ page, context }) => {
  const h = new DocSeekerTestHarness(page, context);
  await h.authenticate();
  await h.goto('/');

  // Trouver le dossier Martingale (130)
  const folderCard = page.locator('.folder-card[data-folder-id="130"]');
  await expect(folderCard).toBeVisible({ timeout: 10000 });

  const docCountAttr = await folderCard.getAttribute('data-doc-count');
  console.log('Total doc_count attr:', docCountAttr);

  // Mettre tous les documents du dossier 130 en cache
  const docIds = [1, 2, 3, 10, 577];
  for (const id of docIds) {
    await h.ensureDocCached(id, { timeoutMs: 30000 });
  }

  // Vérifier ce que renvoie getCachedDocsCountForFolder
  const statusBefore = await page.evaluate(() => {
    const dqm = window.downloadQueueManager;
    return {
      cachedDocIds: Array.from(dqm?.cachedDocIds || []),
      cachedDocsCount: dqm?.getCachedDocsCountForFolder(130),
      cachedDocsListLength: dqm?._cachedDocsList?.length,
      libraryDocsListLength: dqm?._libraryDocsList?.length,
      allFoldersLength: dqm?._allFolders?.length,
    };
  });
  console.log('Status from DQM:', statusBefore);

  // Vérifier le bouton d'action du dossier
  const actionBtn = folderCard.locator('.sync-action-btn');
  const btnClass = await actionBtn.getAttribute('class');
  expect(btnClass).toContain('complete');

  // CAS REEL DU CLIENT : Simuler le bug où _cachedDocsList est vide (erreur SQLite doc_type sur OPFS)
  // Même si tous les docs sont dans cachedDocIds / OPFS, getCachedDocsCountForFolder renvoyait 0 !
  const isBugReproduced = await page.evaluate(() => {
    const dqm = window.downloadQueueManager;
    dqm._cachedDocsList = []; // Simule l'échec de getAllCachedDocuments
    const count = dqm.getCachedDocsCountForFolder(130);
    // Avant correction, count valait 0 même si tous les docs sont en cache !
    return count;
  });
  console.log('Count when _cachedDocsList is empty:', isBugReproduced);
  // Avec le code actuel non corrigé, ce count vaut 0 alors que tous les fichiers sont en cache !
  expect(isBugReproduced).toBe(5);
});
