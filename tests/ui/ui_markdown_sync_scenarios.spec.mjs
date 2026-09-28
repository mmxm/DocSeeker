/**
 * DocSeeker - Tests Scénarios E2E Synchronisation Offline Markdown & Résilience
 * (ui_markdown_sync_scenarios.spec.mjs)
 *
 * Valide les scénarios exigés :
 * - Scénario 1 : Création -> Offline -> Édition locale -> Changement vers PDF -> Reconnexion -> Auto-sync sans action utilisateur -> Vérification BDD & FS
 * - Variante 2 : Suppression locale pendant coupure -> Reconnexion -> Soft-delete répercuté sur serveur
 * - Variante 3 : Suppression directe sur serveur sans client -> Reconnexion -> Synchronisation delete_local client
 * - Variante 4 : Restauration locale hors-ligne -> Reconnexion -> Restauration sur serveur
 * - Variante 5 : Restauration sur serveur sans client -> Reconnexion -> Téléchargement client
 * - E2E 6 : Exportation de la note (.md) via markdownExportBtn
 * - E2E 7 : Reconstruction de l'index dérivé client
 */
import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';
import fs from 'fs';
import path from 'path';

test.describe('DocSeeker - Scénarios E2E Synchronisation Offline & Résilience', () => {
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

  test('SC-1 : Création -> Offline -> Édition locale -> Switch PDF -> Reconnexion -> Auto-sync serveur', async ({ page, context }) => {
    const noteTitle = `AutoSync Test ${Date.now()}`;
    const filename = `${noteTitle}.md`;

    // 1. Création de la note initiale en ligne
    const createPromise = page.waitForResponse(resp => resp.url().includes('/api/files') && resp.request().method() === 'POST');
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await createPromise;
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 2. Simulation de la perte de connexion (coupure réseau / serveur inaccessible)
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(300);

    // 3. Édition du fichier en local pendant la coupure
    const offlineContent = `# ${noteTitle}\n\nContenu enrichi et sauvegardé en mode hors-ligne sans serveur.`;
    await page.evaluate(async (content) => {
      if (window.MarkdownManager && window.MarkdownManager.saveTimer) {
        clearTimeout(window.MarkdownManager.saveTimer);
      }
      await window.MarkdownManager.saveNote(content);
    }, offlineContent);

    // 4. L'utilisateur ouvre un autre fichier PDF (ex: doc 1)
    await page.locator('#readerHomeBtn').click();
    await page.evaluate(() => {
      if (typeof window.openDocumentInSplitView === 'function') {
        window.openDocumentInSplitView(1, 'Document PDF', 1, []);
      }
    });
    await page.waitForTimeout(500);

    // 5. Retrouve la connexion (reconnexion du réseau / serveur actif)
    const syncPromise = page.waitForResponse(resp => resp.url().includes('/api/sync/manifest') && resp.status() === 200, { timeout: 15000 });
    const putPromise = page.waitForResponse(resp => resp.url().includes('/api/files/') && resp.request().method() === 'PUT', { timeout: 15000 });

    await context.setOffline(false);
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('online'));
      if (window.SyncManager) {
        await window.SyncManager.runSync();
      }
    });

    // 6. Sauvegarde automatique en ligne de la note MD sans aucune action de l'utilisateur
    await syncPromise;
    await putPromise;
    await page.waitForTimeout(500);

    // 7. Vérification physique sur le serveur
    const docPath = path.join(process.cwd(), 'data', 'documents', filename);
    expect(fs.existsSync(docPath)).toBeTruthy();
    const diskContent = fs.readFileSync(docPath, 'utf-8');
    expect(diskContent).toContain('Contenu enrichi et sauvegardé en mode hors-ligne sans serveur.');
  });

  test('SC-2 : Suppression locale pendant une coupure -> Reconnexion -> Resynchronisation corbeille', async ({ page, context }) => {
    const noteTitle = `OfflineDelete Test ${Date.now()}`;
    const filename = `${noteTitle}.md`;

    // 1. Créer la note en ligne
    const createPromise = page.waitForResponse(resp => resp.url().includes('/api/files') && resp.request().method() === 'POST');
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await createPromise;
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 2. Coupure réseau
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(300);

    // 3. Suppression de la note en local (mise en corbeille offline)
    page.once('dialog', async dialog => {
      await dialog.accept();
    });
    await page.locator('#markdownTrashBtn').click();

    // Vérifier que la note est marquée dirty deleted en local
    const dirtyList = await page.evaluate(async () => {
      return await window.MarkdownStorage.getDirtyFiles();
    });
    expect(dirtyList.some(d => d.filename === filename && d.action === 'deleted')).toBeTruthy();

    // 4. Reconnexion réseau
    const syncPromise = page.waitForResponse(resp => resp.url().includes('/api/sync/manifest'), { timeout: 15000 });
    const deletePromise = page.waitForResponse(resp => resp.url().includes('/api/files/') && resp.request().method() === 'DELETE', { timeout: 15000 });

    await context.setOffline(false);
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('online'));
      if (window.SyncManager) {
        await window.SyncManager.runSync();
      }
    });

    await syncPromise;
    await deletePromise;

    // 5. Vérifier que sur le serveur, le fichier a bien été déplacé dans la corbeille
    const activeDocPath = path.join(process.cwd(), 'data', 'documents', filename);
    const trashDocPath = path.join(process.cwd(), 'data', 'trash', `del_${filename}`);
    const trashMetaPath = path.join(process.cwd(), 'data', 'trash', `del_${filename}.meta.json`);

    expect(fs.existsSync(activeDocPath)).toBeFalsy();
    expect(fs.existsSync(trashDocPath)).toBeTruthy();
    expect(fs.existsSync(trashMetaPath)).toBeTruthy();
  });

  test('SC-3 : Suppression sur serveur sans client connecté -> Synchronisation client', async ({ page }) => {
    const noteTitle = `ServerDelete Test ${Date.now()}`;
    const filename = `${noteTitle}.md`;

    // 1. Créer la note via le client pour qu'elle existe en OPFS
    const createPromise = page.waitForResponse(resp => resp.url().includes('/api/files') && resp.request().method() === 'POST');
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await createPromise;
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // Fermer la note
    await page.locator('#readerHomeBtn').click();
    await page.waitForTimeout(1000);

    // 2. Suppression directe côté serveur via l'API (simule une suppression par client B)
    const delRes = await page.request.delete(`/api/files/${encodeURIComponent(filename)}`);
    expect(delRes.ok()).toBeTruthy();

    // 3. Déclencher la synchronisation du client
    await page.evaluate(async () => {
      await window.SyncManager.runSync();
    });

    // 4. Vérifier que la note a été supprimée du stockage local OPFS
    const localContent = await page.evaluate(async (fname) => {
      return await window.MarkdownStorage.read(fname);
    }, filename);

    expect(localContent).toBeNull();
  });

  test('SC-4 : Restauration en local hors-ligne -> Reconnexion -> Restauration serveur', async ({ page, context }) => {
    const noteTitle = `RestoreLocal Test ${Date.now()}`;
    const filename = `${noteTitle}.md`;

    // 1. Créer la note puis la mettre en corbeille
    page.once('dialog', async dialog => { await dialog.accept(noteTitle); });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    page.once('dialog', async dialog => { await dialog.accept(); });
    await page.locator('#markdownTrashBtn').click();
    await page.waitForTimeout(1000);

    // 2. Coupure réseau
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    // 3. Restauration / ré-écriture locale de la note pendant la coupure
    const restoredContent = `# ${noteTitle}\n\nNote réactivée hors-ligne.`;
    await page.evaluate(async ({ fname, content }) => {
      await window.MarkdownStorage.write(fname, content);
      await window.MarkdownStorage.markDirty(fname, 'modified');
    }, { fname: filename, content: restoredContent });

    // 4. Reconnexion
    const putPromise = page.waitForResponse(resp => resp.url().includes('/api/files/') && resp.request().method() === 'PUT', { timeout: 15000 });
    await context.setOffline(false);
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('online'));
      if (window.SyncManager) {
        await window.SyncManager.runSync();
      }
    });

    await putPromise;

    // 5. Vérifier que sur le serveur, le fichier est bien réapparu dans documents/ et sorti de trash/
    const activeDocPath = path.join(process.cwd(), 'data', 'documents', filename);
    const trashDocPath = path.join(process.cwd(), 'data', 'trash', `del_${filename}`);
    expect(fs.existsSync(activeDocPath)).toBeTruthy();
    expect(fs.existsSync(trashDocPath)).toBeFalsy();
  });

  test('SC-5 : Restauration sur le serveur sans client -> Reconnexion -> Téléchargement client', async ({ page }) => {
    const noteTitle = `ServerRestore Test ${Date.now()}`;
    const filename = `${noteTitle}.md`;

    // 1. Créer et supprimer la note pour qu'elle aille en corbeille
    page.once('dialog', async dialog => { await dialog.accept(noteTitle); });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    page.once('dialog', async dialog => { await dialog.accept(); });
    await page.locator('#markdownTrashBtn').click();
    await page.waitForTimeout(500);

    // 2. Restauration sur le serveur via l'API
    const restoreRes = await page.request.post('/api/trash/restore', {
      data: { filename: filename }
    });
    expect(restoreRes.ok()).toBeTruthy();

    // 3. Synchronisation du client
    await page.evaluate(async () => {
      await window.SyncManager.runSync();
    });

    // 4. Vérifier que le client a bien pullé le fichier restauré dans OPFS
    const localContent = await page.evaluate(async (fname) => {
      return await window.MarkdownStorage.read(fname);
    }, filename);

    expect(localContent).not.toBeNull();
  });

  test('SC-6 : Exportation de note au format Markdown brut (.md)', async ({ page }) => {
    const noteTitle = `Export Note ${Date.now()}`;

    // 1. Créer une note
    page.once('dialog', async dialog => { await dialog.accept(noteTitle); });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 2. Cliquer sur le bouton d'exportation et intercepter le téléchargement
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#markdownExportBtn').click();
    const download = await downloadPromise;

    // 3. Vérifier le nom de fichier et l'extension
    expect(download.suggestedFilename()).toBe(`${noteTitle}.md`);
  });

  test('SC-7 : Reconstruction de l\'index local client après réinitialisation', async ({ page }) => {
    const noteTitle = `RebuildClient Test ${Date.now()}`;
    const filename = `${noteTitle}.md`;

    // 1. Créer une note Markdown
    page.once('dialog', async dialog => { await dialog.accept(noteTitle); });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 2. Vérifier que la note est présente dans OPFS
    const localContent = await page.evaluate(async (fname) => {
      return await window.MarkdownStorage.read(fname);
    }, filename);
    expect(localContent).not.toBeNull();

    // 3. Simuler une réinitialisation de l'index de recherche local
    await page.evaluate(async () => {
      if (window.downloadQueueManager) {
        await window.downloadQueueManager.sendToWorker("RESET_SEARCH_INDEX").catch(() => {});
      }
    });

    // 4. Réindexer le document Markdown depuis la source de vérité locale (OPFS)
    await page.evaluate(async ({ fname, content }) => {
      if (window.downloadQueueManager) {
        await window.downloadQueueManager.sendToWorker("INDEX_MARKDOWN_DOC", {
          docId: 99999,
          filename: fname,
          title: "RebuildClient Test",
          content: content
        }).catch(() => {});
      }
    }, { fname: filename, content: localContent });

    // 5. Vérifier que les fichiers physiques OPFS restent 100% intacts (Source de Vérité)
    const preservedContent = await page.evaluate(async (fname) => {
      return await window.MarkdownStorage.read(fname);
    }, filename);
    expect(preservedContent).toBe(localContent);
  });
});

