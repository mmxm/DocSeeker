/**
 * DocSeeker - Tests UI Prise de Notes Markdown & Corbeille (ui_markdown_and_trash.spec.mjs)
 *
 * Valide les fonctionnalités :
 * 1. Bouton "+ Nouvelle note" dans la barre latérale
 * 2. Ouverture de l'éditeur Markdown avec titre éditable et éditeur WYSIWYG
 * 3. Vue Corbeille (accès via la barre latérale, badge de comptage, liste et actions)
 */
import { test, expect } from '@playwright/test';
import { DocSeekerTestHarness, assertVignetteVisualContent } from './harness.mjs';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Compare deux captures Playwright pixel-à-pixel dans la page (canvas natif,
 * même approche que goldenBase64 du harness). Retourne { ratio, diffPixels, total }.
 * Les captures sont redimensionnées à la taille commune (max des deux) avant
 * comparaison — tolère ±30 de luminosité moyenne par pixel (anti-aliasing).
 */
async function diffCapturesInPage(page, shotA, shotB) {
  const b64A = shotA.toString('base64');
  const b64B = shotB.toString('base64');
  return page.evaluate(async ({ a, b }) => {
    const load = (src) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('chargement capture impossible'));
      img.src = `data:image/png;base64,${src}`;
    });
    const [imgA, imgB] = await Promise.all([load(a), load(b)]);
    const w = Math.max(imgA.naturalWidth, imgB.naturalWidth);
    const h = Math.max(imgA.naturalHeight, imgB.naturalHeight);
    const grab = (img) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const dA = grab(imgA);
    const dB = grab(imgB);
    let diffPixels = 0;
    const total = w * h;
    for (let i = 0; i < dA.length; i += 4) {
      const dr = Math.abs(dA[i] - dB[i]);
      const dg = Math.abs(dA[i + 1] - dB[i + 1]);
      const db = Math.abs(dA[i + 2] - dB[i + 2]);
      if ((dr + dg + db) / 3 > 30) diffPixels++;
    }
    return { ratio: diffPixels / total, diffPixels, total };
  }, { a: b64A, b: b64B });
}

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

  test.afterAll(async () => {
    // Nettoyage automatique des notes/dossiers générés par les tests
    try {
      execSync(`sqlite3 data/db.sqlite "
        DELETE FROM pages WHERE doc_id IN (
          SELECT id FROM documents WHERE filename LIKE '%1790%' OR title LIKE '%1790%' OR title LIKE '%Test%'
        );
        DELETE FROM documents WHERE filename LIKE '%1790%' OR title LIKE '%1790%' OR title LIKE '%Test%';
        DELETE FROM folders WHERE name LIKE 'DossierNotes_%';
      "`, { stdio: 'ignore' });

      const docsDir = path.resolve('data/documents');
      if (fs.existsSync(docsDir)) {
        const files = fs.readdirSync(docsDir);
        for (const f of files) {
          if (f.includes('1790') || f.startsWith('Test Note') || f.startsWith('DocSearchNote') || f.startsWith('GlobalSearchNote') || f.startsWith('ImagePasteNote') || f.startsWith('RawPanelNote') || f.startsWith('CoverTestNote') || f.startsWith('RenamedNote') || f.startsWith('Cycle Test') || f.startsWith('DossierNotes_')) {
            const p = path.join(docsDir, f);
            try {
              if (fs.statSync(p).isDirectory()) {
                fs.rmSync(p, { recursive: true, force: true });
              } else {
                fs.unlinkSync(p);
              }
            } catch {}
          }
        }
      }

      const assetsDir = path.resolve('data/documents/assets');
      if (fs.existsSync(assetsDir)) {
        const aDirs = fs.readdirSync(assetsDir);
        for (const ad of aDirs) {
          if (ad.startsWith('ImagePasteNote') || ad.includes('1790')) {
            try { fs.rmSync(path.join(assetsDir, ad), { recursive: true, force: true }); } catch {}
          }
        }
      }

      const trashDir = path.resolve('data/trash');
      if (fs.existsSync(trashDir)) {
        const tFiles = fs.readdirSync(trashDir);
        for (const f of tFiles) {
          try { fs.rmSync(path.join(trashDir, f), { recursive: true, force: true }); } catch {}
        }
      }

      execSync(`sqlite3 data/db.sqlite "
        DELETE FROM pages WHERE doc_id NOT IN (SELECT id FROM documents);
      "`, { stdio: 'ignore' });
    } catch (e) {
      console.warn('[afterAll cleanup] Erreur nettoyage :', e.message);
    }
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

  test('MD-5 : Renommage d\'une note dans l\'UI avec synchronisation parfaite du titre', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const initialTitle = `InitialNote ${Date.now()}`;
    const renamedTitle = `RenamedNote ${Date.now()}`;

    // 1. Créer la note
    page.once('dialog', async dialog => {
      await dialog.accept(initialTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    const titleInput = page.locator('#markdownTitleInput');
    await expect(titleInput).toHaveValue(initialTitle);

    // 2. Renommer la note en modifiant l'input et en appuyant sur Enter
    const renamePromise = page.waitForResponse(resp => resp.url().includes('/api/documents/') && resp.request().method() === 'PATCH');
    await titleInput.fill(renamedTitle);
    await titleInput.press('Enter');
    await renamePromise;

    // 3. Vérifier qu'aucun toast d'erreur n'apparaît et que le toast de succès apparaît
    await expect(page.locator('.toast.toast-success').filter({ hasText: 'Note renommée' })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.toast.toast-error')).not.toBeVisible();
    await expect(titleInput).toHaveValue(renamedTitle);

    // 4. Vérifier que le titre du lecteur et de l'onglet a changé sans aucune erreur JS
    const viewerDocTitle = page.locator('#viewerDocTitle');
    if (await viewerDocTitle.isVisible().catch(() => false)) {
      await expect(viewerDocTitle).toHaveText(renamedTitle);
    }
    const activeTab = page.locator('#tabsList .viewer-tab.active .tab-title');
    if (await activeTab.isVisible().catch(() => false)) {
      await expect(activeTab).toHaveText(renamedTitle);
    }

    // Aucun crash JS non intercepté (ex: TypeError: tabManager.renderTabs is not a function)
    expect(pageErrors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
  });

  test('MD-6 : Recherche in-document dans une note Markdown ouverte', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    const noteTitle = `DocSearchNote ${Date.now()}`;
    const uniqueTerm = `TERMEUNIQUE${Date.now()}`;

    // 1. Créer la note
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(() => !!window.MarkdownManager?.editorInstance && !window.MarkdownManager?._loadingPromise, { timeout: 10000 });

    // 2. Écrire du contenu contenant le mot-clé unique et sauvegarder
    const content = `# Document Clinique\n\nDiagnostic posé : ${uniqueTerm} avec indication formelle.\nProtocole de suivi standard.`;
    const savePromise = page.waitForResponse(resp => resp.url().includes('/api/files/') && resp.request().method() === 'PUT');
    await page.evaluate(async ({ text }) => {
      window.MarkdownManager.setMarkdown(text);
      await window.MarkdownManager.saveNote(text);
    }, { text: content });
    await savePromise;

    // Laisser le temps à l'interface de se stabiliser
    await page.waitForTimeout(500);

    // 3. Ouvrir le volet latéral d'extraits intra-doc (comme dans l'UI utilisateur Screen 2)
    const sidebarBtn = page.locator('#readerSidebarToggleBtn');
    const drawer = page.locator('#inDocSearchDrawer');
    if (await sidebarBtn.isVisible() && !(await drawer.isVisible())) {
      await sidebarBtn.click();
      await expect(drawer).toBeVisible({ timeout: 5000 });
    }

    // 4. Lancer la recherche in-document depuis le tiroir
    const inDocInput = page.locator('#inDocDrawerSearchInput');
    await expect(inDocInput).toBeVisible({ timeout: 5000 });
    const searchPromise = page.waitForResponse(resp => resp.url().includes('/api/doc-search'));
    await inDocInput.fill(uniqueTerm);
    await inDocInput.press('Enter');
    const docSearchRes = await searchPromise;
    const docSearchJson = await docSearchRes.json();
    console.log('[MD-6 Debug] /api/doc-search response:', JSON.stringify(docSearchJson));

    const drawerHtml = await page.locator('#inDocDrawerOccurrencesList').innerHTML();
    console.log('[MD-6 Debug] inDocDrawerOccurrencesList innerHTML:', drawerHtml);

    // 5. Vérifier que la carte d'occurrence existe dans le tiroir d'extraits
    const occCard = page.locator('#inDocDrawerOccurrencesList .vertical-occ-card').first();
    await expect(occCard).toBeVisible({ timeout: 10000 });

    // 5b. VÉRIFICATION DE LA CARTE TEXTE INTRA-DOC (extrait HTML natif, aucune image)
    const occImgCount = await occCard.locator('img.vertical-occ-img, img.dynamic-crop').count();
    expect(occImgCount).toBe(0);
    const occExcerpt = occCard.locator('.vignette-md-excerpt');
    await expect(occExcerpt).toBeVisible();
    await expect(occExcerpt.locator('.vignette-md-key')).toContainText(uniqueTerm, { ignoreCase: true });
    const occMark = occExcerpt.locator('mark.title-highlight').first();
    await expect(occMark).toBeVisible();
    await expect(occMark).toHaveText(new RegExp(uniqueTerm, 'i'));

    // 6. Vérifier la surbrillance dans l'éditeur (CSS highlight ou data-search-hit)
    await expect.poll(async () => {
      return await page.evaluate((term) => {
        const root = document.getElementById("milkdownRoot");
        if (!root) return false;
        const hasDataHit = !!root.querySelector('[data-search-hit="true"]');
        const hasCssHighlight = (typeof CSS !== 'undefined' && CSS.highlights && CSS.highlights.has('markdown-search'));
        return hasDataHit || hasCssHighlight;
      }, uniqueTerm);
    }, { timeout: 5000 }).toBe(true);

    // 6b. Vérifier que la croix d'effacement est visible dans le volet intra-document
    const inDocClearBtn = page.locator('#inDocDrawerClearBtn');
    await expect(inDocClearBtn).toBeVisible();

    // 6c. Cliquer sur la croix pour vider et réinitialiser la recherche
    await inDocClearBtn.click();
    await expect(inDocInput).toHaveValue('');
    await expect(inDocClearBtn).toBeHidden();

    // Vérifier la réinitialisation du compteur et l'absence d'occurrences
    await expect(page.locator('#inDocDrawerCount')).toHaveText('0 résultat');
    expect(await page.locator('#inDocDrawerOccurrencesList .vertical-occ-card').count()).toBe(0);

    // Vérifier que plus aucun mot n'est surligné dans l'éditeur
    await expect.poll(async () => {
      return await page.evaluate(() => {
        const root = document.getElementById("milkdownRoot");
        if (!root) return false;
        const hasDataHit = !!root.querySelector('[data-search-hit="true"]');
        const hasCssHighlight = (typeof CSS !== 'undefined' && CSS.highlights && CSS.highlights.has('markdown-search'));
        return hasDataHit || hasCssHighlight;
      });
    }, { timeout: 5000 }).toBe(false);

    // 7. Vérifier qu'aucun crash Pdfium "Invalid PDF structure" n'a eu lieu
    const pdfiumErrors = consoleErrors.filter(err => err.includes('Invalid PDF structure'));
    expect(pdfiumErrors).toHaveLength(0);

    // 8. Vérifier que la note reste ouverte et réactive
    await expect(page.locator('#markdownEditorContainer')).toBeVisible();
  });

  test('MD-7 : Recherche globale incluant les notes Markdown en ligne sans erreur 500', async ({ page }) => {
    const noteTitle = `GlobalSearchNote ${Date.now()}`;
    const uniqueKw = `KWGLOBAL${Date.now()}`;

    // 1. Créer la note
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 2. Enregistrer du texte avec le mot clé
    const content = `# Note Importante\n\nCe fichier contient le code secret ${uniqueKw} pour validation.`;
    const savePromise = page.waitForResponse(resp => resp.url().includes('/api/files/') && resp.request().method() === 'PUT');
    await page.evaluate(async (text) => {
      await window.MarkdownManager.saveNote(text);
    }, content);
    await savePromise;

    // 3. Revenir à l'accueil
    await page.locator('#readerHomeBtn').click();
    await page.waitForTimeout(500);

    // 4. Lancer une recherche globale avec le mot-clé
    const searchPromise = page.waitForResponse(resp => resp.url().includes('/api/search') && resp.status() === 200);
    const searchInput = page.locator('#searchInput');
    await searchInput.fill(uniqueKw);
    await searchInput.press('Enter');
    await searchPromise;

    // 5. Vérifier que la note apparaît dans la grille des résultats
    const docCard = page.locator('.doc-card', { hasText: noteTitle });
    await expect(docCard).toBeVisible({ timeout: 8000 });

    // 5b. VÉRIFICATION DE LA VIGNETTE TEXTE (extrait HTML natif, aucune image générée)
    const vignetteItem = docCard.locator('.vignette-item').first();
    await expect(vignetteItem).toBeVisible({ timeout: 8000 });
    await expect(vignetteItem).toHaveAttribute('data-doc-type', 'markdown');

    // Les notes MD n'utilisent plus de crop image : l'extrait est du texte natif
    const imgCount = await vignetteItem.locator('img.vignette-crop-img, img.dynamic-main-crop').count();
    expect(imgCount).toBe(0);

    // L'encadré texte respecte le gabarit des vignettes (ratio 2:1) et contient le mot-clé
    const excerpt = vignetteItem.locator('.vignette-md-excerpt');
    await expect(excerpt).toBeVisible();
    const itemBox = await vignetteItem.boundingBox();
    const ratio = itemBox.width / itemBox.height;
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);

    // La ligne du mot-clé est présente et le terme est surligné (mark jaune peint)
    await expect(excerpt.locator('.vignette-md-key')).toContainText(uniqueKw, { ignoreCase: true });
    const markEl = excerpt.locator('mark.title-highlight').first();
    await expect(markEl).toBeVisible();
    await expect(markEl).toHaveText(new RegExp(uniqueKw, 'i'));
    const highlightOk = await markEl.evaluate(el => {
      const bg = getComputedStyle(el).backgroundColor;
      const box = el.getBoundingClientRect();
      return bg === 'rgb(253, 224, 71)' && box.width > 0 && box.height > 0;
    });
    expect(highlightOk).toBe(true);
  });

  test('MD-8 : Insertion / Coller d\'une image dans l\'éditeur sans crash RangeError: caption', async ({ page }) => {
    const noteTitle = `ImagePasteNote ${Date.now()}`;

    // 1. Créer la note
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 2. Écouter les erreurs de la console pour détecter un éventuel RangeError
    let rangeErrorFound = false;
    page.on('console', msg => {
      if (msg.type() === 'error' && msg.text().includes('RangeError')) {
        rangeErrorFound = true;
      }
    });

    // 3. Simuler le coller d'une image PNG
    const uploadPromise = page.waitForResponse(resp => resp.url().includes('/api/assets/') && resp.status() === 200);
    await page.evaluate(async () => {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const res = await fetch(`data:image/png;base64,${b64}`);
      const blob = await res.blob();
      const file = new File([blob], 'screenshot_test.png', { type: 'image/png' });

      // Déclencher un événement paste avec le fichier
      const dt = {
        items: [{
          type: 'image/png',
          getAsFile: () => file
        }]
      };
      const pasteEvt = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvt, 'clipboardData', { value: dt });
      document.getElementById('markdownEditorContainer').dispatchEvent(pasteEvt);
    });

    await uploadPromise;
    await page.waitForTimeout(1000);

    // 4. Vérifier qu'aucun crash RangeError n'a eu lieu
    expect(rangeErrorFound).toBe(false);

    // 5. Vérifier que le markdown contient la référence à l'image
    const mdContent = await page.evaluate(() => {
      return window.MarkdownManager.editorInstance
        ? window.MarkdownManager.editorInstance.getMarkdown()
        : '';
    });
    expect(mdContent).toContain('screenshot_test.png');
    expect(mdContent).toContain('assets/');

    // 6. Garde-fou anti-doublon : l'interception en phase capture doit
    // empêcher Crepe d'insérer sa référence blob: locale non persistée.
    expect(mdContent).not.toContain('blob:');
    const imgRefs = mdContent.match(/!\[[^\]]*\]\([^)]*\)/g) || [];
    expect(imgRefs.length).toBe(1);
  });

  test('MD-9 : Volet latéral de code Markdown brut et synchronisation bi-directionnelle', async ({ page }) => {
    const noteTitle = `RawPanelNote ${Date.now()}`;

    // 1. Créer la note
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 2. Déployer le volet latéral Markdown brut
    const toggleBtn = page.locator('#markdownToggleRawBtn');
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();

    // 3. Vérifier que le drawer est visible et contient le titre
    const rawDrawer = page.locator('#markdownRawDrawer');
    await expect(rawDrawer).toBeVisible();
    const rawContent = page.locator('#markdownRawContent');
    await expect(rawContent).toBeVisible();
    await expect(rawContent).toHaveValue(new RegExp(noteTitle));

    // 4. Modifier le markdown dans le textarea brut
    const extraContent = '\n\n## Section Modifiee Via Drawer\nTexte direct en markdown brut.';
    await rawContent.fill(`# ${noteTitle}${extraContent}`);

    // Déclencher l'input event pour la synchro
    await rawContent.dispatchEvent('input');
    await page.waitForTimeout(600);

    // 5. Vérifier que l'éditeur Crepe / ProseMirror a bien été mis à jour
    const editorMd = await page.evaluate(() => {
      return window.MarkdownManager.editorInstance
        ? window.MarkdownManager.editorInstance.getMarkdown()
        : '';
    });
    expect(editorMd).toContain('Section Modifiee Via Drawer');
  });

  test('MD-10 : Création d\'une note dans le dossier courant actif par défaut', async ({ page }) => {
    const folderName = `DossierNotes_${Date.now()}`;
    const noteTitle = `NoteDansDossier ${Date.now()}`;

    // 1. Créer un sous-dossier via l'API
    const createFolderRes = await page.request.post('/api/folders', {
      data: { name: folderName, parent_id: null }
    });
    expect([200, 201]).toContain(createFolderRes.status());
    const folderData = await createFolderRes.json();
    const folderId = folderData.id;

    // 2. Naviguer dans ce sous-dossier
    await page.evaluate(async (fId) => {
      if (typeof window.navigateToFolder === 'function') {
        await window.navigateToFolder(fId);
      }
    }, folderId);
    await page.waitForTimeout(600);

    // 3. Créer une note alors qu'on est dans le sous-dossier
    const createNotePromise = page.waitForResponse(resp => resp.url().includes('/api/files') && resp.request().method() === 'POST');
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    const res = await createNotePromise;
    expect([200, 201]).toContain(res.status());
    const noteCreated = await res.json();
    const createdDocId = noteCreated.doc_id || noteCreated.id;
    expect(createdDocId).toBeDefined();

    // 4. Vérifier que la note est bien liée à ce dossier
    const listRes = await page.request.get(`/api/documents?folder_id=${folderId}`);
    expect(listRes.status()).toBe(200);
    const data = await listRes.json();
    const docs = Array.isArray(data) ? data : (data.documents || []);
    const found = docs.find(d => Number(d.id) === Number(createdDocId));
    expect(found).toBeDefined();
    expect(found.title).toBe(noteTitle);
    expect(Number(found.folder_id)).toBe(Number(folderId));
  });

  test('MD-11 : Génération immédiate de vignette WebP (cover) pour note Markdown', async ({ page }) => {
    const noteTitle = `CoverTestNote ${Date.now()}`;

    // 1. Créer la note
    const createNotePromise = page.waitForResponse(resp => resp.url().includes('/api/files') && resp.request().method() === 'POST');
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    const noteRes = await createNotePromise;
    const noteData = await noteRes.json();
    const docId = noteData.doc_id || noteData.id;
    expect(docId).toBeDefined();

    // 2. Demander la couverture via /api/cover/{id}
    const coverRes = await page.request.get(`/api/cover/${docId}`);

    // 3. Vérifier que la couverture est immédiatement générée (HTTP 200, WebP)
    expect(coverRes.status()).toBe(200);
    const contentType = coverRes.headers()['content-type'];
    expect(contentType).toContain('image/webp');
    const body = await coverRes.body();
    expect(body.length).toBeGreaterThan(100);

    // 4. VÉRIFICATION VISUELLE RIGOUREUSE (OCR & PIXELS) DE LA COUVERTURE
    await page.evaluate((b64) => {
      let testImg = document.getElementById('testCoverImg');
      if (!testImg) {
        testImg = document.createElement('img');
        testImg.id = 'testCoverImg';
        testImg.style.position = 'fixed';
        testImg.style.bottom = '0';
        testImg.style.right = '0';
        testImg.style.width = '240px';
        testImg.style.zIndex = '99999';
        document.body.appendChild(testImg);
      }
      testImg.src = `data:image/webp;base64,${b64}`;
    }, body.toString('base64'));

    await assertVignetteVisualContent(page.locator('#testCoverImg'), {
      expectedWords: ['CoverTestNote'],
      requireBlueAccent: true,
      minBluePixels: 8,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MD-12 : Persistance visuelle d'une image collée
  // Coller une image → capture de l'éditeur → fermer la note → la rouvrir →
  // capture → comparaison pixel des deux captures. Verrouille le correctif
  // « image insérée en double / disparue après rechargement » : la référence
  // assets/ doit survivre intacte au cycle complet de l'éditeur.
  // ─────────────────────────────────────────────────────────────────────────

  test('MD-12 : Persistance visuelle d\'une image collée (capture → fermeture → réouverture → comparaison)', async ({ page }) => {
    test.setTimeout(90_000);
    const noteTitle = `ImagePersistNote ${Date.now()}`;

    // 1. Créer la note
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(() => !!window.MarkdownManager?.editorInstance && !window.MarkdownManager?._loadingPromise, { timeout: 10000 });

    // 2. Générer un PNG déterministe 16×16 (motif unique) via canvas in-page :
    //    évite toute dépendance binaire et garantit un contenu comparable.
    const pngB64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#e11d48'; ctx.fillRect(0, 0, 16, 16);
      ctx.fillStyle = '#22c55e'; ctx.fillRect(8, 0, 8, 16);
      ctx.fillStyle = '#2563eb'; ctx.fillRect(4, 4, 8, 8);
      return c.toDataURL('image/png').split(',')[1];
    });

    // 3. Coller l'image (même interception phase-capture que MD-8 → upload réel)
    const uploadPromise = page.waitForResponse(resp => resp.url().includes('/api/assets/') && resp.status() === 200);
    await page.evaluate(async (b64) => {
      const res = await fetch(`data:image/png;base64,${b64}`);
      const blob = await res.blob();
      const file = new File([blob], 'persist_check.png', { type: 'image/png' });
      const dt = { items: [{ type: 'image/png', getAsFile: () => file }] };
      const pasteEvt = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvt, 'clipboardData', { value: dt });
      document.getElementById('markdownEditorContainer').dispatchEvent(pasteEvt);
    }, pngB64);
    await uploadPromise;

    // 4. L'image doit être rendue UNE seule fois et entièrement chargée
    const editorImgs = page.locator('#markdownEditorContainer img');
    await expect(editorImgs).toHaveCount(1, { timeout: 10000 });
    // Poll auto-porteur : l'éditeur re-rend son DOM (l'élément <img> peut être
    // remplacé entre deux itérations) — on re-query l'img à chaque tick.
    await expect.poll(async () => page.evaluate(() => {
      const el = document.querySelector('#markdownEditorContainer img');
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return el.complete && el.naturalWidth > 0;
    }), { timeout: 10000 }).toBe(true);

    // 5. Sauvegarde explicite puis capture AVANT (l'élément <img> seul : insensible
    // au caret, au focus et au scroll qui bruitent une capture éditeur entier)
    await page.evaluate(async () => {
      const md = window.MarkdownManager.editorInstance.getMarkdown();
      await window.MarkdownManager.saveNote(md);
    });
    await page.waitForTimeout(500);
    const beforeShot = await editorImgs.first().screenshot();

    // 6. Fermer la note (sans quitter la page)
    await page.locator('#closeViewerBtn').click();
    await expect(page.locator('#viewerPane')).toBeHidden({ timeout: 5000 });

    // 7. Rouvrir la note via la recherche
    const searchPromise = page.waitForResponse(r => r.url().includes('/api/search') && r.request().method() === 'GET');
    await page.locator('#searchInput').fill('ImagePersistNote');
    await page.locator('#searchInput').press('Enter');
    await searchPromise;
    const docCard = page.locator('.doc-card', { hasText: noteTitle });
    await expect(docCard).toBeVisible({ timeout: 8000 });
    await docCard.locator('.vignette-item').first().click();
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });
    await page.waitForFunction(() => !!window.MarkdownManager?.editorInstance && !window.MarkdownManager?._loadingPromise, { timeout: 10000 });

    // 8. Après réouverture : l'image est toujours présente et chargée (pas de blob: mort)
    await expect(editorImgs).toHaveCount(1, { timeout: 10000 });
    await expect.poll(async () => page.evaluate(() => {
      const el = document.querySelector('#markdownEditorContainer img');
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return el.complete && el.naturalWidth > 0;
    }), { timeout: 10000 }).toBe(true);
    const reopenedSrc = await page.evaluate(() => document.querySelector('#markdownEditorContainer img')?.getAttribute('src') || '');
    expect(reopenedSrc, 'la référence doit pointer vers assets/ servis par l\'API').toContain('assets/');
    expect(reopenedSrc).not.toContain('blob:');
    await page.waitForTimeout(400); // stabiliser le rendu

    // 9. Capture APRÈS (même élément <img>) et comparaison pixel avant/après
    const afterShot = await editorImgs.first().screenshot();
    const diff = await diffCapturesInPage(page, beforeShot, afterShot);
    expect(
      diff.ratio,
      `L'image rendue doit être visuellement identique avant/après réouverture (${(diff.ratio * 100).toFixed(2)}% de pixels divergents > 3%)`
    ).toBeLessThanOrEqual(0.03);
  });

  test('MD-13 : Téléchargement du dossier complet de la note en archive ZIP avec assets inclus', async ({ page }) => {
    const noteTitle = `ZipExportNote ${Date.now()}`;

    // 1. Créer la note
    const createNotePromise = page.waitForResponse(resp => resp.url().includes('/api/files') && resp.request().method() === 'POST');
    page.once('dialog', async dialog => {
      await dialog.accept(noteTitle);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    const noteRes = await createNotePromise;
    const noteData = await noteRes.json();
    const filename = noteData.filename;
    expect(filename).toBeDefined();

    await page.waitForFunction(() => !!window.MarkdownManager?.editorInstance && !window.MarkdownManager?._loadingPromise, { timeout: 10000 });

    // 2. Coller une image d'asset dans la note
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const uploadPromise = page.waitForResponse(resp => resp.url().includes('/api/assets/') && resp.status() === 200, { timeout: 15000 });
    await page.evaluate((b64) => {
      const byteChars = atob(b64);
      const byteArr = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      const blob = new Blob([byteArr], { type: 'image/png' });
      const file = new File([blob], 'export_asset.png', { type: 'image/png' });
      const dt = { items: [{ type: 'image/png', getAsFile: () => file }] };
      const pasteEvt = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvt, 'clipboardData', { value: dt });
      document.getElementById('markdownEditorContainer').dispatchEvent(pasteEvt);
    }, pngB64);
    await uploadPromise;

    // 3. Déclencher le téléchargement via #markdownExportBtn
    const [ download ] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.locator('#markdownExportBtn').click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.zip$/i);

    // 4. Vérifier que l'API d'export ZIP répond bien 200 avec Content-Type application/zip
    const cleanFn = filename.replace(/^\/+/, '');
    const apiRes = await page.request.get(`/api/files/export-zip/${cleanFn}`);
    expect(apiRes.status()).toBe(200);
    expect(apiRes.headers()['content-type']).toContain('application/zip');
    expect(apiRes.headers()['content-disposition']).toContain('.zip');
    const zipBytes = await apiRes.body();
    expect(zipBytes.length).toBeGreaterThan(100);

    // Signature PK de fichier zip (0x50, 0x4B, 0x03, 0x04)
    expect(zipBytes[0]).toBe(0x50);
    expect(zipBytes[1]).toBe(0x4B);
    expect(zipBytes[2]).toBe(0x03);
    expect(zipBytes[3]).toBe(0x04);
  });

  test('MD-14 : Round-trip fidèle Markdown sans altération silencieuse à l\'ouverture ni autosave', async ({ page }) => {
    const cases = [
      { name: 'table-fenced-headings', content: '# Titre H1\n\n| Colonne 1 | Colonne 2 |\n| --- | --- |\n| Val 1 | Val 2 |\n\n```javascript\nconst x = 42;\n```\n' },
      { name: 'indented-code-block', content: '# Indented Code\n\n    function test() {\n        return true;\n    }\n' },
      { name: 'task-lists', content: '# Tâches\n\n- [ ] Première tâche\n- [x] Tâche terminée\n- [ ] Autre tâche\n' },
      { name: 'crlf', content: "# Titre CRLF\r\n\r\nLigne 1\r\nLigne 2\r\n" },
      { name: 'multiple-blank-lines', content: "# Lignes Vides\n\n\n\n\nParagraphe après 5 sauts de ligne.\n" },
      { name: 'escaped-chars', content: "# Escapes\n\n\\[pas lien\\] et \\*pas italique\\* et \\_pas souligné\\_\n" },
      { name: 'html-entities', content: "# Entités HTML\n\n&lt;balise&gt; et &amp; entités littérales.\n" },
      { name: 'long-note', content: `# Longue Note\n\n${'Paragraphe répété pour test de fidélité et longueur.\n\n'.repeat(300)}\n\n` },
    ];

    for (const c of cases) {
      const filename = `RT_${c.name}_${Date.now()}.md`;
      const title = `Note RT ${c.name}`;

      // 1. Créer la note via l'API
      const createRes = await page.request.post('/api/files', {
        data: {
          filename,
          title,
          content: c.content,
        }
      });
      expect([200, 201]).toContain(createRes.status());

      // 2. Ouvrir la note dans l'éditeur
      await page.evaluate(async ({ fn, t, cnt }) => {
        await window.MarkdownManager.loadNote(null, fn, t, cnt);
      }, { fn: filename, t: title, cnt: c.content });

      // Attendre le montage complet
      await page.waitForTimeout(300);

      // 3. Vérifier que getMarkdown() sans aucune édition retourne strictement le contenu initial
      const editorMd = await page.evaluate(() => {
        return window.MarkdownManager.editorInstance
          ? window.MarkdownManager.editorInstance.getMarkdown()
          : '';
      });
      expect(editorMd).toBe(c.content);

      // 4. Attendre au-delà du debounce autosave (1,5 s) et vérifier que le fichier serveur reste inchangé
      await page.waitForTimeout(1600);

      const serverRes = await page.request.get(`/api/files/${encodeURIComponent(filename)}`);
      expect(serverRes.status()).toBe(200);
      const serverText = await serverRes.text();
      expect(serverText).toBe(c.content);
    }
  });
  test('MD-18 : Race debounce de sauvegarde lors du changement rapide de note (Issue #6)', async ({ page }) => {
    const ts = Date.now();
    const titleA = `RaceNoteA_${ts}`;
    const filenameA = `${titleA}.md`;
    const titleB = `RaceNoteB_${ts}`;
    const filenameB = `${titleB}.md`;
    const markerA = `MARQUEUR_A_UNIQUE_${ts}`;

    // 1. Créer la note A
    const createAPromise = page.waitForResponse(resp => resp.url().includes('/api/files') && resp.request().method() === 'POST');
    page.once('dialog', async dialog => {
      await dialog.accept(titleA);
    });
    await page.locator('#newMarkdownNoteBtn').click();
    await createAPromise;
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 2. Modifier note A (déclenche debounce 1500ms)
    await page.evaluate((marker) => {
      window.MarkdownManager.onContentChange(`# Note A\n\n${marker}`);
    }, markerA);

    // 3. Basculer immédiatement sur note B bien avant 1500ms
    await page.waitForTimeout(100);
    const createBPromise = page.waitForResponse(resp => resp.url().includes('/api/files') && resp.request().method() === 'POST');
    page.once('dialog', async dialog => {
      await dialog.accept(titleB);
    });
    await page.evaluate(() => window.MarkdownManager.promptCreateNote());
    await createBPromise;
    await expect(page.locator('#markdownEditorContainer')).toBeVisible({ timeout: 10000 });

    // 4. Attendre la fin du cycle de sauvegarde
    await page.waitForTimeout(2500);

    // 5. Vérifier que la note A contient bien son marqueur
    const resA = await page.request.get(`/api/files/${encodeURIComponent(filenameA)}`);
    expect(resA.status()).toBe(200);
    const textA = await resA.text();
    expect(textA).toContain(markerA);

    // 6. Vérifier que la note B NE contient PAS le marqueur de la note A
    const resB = await page.request.get(`/api/files/${encodeURIComponent(filenameB)}`);
    expect(resB.status()).toBe(200);
    const textB = await resB.text();
    expect(textB).not.toContain(markerA);

    // 7. Vérifier OPFS local
    const opfsA = await page.evaluate(async (fn) => {
      return await window.MarkdownStorage.read(fn);
    }, filenameA);
    expect(opfsA).toContain(markerA);

    const opfsB = await page.evaluate(async (fn) => {
      return await window.MarkdownStorage.read(fn);
    }, filenameB);
    expect(opfsB).not.toContain(markerA);
  });
});


