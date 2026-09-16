# Dossier de Passation Technique - Projet DocSeeker (DocFastExplorer)

> **Document destiné au successeur technique**  
> **Branche Git :** `feat/offline-shared-search-engine`  
> **Date de rédaction :** 16 Septembre 2026  
> **Auteur sortant :** Agent IA Antigravity (Google DeepMind)  
> **Statut global :** ✅ Moteur en ligne & hors-ligne 100% opérationnels, suite de tests validée à 100% (0 erreur).

---

## Sommaire
1. [Introduction & Vision du Projet](#1-introduction--vision-du-projet)
2. [Cartographie des Cahiers des Charges & Spécifications](#2-cartographie-des-cahiers-des-charges--spécifications)
3. [Architecture Globale & Principes Fondamentaux](#3-architecture-globale--principes-fondamentaux)
   - [A. La Source Unique de Vérité (`search-core`)](#a-la-source-unique-de-vérité-search-core)
   - [B. Le Backend Rust (Serveur & API)](#b-le-backend-rust-serveur--api)
   - [C. Le Client Web & l'Architecture Multi-Workers](#c-le-client-web--larchitecture-multi-workers)
4. [Ce qui a été Réalisé](#4-ce-qui-a-été-réalisé)
5. [Où en est le Projet Aujourd'hui](#5-où-en-est-le-projet-aujourdhui)
6. [Stratégie de Test & Tests UI Initiés](#6-stratégie-de-test--tests-ui-initiés)
   - [A. Suite de tests automatisés (`run_tests.sh`)](#a-suite-de-tests-automatisés-run_testssh)
   - [B. Les tests UI & validation visuelle Chrome DevTools (CDP)](#b-les-tests-ui--validation-visuelle-chrome-devtools-cdp)
   - [C. Recommandations pour étendre les tests UI](#c-recommandations-pour-étendre-les-tests-ui)
7. [Guide de Démarrage & Commandes Clés (Cheat-sheet)](#7-guide-de-démarrage--commandes-clés-cheat-sheet)
8. [Points de Vigilance & Pièges à Éviter](#8-points-de-vigilance--pièges-à-éviter)

---

## 1. Introduction & Vision du Projet

**DocSeeker** (répertoire de travail : `DocFastExplorer`) est un moteur de recherche visuelle et d'exploration ultra-rapide pour volumineux corpus de documents PDF (plusieurs dizaines de milliers de pages, typiquement utilisé pour des cours de médecine, polycopiés nationaux et manuels volumineux).

### Les Piliers d'Expérience Utilisateur (UX)
1. **Ergonomie visuelle inspirée de Goodnotes** : Les résultats ne sont pas de simples lignes de texte, mais des **vignettes découpées (crops 300×120 px)** de la page réelle, avec **surlignage jaune Goodnotes translucide (`rgba(255, 226, 0, 0.45)`)** centré exactement sur les coordonnées géométriques du mot.
2. **Recherche instantanée et tolérante** : FTS5 avec stemming, désaccentuation automatique (`unicode61 remove_diacritics 2`), préfixes (`grossess*`), pondération BM25 et sur-pondération massive des titres (+1500 points).
3. **Double mode En ligne / Hors-ligne (PWA)** : L'utilisateur peut travailler connecté à son serveur local ou nomade en mode avion complet. Le comportement, les résultats, les vignettes et les scores doivent être **strictement identiques à 100%**.
4. **Visualisation intégrée en Split View** : Consultation du document avec lecteur PDF.js synchronisé et volet de recherche documentaire contextuel.

---

## 2. Cartographie des Cahiers des Charges & Spécifications

Avant toute intervention, prends le temps de lire les documents de référence déjà présents dans le dépôt :

- [📄 `cahier_des_charges.md`](cahier_des_charges.md)  
  *Spécification originelle de la plateforme* : architecture globale, ingestion et extraction de texte via PDFium, organisation en dossiers/sous-dossiers, annotations, export, et principes d'interface utilisateur.
- [📄 `CAHIER_DES_CHARGES_OFFLINE.md`](CAHIER_DES_CHARGES_OFFLINE.md)  
  *Spécification fonctionnelle et exigences de parité du mode hors-ligne* : exigence stricte de zéro régression, conservation absolue de la formule de score Goodnotes, gestion du stockage local (IndexedDB + SQLite-Wasm), tolérance aux pannes réseau et mise en cache sélective par document/dossier.
- [📄 `IMPLEMENTATION_TECHNIQUE_OFFLINE.md`](IMPLEMENTATION_TECHNIQUE_OFFLINE.md)  
  *Dossier technique détaillé de l'architecture hors-ligne* : schéma relationnel DDL, protocole des messages Web Workers, structure du bundle hors-ligne, pipeline de rendu OffscreenCanvas.
- [📄 `DEPLOY_SYNOLOGY.md`](DEPLOY_SYNOLOGY.md) & [📄 `GUIDE_GESTION_ISSUES.md`](GUIDE_GESTION_ISSUES.md)  
  *Guides d'exploitation* : déploiement conteneurisé sur NAS Synology et gestion des issues.

---

## 3. Architecture Globale & Principes Fondamentaux

```
+-----------------------------------------------------------------------------+
|                                search-core                                  |
|         (Caisse Rust commune : Schéma DDL, Générateur SQL FTS5/CTE,         |
|             Matching spatial, Clustering, Bords de Crop 300x120)            |
+--------------------------------------+--------------------------------------+
                   |                                      |
         (Compilation native)                   (Compilation Wasm)
                   v                                      v
+--------------------------------------+  +-----------------------------------+
|            backend-rust              |  |            search-wasm            |
| - Serveur HTTP Axum (Port 8080)      |  | - Wasm chargé dans le navigateur  |
| - Base SQLite serveur (rusqlite)     |  +-----------------+-----------------+
| - Ingestion PDFium & pipeline OCR    |                    |
| - Endpoints API & bundles offline    |                    |
+--------------------------------------+                    |
                                                            v
+-----------------------------------------------------------------------------+
|                                Frontend PWA                                 |
|                                                                             |
|  +------------------------+  +--------------------+  +-------------------+  |
|  | offline-search-worker  |  |   crop-worker.js   |  |   app.js (Main)   |  |
|  | - SQLite-Wasm (OPFS/IDB|  | - worker-setup.js  |  | - Virtual scroll  |  |
|  | - search-wasm          |  | - PDF.js (chunks)  |  | - UI & split view |  |
|  | - Requêtes FTS locales |  | - OffscreenCanvas  |  | - DynamicCropMgr  |  |
|  +------------------------+  +--------------------+  +-------------------+  |
|                                                                             |
|  +-----------------------------------------------------------------------+  |
|  |                    sw.js (Service Worker Cache v5)                    |  |
|  | - App Shell PWA, fallback HTTP 503 -> bascule automatique crop local  |  |
|  +-----------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------+
```

### A. La Source Unique de Vérité (`search-core`)
Localisation : [`backend-rust/crates/search-core`](backend-rust/crates/search-core)  
C'est le composant le plus critique du dépôt. **Il garantit qu'aucune ligne de SQL n'est dupliquée ou divergente entre le client et le serveur.**

1. **`schema.rs`** : Contient le schéma DDL SQLite complet :
   - `folders`, `documents`, `pages`.
   - Table virtuelle FTS5 `pages_fts` (`content='pages'`, `content_rowid='id'`, `tokenize="unicode61 remove_diacritics 2"`, `prefix='2 3 4'`).
   - Triggers automatiques de synchronisation FTS5 (`pages_ai`, `pages_ad`, `pages_au`).
   - Table `document_annotations`.
2. **`sql.rs`** : Générateurs de requêtes SQL canoniques :
   - `build_search_query_sql(...)` : CTE complexe (`raw_matches`, `doc_summary`, `scored_docs`, `ranked_pages`) calculant le score unifié.
   - `build_title_search_sql(...)` : Recherche FTS5 / LIKE sur les titres.
   - `build_doc_search_sql(...)` : Recherche dans un document cible (Split View).
   - Constantes DML : `INSERT_OR_REPLACE_DOC_SQL`, `DELETE_DOC_PAGES_SQL`, `INSERT_PAGE_SQL`, `DELETE_DOC_SQL`, etc.
3. **`matching.rs`** : Algorithme spatial de surbrillance (`find_occurrences_on_page`) et calcul du hash de requête.
4. **`crop.rs`** : Fonction pure `calculate_crop_bounds(rect, page_w, page_h, target_w, target_h)` dimensionnant les extraits à 300×120 px avec marge de respiration tout en restant dans les limites de la page.

### B. Le Backend Rust (Serveur & API)
Localisation : [`backend-rust`](backend-rust)
- **Framework** : Axum 0.7, Rusqlite avec FTS5 activé, Tower-HTTP (CORS, compression, headers COOP/COEP pour SQLite-Wasm SharedArrayBuffer).
- **Point d'entrée** : [`src/main.rs`](backend-rust/src/main.rs) et [`src/lib.rs`](backend-rust/src/lib.rs).
- **Indexation** : [`src/pdf/indexer.rs`](backend-rust/src/pdf/indexer.rs) extrait le texte mot-à-mot avec ses coordonnées géométriques (format JSON compact `words`).
- **Endpoint Hors-Ligne Clé** : `GET /api/documents/:id/offline-bundle` dans [`src/routes/documents.rs`](backend-rust/src/routes/documents.rs) qui sérialise en un seul appel les métadonnées du document et toutes ses pages avec le tableau `words`.

### C. Le Client Web & l'Architecture Multi-Workers
Localisation : [`frontend`](frontend)
Pour garantir une réactivité à 60 FPS sans bloquer l'UI lors de calculs lourds, l'application est compartimentée en Workers :
1. **`offline-search-worker.js`** : Gère l'instance SQLite-Wasm locale et exécute les requêtes SQL compilées par `search-wasm`.
2. **`crop-worker.js` & `worker-setup.js`** : Worker dédié au recadrage visuel local des PDF en mode déconnecté.
   - `worker-setup.js` est importé **en tout premier** pour polyfiller l'environnement DOM minimal requis par PDF.js et mapper la création de canvas sur `OffscreenCanvas`.
   - Rend les extraits en WebP via `OffscreenCanvas.convertToBlob({ type: 'image/webp' })` et dessine le surlignage jaune Goodnotes.
3. **`download-queue-manager.js`** : Orchestrateur de téléchargement hors-ligne (télécharge le bundle JSON et découpe les chunks du fichier binaire PDF dans IndexedDB `docseeker_pdf_chunks_v2`).
4. **`sw.js`** : Service Worker PWA (version actuelle : `docseeker-app-shell-v5`). Met en cache l'App Shell et intercepte `/api/crop/` en renvoyant une erreur 503 en cas d'absence de réseau afin de déclencher le fallback sur `crop-worker.js`.

---

## 4. Ce qui a été Réalisé

Voici l'inventaire des chantiers techniques majeurs récemment finalisés :

1. **Élimination totale de la duplication de code** :
   - Plus aucune ligne de SQL écrite en dur dans le frontend JavaScript.
   - Compilation de `search-core` vers `search_wasm_bg.wasm` (`wasm-bindgen`).
2. **Parité mathématique du Scoring Goodnotes validée** :
   - Formule : `Score = (+1500 si correspondance Titre) + BM25 + (NombreDePagesAyantOccurrences * 5.0)`.
   - Validée à 100% sur 70 documents et 18 183 pages médicales réelles.
3. **Expérience Cache Hors-Ligne & Ergonomie UI** :
   - **Badges dynamiques de dossier** : Indication de complétude `[En cache (N)]` ou `[Partiel (K/N)]`.
   - **Suppression du cache local** : Bouton corbeille sur les dossiers et action au survol sur le document pour libérer l'espace disque.
   - **Bouton de téléchargement moderne** : Animation de chargement avec `.spin-indicator`, gestion réactive de l'état, et transition vers la pilule émeraude `[✓ En cache]`.
4. **Résolution du piège ES Modules / Web Worker pour PDF.js** :
   - Résolution de l'erreur `Cannot read properties of undefined (reading 'createElement')` grâce à l'ordre d'importation strict de `worker-setup.js`.
5. **Recherche dans un document en cours de consultation (Split View)** :
   - Bascule automatique : exécution 100% locale dans SQLite-Wasm si le document est en cache (0 requête réseau), ou appel du serveur si non présent localement.

---

## 5. Où en est le Projet Aujourd'hui

- **Branche de travail** : `feat/offline-shared-search-engine`.
- **Statut de compilation** :
  - `cargo check` : **0 warning, 0 error**.
  - Wasm : généré et à jour dans `frontend/wasm/search_wasm/`.
- **Données réelles intégrées** :
  - La base SQLite serveur `data/db.sqlite` contient 69-70 documents indexés et **18 183 pages de médecine**.
  - Document témoin de référence : Document #1 (`023 - Grossesse normale.pdf`), idéal pour vérifier les occurrences multiples (45 occurrences de *grossesse*).
- **Validation fonctionnelle** :
  - L'ensemble du script maître `./run_tests.sh` passe à **100% sans aucune défaillance**.
  - Le serveur local est opérationnel sur `http://localhost:8080`.

---

## 6. Stratégie de Test & Tests UI Initiés

La couverture de test est l'une des grandes forces du projet actuel. Elle combine tests unitaires, tests de scoring, tests Wasm, tests volumétriques et tests UI réels dans le navigateur.

### A. Suite de tests automatisés (`run_tests.sh`)
Exécute les 5 paliers de validation d'un seul bloc :
```bash
./run_tests.sh
```
1. **Étape [1/5] - Tests d'intégration API Rust (`backend-rust/tests/api_comprehensive_tests.rs`)** :
   - Couvre 100% des endpoints de l'API : authentification Argon2id, rate-limiter, session cookies, CRUD dossiers, CRUD documents, recherche globale, recherche split-view, annotations, pipeline status, retry-failed, bundles offline et sync check (Last-Write-Wins).
2. **Étape [2/5] - Vérification du formatage et compilation (`cargo check`)** :
   - Contrôle strict du compilateur Rust.
3. **Étape [3/5] - Tests du moteur Hors-Ligne Wasm & Scoring (`tests/test_offline_wasm_and_scoring.mjs`)** :
   - Initialise SQLite cliente via Wasm.
   - Injecte des documents réels et valide le tri par score strictement décroissant et l'exactitude des calculs de crop.
4. **Étape [4/5] - Pipeline de vignettes hors-ligne (`tests/test_offline_vignettes.mjs`)** :
   - Vérifie la compatibilité de `pdf.mjs` dans un Web Worker.
   - Valide l'importation de `worker-setup.js`.
   - Extrait 45 occurrences réelles sur le document 023 et calcule les 45 crops.
5. **Étape [5/5] - Tests sur corpus réel de gros volume (`scripts/automated_real_corpus_search_test.py`)** :
   - Exécute 17 requêtes représentatives sur les 18 183 pages de la base réelle.
   - Valide plus de 180 000 occurrences textuelles et spatiales.

### B. Suite de tests UI automatisés Playwright (`tests/ui/ui_complete.spec.mjs`)
Conformément aux standards industriels, la validation de l'interface utilisateur est entièrement automatisée avec **Playwright** et intégrée à `run_tests.sh` (Étape [6/6]) :
```bash
npx playwright test
```
Elle valide automatiquement les 9 scénarios réels suivants dans Chromium :
1. **Chargement de la bibliothèque** : Vérification des dossiers à la racine (*Martingale*), navigation dans le dossier, affichage du Doc #1 (*023 - Grossesse normale*) et retour racine via le fil d'Ariane.
2. **Recherche globale en ligne** : Recherche réelle sur le corpus médical (`"grossess"`), calcul des scores et rendu des vignettes 300×120 px avec surbrillance.
3. **Mise en cache réelle** : Téléchargement du binaire PDF, découpage par fragments de 256 Ko dans IndexedDB, enregistrement OPFS et transition du bouton vers `.doc-cache-btn.cached` avec `"En cache"`.
4. **Persistance après rechargement (F5)** : Rechargement complet sans perte du cache local via OPFS (`sqlite3.oo1.OpfsDb`).
5. **Dossiers avec documents en cache (Filtre Hors-Ligne)** : Maintien de l'affichage du dossier *Martingale* à la racine lorsqu'un de ses documents est en cache, affichage du badge `⚡ 1/3` ou `✓ En cache`, et navigation à l'intérieur pour consulter le document.
6. **Recherche & consultation Split View en Full Hors-Ligne (Coupure Réseau)** : Coupure réseau intégrale (`context.setOffline(true)`), recherche BM25 locale instantanée, génération des crops WebP locaux par `crop-worker.js` via `OffscreenCanvas` (`blob:` URLs), ouverture du visualiseur latéral Split View et lecture des pages PDF depuis IndexedDB.
7. **Purge et libération d'espace** : Suppression du cache local avec boîte de confirmation modale et retour à l'état cloud initial.
8. **Sélection Multiple & Actions par lot** : Sélection multiple de 2 documents à la racine via leurs cases à cocher, mise en cache par lot avec passage synchrone à `.cached`, puis retrait du cache par lot avec boîte de confirmation.
9. **Couverture complète du statut cache dossier** : Mise en cache des 3 documents du dossier *Martingale*, retour à la racine, validation de la visibilité sans masque du badge (largeur > 45px, non tronqué), du statut `✓ En cache` (.complete) et du bouton de purge du dossier.

### C. Validation visuelle complémentaire Chrome DevTools (CDP)
Un script complémentaire permet d'inspecter en direct l'onglet Chrome actif (port 9222) :
```bash
node scripts/cdp_test.mjs
```

---

## 7. Guide de Démarrage & Commandes Clés (Cheat-sheet)

### Lancer le serveur de développement
Depuis la racine du projet :
```bash
./run.sh
```
Le serveur compile le backend Rust et le lance sur `http://localhost:8080`.

### Recompiler le module WebAssembly client (`search-wasm`)
Si tu modifies [`backend-rust/crates/search-core`](backend-rust/crates/search-core) ou [`backend-rust/search-wasm`](backend-rust/search-wasm) :
```bash
cd backend-rust/search-wasm
wasm-pack build --target web --out-dir ../../frontend/wasm/search_wasm --release
cd ../..
```

### Lancer l'intégralité de la suite de tests
```bash
./run_tests.sh
```

### Lancer le test d'automatisation UI (Chrome CDP)
Pré-requis : avoir Chrome ouvert avec `--remote-debugging-port=9222` sur la page `http://localhost:8080` :
```bash
node scripts/cdp_test.mjs
```

---

## 8. Points de Vigilance & Pièges à Éviter

1. **Cache du Service Worker (`sw.js`)** :
   - À chaque modification de `app.js`, `style.css`, `crop-worker.js` ou des fichiers Wasm, **incrémente la version du cache** dans `sw.js` (`CACHE_NAME = 'docseeker-app-shell-v6'`) et les query strings (`?v=6.3`) dans `index.html` et `sw.js`.
   - Sans cela, Chrome continuera de servir l'ancienne version mise en cache, ce qui peut masquer tes corrections.
2. **Hoisting des imports dans les Web Workers** :
   - Dans `crop-worker.js`, ne place **jamais** de code exécutable avant les `import`. En JavaScript ES Modules, les `import` s'exécutent en premier. C'est pour cela que `import './worker-setup.js';` est placé tout en haut.
3. **Isolation multi-threads (COOP / COEP)** :
   - Pour que SQLite-Wasm utilise `SharedArrayBuffer` et l'accès OPFS haute performance, le serveur HTTP Rust envoie obligatoirement les en-têtes :
     - `Cross-Origin-Opener-Policy: same-origin`
     - `Cross-Origin-Embedder-Policy: require-corp`
   - Conserve ces en-têtes actifs dans [`backend-rust/src/main.rs`](backend-rust/src/main.rs).
4. **Cohérence du Schéma SQLite** :
   - Si tu ajoutes une colonne ou une table, modifie **exclusivement** [`backend-rust/crates/search-core/src/schema.rs`](backend-rust/crates/search-core/src/schema.rs). Ne modifie jamais une requête SQL directement dans le frontend JavaScript.

---

Bonne reprise du projet ! La base est saine, rigoureusement modulaire et couverte par les tests. Si tu as le moindre doute, réfère-toi aux logs d'exécution de `./run_tests.sh`.
