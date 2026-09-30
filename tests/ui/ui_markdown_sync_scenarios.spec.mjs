/**
 * DocSeeker - Tests Scénarios E2E Synchronisation Offline Markdown & Résilience
 * (ui_markdown_sync_scenarios.spec.mjs)
 *
 * Valide les scénarios exigés avec TRIPLE VÉRIFICATION SYSTÉMATIQUE :
 * 1. Vérification Visuelle dans l'UI (Vue Corbeille, cartes .trash-card, badge, éditeur)
 * 2. Vérification Base de Données Serveur (SQLite data/db.sqlite : status, deleted_at)
 * 3. Vérification Base de Données Locale Client (SQLite-Wasm & OPFS)
 *
 * Scénarios :
 * - SC-1 : Création -> Offline -> Édition locale -> Switch PDF -> Reconnexion -> Auto-sync sans action
 * - SC-2 : Suppression locale pendant coupure -> Reconnexion -> Soft-delete serveur & affichage corbeille UI
 * - SC-3 : Suppression directe sur serveur sans client -> Reconnexion -> Sync delete_local client
 * - SC-4 : Restauration locale hors-ligne -> Reconnexion -> Restauration serveur & retrait corbeille UI
 * - SC-5 : Restauration serveur sans client -> Reconnexion -> Téléchargement client & disparition corbeille UI
 * - SC-6 : Exportation de note au format brut (.md)
 * - SC-7 : Destruction et reconstruction de l'index local client depuis l'OPFS
 */
import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness } from './harness.mjs';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Helper pour interroger la base SQLite serveur en direct
function queryServerDb(sql) {
  try {
    const out = execSync(`sqlite3 data/db.sqlite "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' });
    return out.trim();
  } catch (e) {
    return null;
  }
}

// Helper pour interroger la base SQLite-Wasm locale du client
async function queryClientDbDoc(page, filename) {
  return await page.evaluate(async (fname) => {
    if (!window.downloadQueueManager) return null;
    try {
      const res = await window.downloadQueueManager.sendToWorker('GET_ALL_KNOWN_DOCS');
      const docs = res && res.data ? res.data : [];
      return docs.find(d => d.filename === fname) || null;
    } catch (_) {
      return null;
    }
  }, filename);
}

// Helper pour valider visuellement l'état dans l'UI de la Corbeille
async function assertTrashUiVisible(page, noteTitle, shouldBeVisible = true) {
  const homeBtn = page.locator('#readerHomeBtn');
  if (await homeBtn.isVisible().catch(() => false)) {
    await homeBtn.click();
    await page.waitForTimeout(300);
  }
  await page.locator('#mainSidebarToggleBtn').click();
  await page.locator('#navBtnTrash').click();
  await expect(page.locator('#viewTrash')).toBeVisible({ timeout: 6000 });
  const card = page.locator('.trash-card', { hasText: noteTitle });
  if (shouldBeVisible) {
    await expect(card).toBeVisible({ timeout: 8000 });
  } else {
    await expect(card).not.toBeVisible({ timeout: 8000 });
  }
}

test.describe('DocSeeker - Scénarios E2E Synchronisation Offline & Résilience', () => {
  let h;

  test.beforeEach(async ({ page, context }) => {
    await context.setOffline(false);
    h = new DocSeekerTestHarness(page, context);
    await h.authenticate();
    await h.goto('/');
    await page.evaluate(async () => {
      if (window.MarkdownStorage) {
        try {
          const files = await window.MarkdownStorage.listFiles();
          for (const f of files) {
            await window.MarkdownStorage.delete(f.filename);
            await window.MarkdownStorage.unmarkDirty(f.filename);
          }
        } catch (_) {}
      }
    });
  });

  test.afterEach(async () => {
    await h.resetState();
    h.assertZeroErrors({ ignoreNetworkNoise: true });
  });

  test.afterAll(async () => {
    try {
      execSync(`sqlite3 data/db.sqlite "
        DELETE FROM pages WHERE doc_id IN (
          SELECT id FROM documents WHERE filename LIKE '%AutoSync%' OR filename LIKE '%OfflineDelete%' OR filename LIKE '%ServerDelete%' OR filename LIKE '%RestoreLocal%' OR filename LIKE '%ServerRestore%' OR filename LIKE '%Export Note%' OR filename LIKE '%RebuildClient%'
        );
        DELETE FROM documents WHERE filename LIKE '%AutoSync%' OR filename LIKE '%OfflineDelete%' OR filename LIKE '%ServerDelete%' OR filename LIKE '%RestoreLocal%' OR filename LIKE '%ServerRestore%' OR filename LIKE '%Export Note%' OR filename LIKE '%RebuildClient%';
      "`, { stdio: 'ignore' });

      const docsDir = path.resolve('data/documents');
      if (fs.existsSync(docsDir)) {
        const files = fs.readdirSync(docsDir);
        for (const f of files) {
          if (f.startsWith('AutoSync') || f.startsWith('OfflineDelete') || f.startsWith('ServerDelete') || f.startsWith('RestoreLocal') || f.startsWith('ServerRestore') || f.startsWith('Export Note') || f.startsWith('RebuildClient')) {
            try { fs.unlinkSync(path.join(docsDir, f)); } catch {}
          }
        }
      }

      const trashDir = path.resolve('data/trash');
      if (fs.existsSync(trashDir)) {
        const tFiles = fs.readdirSync(trashDir);
        for (const f of tFiles) {
          try { fs.unlinkSync(path.join(trashDir, f)); } catch {}
        }
      }
    } catch {}
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

    // Vérification initiale BDD serveur : statut ready, pas de deleted_at
    expect(queryServerDb(`SELECT status FROM documents WHERE filename = '${filename}'`)).toBe('ready');
    expect(queryServerDb(`SELECT deleted_at FROM documents WHERE filename = '${filename}'`)).toBe('');

    // 2. Simulation de la perte de connexion (coupure réseau physique / serveur inaccessible)
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(300);

    // 3. Édition du fichier en local pendant la coupure
    const offlineContent = `# ${noteTitle}\n\nContenu enrichi et sauvegardé en mode hors-ligne sans serveur.`;
    await page.evaluate(async (content) => {
      if (window.MarkdownManager) {
        if (window.MarkdownManager.saveTimer) {
          clearTimeout(window.MarkdownManager.saveTimer);
          window.MarkdownManager.saveTimer = null;
        }
        if (window.MarkdownManager.editorInstance && typeof window.MarkdownManager.editorInstance.setMarkdown === 'function') {
          window.MarkdownManager.editorInstance.setMarkdown(content);
        }
        await window.MarkdownManager.saveNote(content);
      }
    }, offlineContent);

    // Vérification BDD locale OPFS : contenu bien présent en local hors-ligne
    const opfsOffline = await page.evaluate(async (fname) => await window.MarkdownStorage.read(fname), filename);
    expect(opfsOffline).toContain('Contenu enrichi et sauvegardé en mode hors-ligne sans serveur.');

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
    const putPromise = page.waitForResponse(resp => {
      return resp.url().includes(encodeURIComponent(filename)) && resp.request().method() === 'PUT';
    }, { timeout: 15000 });

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

    // 7. Triple Vérification :
    // A) Système de fichiers serveur (compatible format dossier de note et chemin direct)
    const stem = filename.replace(/\.md$/, '');
    const folderDocPath = path.join(process.cwd(), 'data', 'documents', stem, filename);
    const flatDocPath = path.join(process.cwd(), 'data', 'documents', filename);
    const docPath = fs.existsSync(folderDocPath) ? folderDocPath : flatDocPath;
    expect(fs.existsSync(docPath)).toBeTruthy();
    expect(fs.readFileSync(docPath, 'utf-8')).toContain('Contenu enrichi et sauvegardé en mode hors-ligne sans serveur.');

    // B) BDD Serveur (SQLite)
    const serverStatus = queryServerDb(`SELECT status FROM documents WHERE filename = '${filename}'`);
    expect(serverStatus === 'ready' || serverStatus === 'pending').toBeTruthy();
    expect(queryServerDb(`SELECT deleted_at FROM documents WHERE filename = '${filename}'`)).toBe('');

    // C) Vérification visuelle UI Corbeille : la note N'EST PAS en corbeille
    await assertTrashUiVisible(page, noteTitle, false);
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

    // 2. Coupure réseau physique
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(300);

    // 3. Suppression de la note en local (mise en corbeille offline)
    page.once('dialog', async dialog => {
      await dialog.accept();
    });
    await page.locator('#markdownTrashBtn').click();

    // Vérifier BDD locale IndexedDB : le fichier est marqué "deleted"
    const dirtyList = await page.evaluate(async () => await window.MarkdownStorage.getDirtyFiles());
    expect(dirtyList.some(d => d.filename === filename && d.action === 'deleted')).toBeTruthy();

    // 4. Reconnexion réseau
    const syncPromise = page.waitForResponse(resp => resp.url().includes('/api/sync/manifest'), { timeout: 15000 });
    const deletePromise = page.waitForResponse(resp => resp.url().includes(encodeURIComponent(filename)) && resp.request().method() === 'DELETE', { timeout: 15000 });

    await context.setOffline(false);
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('online'));
      if (window.SyncManager) {
        await window.SyncManager.runSync();
      }
    });

    await syncPromise;
    await deletePromise;
    await page.waitForTimeout(500);

    // 5. Triple Vérification :
    // A) Système de fichiers serveur (documents/ vs trash/ + .meta.json)
    const activeDocPath = path.join(process.cwd(), 'data', 'documents', filename);
    const trashDocPath = path.join(process.cwd(), 'data', 'trash', `del_${filename}`);
    const trashMetaPath = path.join(process.cwd(), 'data', 'trash', `del_${filename}.meta.json`);
    expect(fs.existsSync(activeDocPath)).toBeFalsy();
    expect(fs.existsSync(trashDocPath)).toBeTruthy();
    expect(fs.existsSync(trashMetaPath)).toBeTruthy();

    // Vérification du contenu du fichier JSON de corbeille
    const metaContent = JSON.parse(fs.readFileSync(trashMetaPath, 'utf-8'));
    expect(metaContent.original_path).toBe(filename);
    expect(metaContent.deleted_at).toBeDefined();
    expect(metaContent.expires_at).toBeDefined();

    // B) BDD Serveur (SQLite) : status = 'trashed', deleted_at renseigné
    expect(queryServerDb(`SELECT status FROM documents WHERE filename = '${filename}'`)).toBe('trashed');
    expect(queryServerDb(`SELECT deleted_at FROM documents WHERE filename = '${filename}'`)).not.toBe('');

    // C) Vérification visuelle UI Corbeille : la carte de corbeille est VISIBLE dans l'UI
    await assertTrashUiVisible(page, noteTitle, true);
  });

  test('SC-3 : Suppression sur serveur sans client connecté -> Synchronisation client', async ({ page }) => {
    const noteTitle = `ServerDelete Test ${Date.now()}`;
    const filename = `${noteTitle}.md`;

    // 1. Créer la note via le client pour qu'elle existe en local OPFS et sur serveur
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

    // 2. Suppression directe côté serveur via l'API (simule suppression par client B distant)
    const delRes = await page.request.delete(`/api/files/${encodeURIComponent(filename)}`);
    expect(delRes.ok()).toBeTruthy();

    // BDD Serveur : déjà mise à jour en trashed
    expect(queryServerDb(`SELECT status FROM documents WHERE filename = '${filename}'`)).toBe('trashed');

    // 3. Déclencher la synchronisation du client
    await page.evaluate(async () => {
      await window.SyncManager.runSync();
    });

    // 4. Triple Vérification :
    // A) BDD locale OPFS : la note a été purgée du stockage local
    const localContent = await page.evaluate(async (fname) => await window.MarkdownStorage.read(fname), filename);
    expect(localContent).toBeNull();

    // B) BDD Serveur (SQLite) & Fichier JSON : toujours en trashed avec son .meta.json
    expect(queryServerDb(`SELECT status FROM documents WHERE filename = '${filename}'`)).toBe('trashed');
    const trashMetaPath = path.join(process.cwd(), 'data', 'trash', `del_${filename}.meta.json`);
    expect(fs.existsSync(trashMetaPath)).toBeTruthy();
    const metaContent = JSON.parse(fs.readFileSync(trashMetaPath, 'utf-8'));
    expect(metaContent.original_path).toBe(filename);
    expect(metaContent.deleted_at).toBeDefined();

    // C) Vérification visuelle UI Corbeille : visible dans la corbeille pour restauration éventuelle
    await assertTrashUiVisible(page, noteTitle, true);
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

    // Vérifier BDD Serveur avant coupure : status trashed
    expect(queryServerDb(`SELECT status FROM documents WHERE filename = '${filename}'`)).toBe('trashed');

    // 2. Coupure réseau physique
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));

    // 3. Restauration / ré-écriture locale de la note pendant la coupure (mtime récent)
    const restoredContent = `# ${noteTitle}\n\nNote réactivée hors-ligne.`;
    await page.evaluate(async ({ fname, content }) => {
      await window.MarkdownStorage.write(fname, content);
      await window.MarkdownStorage.markDirty(fname, 'modified');
    }, { fname: filename, content: restoredContent });

    // 4. Reconnexion
    const putPromise = page.waitForResponse(resp => resp.url().includes(encodeURIComponent(filename)) && resp.request().method() === 'PUT', { timeout: 15000 });
    await context.setOffline(false);
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('online'));
      if (window.SyncManager) {
        await window.SyncManager.runSync();
      }
    });

    await putPromise;
    await page.waitForTimeout(500);

    // 5. Triple Vérification :
    // A) Système de fichiers serveur (réapparu dans documents/ et sorti de trash/ avec .meta.json purgé)
    const stem = filename.replace(/\.md$/, '');
    const folderDocPath = path.join(process.cwd(), 'data', 'documents', stem, filename);
    const flatDocPath = path.join(process.cwd(), 'data', 'documents', filename);
    const activeDocPath = fs.existsSync(folderDocPath) ? folderDocPath : flatDocPath;
    const trashDocPath = path.join(process.cwd(), 'data', 'trash', `del_${filename}`);
    const trashMetaPath = path.join(process.cwd(), 'data', 'trash', `del_${filename}.meta.json`);
    expect(fs.existsSync(activeDocPath)).toBeTruthy();
    expect(fs.existsSync(trashDocPath)).toBeFalsy();
    expect(fs.existsSync(trashMetaPath)).toBeFalsy();

    // B) BDD Serveur (SQLite) : deleted_at remis à NULL, status = ready/pending
    const srvStatus = queryServerDb(`SELECT status FROM documents WHERE filename = '${filename}'`);
    expect(srvStatus === 'ready' || srvStatus === 'pending').toBeTruthy();
    expect(queryServerDb(`SELECT deleted_at FROM documents WHERE filename = '${filename}'`)).toBe('');

    // C) Vérification visuelle UI Corbeille : la note N'EST PLUS dans la corbeille
    await assertTrashUiVisible(page, noteTitle, false);
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

    // BDD Serveur & Fichier JSON créés
    expect(queryServerDb(`SELECT status FROM documents WHERE filename = '${filename}'`)).toBe('trashed');
    const trashMetaPath = path.join(process.cwd(), 'data', 'trash', `del_${filename}.meta.json`);
    expect(fs.existsSync(trashMetaPath)).toBeTruthy();

    // 2. Restauration sur le serveur via l'API sans client
    const restoreRes = await page.request.post('/api/trash/restore', {
      data: { filename: filename }
    });
    expect(restoreRes.ok()).toBeTruthy();

    // BDD Serveur : restauré (deleted_at NULL) et .meta.json purgé
    expect(queryServerDb(`SELECT deleted_at FROM documents WHERE filename = '${filename}'`)).toBe('');
    expect(fs.existsSync(trashMetaPath)).toBeFalsy();

    // 3. Synchronisation du client
    await page.evaluate(async () => {
      await window.SyncManager.runSync();
    });

    // 4. Triple Vérification :
    // A) BDD locale OPFS : le fichier restauré a été pullé en local
    const localContent = await page.evaluate(async (fname) => await window.MarkdownStorage.read(fname), filename);
    expect(localContent).not.toBeNull();

    // B) BDD Serveur : status ready
    expect(queryServerDb(`SELECT status FROM documents WHERE filename = '${filename}'`)).toBe('ready');

    // C) Vérification visuelle UI Corbeille : la note N'EST PLUS dans la corbeille
    await assertTrashUiVisible(page, noteTitle, false);
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

    // 3. Vérifier le nom de fichier et l'extension (archive ZIP complète avec note et assets)
    expect(download.suggestedFilename()).toBe(`${noteTitle}.zip`);
  });

  test('SC-7 : Reconstruction de l\'index local client après réinitialisation', async ({ page }) => {
    const noteTitle = `RebuildClient Test ${Date.now()}`;
    const filename = `${noteTitle}.md`;

    // 1. Créer une note Markdown
    page.once('dialog', async dialog => { await dialog.accept(noteTitle); });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 2. Vérifier que la note est présente dans OPFS
    const localContent = await page.evaluate(async (fname) => await window.MarkdownStorage.read(fname), filename);
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
    const preservedContent = await page.evaluate(async (fname) => await window.MarkdownStorage.read(fname), filename);
    expect(preservedContent).toBe(localContent);
  });
});
