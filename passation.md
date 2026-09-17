# PASSATION — Refonte Suite de Tests Playwright DocSeeker

> Document de passation pour le successeur. Mis à jour à chaque avancement significatif.  
> Dernière mise à jour : **2026-09-17 21h13**

---

## 1. Contexte du projet

**DocSeeker** est une application web de recherche visuelle dans des PDF médicaux.  
Elle repose sur :
- **Frontend** : `frontend/` (HTML/CSS/JS vanilla, PWA avec Service Worker)
- **Backend** : `backend-rust/` (Rust/Axum, SQLite via rusqlite, moteur FTS custom)
- **Cache offline** : IndexedDB (chunks PDF) + SQLite OPFS (métadonnées) via un Web Worker
- **Vignettes PDF** : générées dans un `CropWorker` (WebAssembly + pdf.js), stockées en blob URL

**Serveur local** : `./run.sh` (port 8080). Toujours relancer avant les tests s'il n'est pas actif.

---

## 2. Ce qui a été fait (Étapes 1–7 ✅)

### Architecture de test (nouvelle)
| Fichier | Rôle |
|---|---|
| `tests/ui/harness.mjs` | POM (Page Object Model) avec helpers, assertions et `resetState()` |
| `tests/ui/global-setup.mjs` | Seed DB unique avant tous les tests (dossier Martingale id=130) |
| `playwright.config.mjs` | 2 projets : `stable` (retries:0) et `stress` (retries:1) |
| `tests/ui/ui_core.spec.mjs` | Tests cœur : bibliothèque, cache, filtre offline, split view (Core-1..11) |
| `tests/ui/ui_offline.spec.mjs` | Tests résilience réseau : cache partiel, flapping, parité offline (O1..11) |
| `tests/ui/ui_stress_matrix.spec.mjs` | Stress tests : matrices A-F, clics frénétiques, rafales, flapping, RAM |
| `tests/ui/ui_edge_cases.spec.mjs` | Edge cases EC + Matrices G (PWA), H (dossiers), I (import) |
| `tests/fixtures/test-upload.pdf` | PDF minimal pour les tests d'upload |

**`ui_complete.spec.mjs` a été supprimé** (remplacé par les 4 fichiers ci-dessus).

### Décisions clés prises
1. **`retries: 0`** pour `stable`, **`retries: 1`** pour `stress` (directive utilisateur).
2. **`workers: 1`** maintenu pour isoler IndexedDB/OPFS (contention si parallèle).
3. **`resetState()`** dans `afterEach` : remet le contexte à zéro (réseau, filtres, sélection, viewer) sans toucher au cache.
4. **`filter.check()`** remplacé par clic sur le label (`#filterOfflineChip`) — Playwright `.check()` échoue si l'app invalide instantanément l'état.
5. **`pdfCacheManager`** peut être null : `downloadDocToComplete()` retourne `true` si `downloadQueueManager.isDocumentCached()` est vrai même sans `pdfCacheManager`.
6. **Erreurs réseau offline exclues** du tracking (`Réseau indisponible`, `Erreur chargement arborescence`, `Failed to fetch`) — attendues par design lors des tests offline.

---

## 3. État actuel des tests

### Projet `stable` — dernière exécution connue : 20/22 passés
Fixes appliqués (en attente de re-validation) :
- `Core-4` : `ensureInitialized()` après reload + timeout 12s sur cache button check
- `Core-8` : `test.setTimeout(120000)` + attente du doc #1 avant `count()`
- `O7/O8` : exclusion de `Réseau indisponible` dans `_setupErrorTracking`

### Projet `stress` — pas encore lancé

---

## 4. Ce qui reste à faire

### Immédiat
1. Valider 22/22 stable → `npx playwright test --project=stable`
2. Lancer les stress tests → `npx playwright test --project=stress`
3. Corriger les flaky stress tests si nécessaire
4. Commit + push final

### Tests non couverts (nice-to-have)
- **I1/I3** : Upload PDF valide + vérification indexation réelle (besoin vrai PDF avec texte extrait)
- **G2** : SW offline app shell (comportement dépend de la config SW, peut être best-effort)
- **H3** : Drag-and-drop document vers dossier (IDs UI incertains)

---

## 5. Architecture du harness — méthodes clés

```js
// SETUP / TEARDOWN
h.authenticate()              // POST /api/auth/login + addInitScript localStorage
h.goto('/')                   // page.goto + _clearFiltersAndSearch()
h.resetState()                // afterEach standard (réseau, filtres, viewer, sélection)

// CACHE
h.ensureDocCached(id, opts)   // download si nécessaire, poll 100%
h.ensureDocNotCached(id)      // supprime du cache si présent
h.downloadDocToComplete(id)   // enqueue + poll complétion

// NAVIGATION
h.openFolder(folderId)        // .folder-card[data-folder-id=X].click()
h.navigateToBreadcrumbRoot()  // retour à la racine via breadcrumb
h.getDocCard(docId)           // locator .doc-card[data-doc-id=X]

// RECHERCHE
h.injectSearchQuery(q, opts)  // fill + performSearch + waitFor 1er résultat
h.search(q)                   // fill + performSearch sans attente
h.clearSearch()               // #clearSearchBtn

// FILTRES (toujours passer par les méthodes harness, jamais .check() direct)
h.setOfflineFilter(bool)      // clic sur #filterOfflineChip
h.setTitlesFilter(bool)       // clic sur #filterTitlesChip
h.setOffline(bool)            // context.setOffline()

// ASSERTIONS
h.assertZeroErrors()          // capturedErrors.length === 0
h.assertNoCropCorruption()    // 0 vignette avec naturalWidth=0
h.assertVignettesVisible(id, min)
h.assertOfflineCropRendered(id, min)
h.assertSearchConsistency(q)
h.assertStorageFreed(id)
h.assertResourceGuard(start, end, opts)  // RAM + durée

// STRESS
h.getPerformanceMetrics()     // {memory, domNodeCount, timestamp}
h.getQueueState(id)           // {inQueue, inActive}
h.spamClick(locator, n, ms)
h.rapidSearchBurst(queries, ms)
h.rapidFolderSwitching(ids, ms)
```

---

## 6. IDs UI critiques

```
#searchInput, #clearSearchBtn, #syncDocsBtn
#filterOfflineChip / #filterOfflineOnly    ← toujours cliquer le label, pas la checkbox
#filterTitlesChip / #filterTitlesOnly
#filterFolderChip / #filterCurrentFolderOnly
#foldersSection, #resultsContainer, #emptyState
#breadcrumbsNav
#toggleSelectionModeBtn, #batchCacheBtn, #batchUncacheBtn
#selectionActionBar, #selectionCountText
#viewerPane, #closeViewerBtn, #viewerDocTitle, #viewerPageBadge
#nextOccBtn, #prevOccBtn, #pdfFrame
#newFolderBtn, #folderModal, #folderNameInput, #saveFolderBtn
#openUploadBtn, #uploadModal, #fileInput
#sortSelect

.doc-card[data-doc-id="X"]
.doc-cache-btn (.cached si en cache)
.btn-delete-doc-cache (nuage barré)
.doc-selection-checkbox
.vignette-item[data-page="X"]
.vignette-crop-img
.folder-card[data-folder-id="X"]
.folder-cache-badge
.btn-delete-folder / .btn-delete-folder-cache
```

---

## 7. Données de test

| Alias | Doc id | Taille | Dossier | Description |
|---|---|---|---|---|
| LIGHT | 1 | ~2 Mo | 130 (Martingale) | Grossesse normale, polices standard |
| MEDIUM | 8 | ~15 Mo | null | Grossesse extra-utérine |
| HEAVY | 544 | ~80 Mo | null | Néphrologie (polices WarnockPro) |
| MASSIVE | 553 | ~250 Mo | null | Cardiologie |

Requêtes utiles :
- `"grossesse"` → doc 1, 2, 3 + autres, bons résultats garantis
- `"insuffisance rénale aigue"` → Néphrologie (544), page 267 = titre de chapitre IRA
- `"termeinexistant12345*"` → 0 résultat (état vide)

---

## 8. Commandes utiles

```bash
./run.sh                                     # Démarrer le serveur
npx playwright test --project=stable         # Tests déterministes
npx playwright test --project=stress         # Tests de stress
npx playwright test --project=stable -g "Core-4"  # Un seul test
cat test-results/*/error-context.md          # Debugger les erreurs
sqlite3 data/db.sqlite "SELECT id, name FROM folders WHERE id = 130;"
git add tests/ playwright.config.mjs PASSATION.md && git commit -m "tests: ..."
```

---

## 9. Pièges connus

| Piège | Cause | Solution |
|---|---|---|
| `filter.check()` → "did not change state" | L'app peut invalider l'état du checkbox | Utiliser `h.setOfflineFilter()` (clic sur le label) |
| `pdfCacheManager` null → timeout infini | Manager non init dans certains contextes | Traiter null comme "complet" si `isDocumentCached()=true` |
| `count()` = 67 au lieu de 3 dans un dossier | Race condition : breadcrumb avant filtrage | Attendre `.doc-card[data-doc-id="1"]` avant `count()` |
| `assertZeroErrors()` sur `Réseau indisponible` | `loadFoldersAndDocuments` fetch lors du setOffline | Exclu du tracking dans `_setupErrorTracking` |
| `ECONNREFUSED :8080` | Serveur arrêté | `./run.sh` |
| `workers > 1` → contention IndexedDB/OPFS | État partagé | Maintenir `workers: 1` |

---

## 10. Historique des commits de la refonte

- [ ] `tests: harness POM + playwright config dual-project (stable/stress)`
- [ ] `tests: ui_core Core-1..11 - stable 22/22`
- [ ] `tests: ui_offline O1..11 - résilience réseau`
- [ ] `tests: stress matrices A-F enrichis + edge cases G-H-I`
- [ ] `tests: stress 100% pass`
