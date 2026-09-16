# Dossier de Passation Technique - Projet DocSeeker (DocFastExplorer)

> **Document destiné au successeur technique**  
> **Branches Git de référence :** `main` et `feat/offline-shared-search-engine`  
> **Dernier commit validé :** `9cf191e`  
> **Date de passation :** 16 Septembre 2026  
> **Auteur sortant :** Agent IA Antigravity (Google DeepMind)  
> **Statut global :** ✅ Moteur en ligne & hors-ligne 100% opérationnels, suite de 11 tests UI Playwright validée à 100% (0 régression, 0 erreur console).

---

## Sommaire
1. [Introduction & Vision du Projet](#1-introduction--vision-du-projet)
2. [Cartographie des Spécifications & Documentation](#2-cartographie-des-spécifications--documentation)
3. [Architecture Globale & Principes Fondamentaux](#3-architecture-globale--principes-fondamentaux)
   - [A. La Source Unique de Vérité (`search-core`)](#a-la-source-unique-de-vérité-search-core)
   - [B. Le Backend Rust (Serveur & API Axum)](#b-le-backend-rust-serveur--api-axum)
   - [C. Le Client Web & l'Architecture Multi-Workers](#c-le-client-web--larchitecture-multi-workers)
   - [D. Découplage Strict En Ligne vs Hors-Ligne](#d-découplage-strict-en-ligne-vs-hors-ligne)
4. [Ce qui a été Réalisé & Historique des Décisions Clés](#4-ce-qui-a-été-réalisé--historique-des-décisions-clés)
5. [Où en est le Projet Aujourd'hui](#5-où-en-est-le-projet-aujourdhui)
6. [Stratégie de Test & Suite de Tests Automatisés](#6-stratégie-de-test--suite-de-tests-automatisés)
   - [A. Suite Playwright UI Réelle (11/11 tests passés)](#a-suite-playwright-ui-réelle-1111-tests-passés)
   - [B. Suite complète d'intégration (`run_tests.sh`)](#b-suite-complète-dintégration-run_testssh)
7. [Guide de Démarrage & Commandes Clés (Cheat-sheet)](#7-guide-de-démarrage--commandes-clés-cheat-sheet)
8. [Retours d'Expérience, Pièges Critiques & Points de Vigilance](#8-retours-dexpérience-pièges-critiques--points-de-vigilance)
   - [Piège 1 : `.gitignore` généré automatiquement par `wasm-pack`](#piège-1--gitignore-généré-automatiquement-par-wasm-pack)
   - [Piège 2 : Interdiction des Nested Workers dans Firefox & Safari](#piège-2--interdiction-des-nested-workers-dans-firefox--safari)
   - [Piège 3 : Découplage Online du Web Worker Wasm](#piège-3--découplage-online-du-web-worker-wasm)
   - [Piège 4 : Service Worker HTTP 503 et Navigation F5 sans Wi-Fi](#piège-4--service-worker-http-503-et-navigation-f5-sans-wi-fi)
   - [Piège 5 : Quotas de stockage et persistance (iOS 1 Go)](#piège-5--quotas-de-stockage-et-persistance-ios-1-go)
9. [Prochaines Étapes Recommandées](#9-prochaines-étapes-recommandées)

---

## 1. Introduction & Vision du Projet

**DocSeeker** (répertoire de travail : `DocFastExplorer`) est un moteur de recherche visuelle et d'exploration ultra-rapide pour volumineux corpus de documents PDF (plusieurs dizaines de milliers de pages, typiquement utilisé pour des cours de médecine, polycopiés nationaux et manuels universitaires).

### Les Piliers d'Expérience Utilisateur (UX)
1. **Ergonomie visuelle inspirée de Goodnotes** : Les résultats ne sont pas de simples lignes de texte, mais des **vignettes découpées (crops 300×120 px)** de la page réelle, avec **surlignage jaune Goodnotes translucide (`rgba(255, 226, 0, 0.45)`)** centré exactement sur les coordonnées géométriques du mot.
2. **Recherche instantanée et tolérante** : SQLite FTS5 avec stemming, désaccentuation automatique (`unicode61 remove_diacritics 2`), préfixes (`grossess*`), pondération BM25 et sur-pondération massive des titres (+1500 points).
3. **Double mode En ligne / Hors-ligne (PWA)** : L'utilisateur peut travailler connecté à son serveur local / NAS Synology ou nomade en mode avion complet sans Wi-Fi. Le comportement, les résultats, les vignettes et les scores sont **strictement identiques à 100%**.
4. **Visualisation intégrée en Split View** : Consultation du document avec lecteur PDF.js synchronisé et volet de recherche documentaire contextuel.

---

## 2. Cartographie des Spécifications & Documentation

Avant toute intervention, consulte les documents de référence déjà présents dans le dépôt :

- [📄 `cahier_des_charges.md`](cahier_des_charges.md) : Spécification originelle de la plateforme (ingestion PDFium, organisation en dossiers/sous-dossiers, annotations, principes d'interface).
- [📄 `CAHIER_DES_CHARGES_OFFLINE.md`](CAHIER_DES_CHARGES_OFFLINE.md) : Spécification fonctionnelle et exigences de parité du mode hors-ligne (zéro régression, conservation absolue du score Goodnotes, gestion du stockage local IndexedDB + SQLite-Wasm).
- [📄 `IMPLEMENTATION_TECHNIQUE_OFFLINE.md`](IMPLEMENTATION_TECHNIQUE_OFFLINE.md) : Dossier technique détaillé de l'architecture hors-ligne (schéma relationnel DDL, protocole des messages Web Workers, structure du bundle hors-ligne, pipeline de rendu OffscreenCanvas).
- [📄 `DEPLOY_SYNOLOGY.md`](DEPLOY_SYNOLOGY.md) : Guide d'exploitation et de déploiement conteneurisé sur NAS Synology (Container Manager / Docker).

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
|  | - SQLite-Wasm (OPFS/VFS|  | - worker-setup.js  |  | - Virtual scroll  |  |
|  | - search-wasm          |  | - PDF.js direct    |  | - UI & split view |  |
|  | - Requêtes FTS locales |  | - OffscreenCanvas  |  | - DynamicCropMgr  |  |
|  +------------------------+  +--------------------+  +-------------------+  |
|                                                                             |
|  +-----------------------------------------------------------------------+  |
|  |                    sw.js (Service Worker Cache v12)                   |  |
|  | - App Shell PWA, fallback navigation mode, tolérance ignoreSearch     |  |
|  +-----------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------+
```

### A. La Source Unique de Vérité (`search-core`)
Localisation : [`backend-rust/crates/search-core`](backend-rust/crates/search-core)  
**Aucune ligne de SQL n'est dupliquée entre le client et le serveur.**

1. **`schema.rs`** : Contient le schéma DDL SQLite complet :
   - Tables `folders`, `documents`, `pages`.
   - Table virtuelle FTS5 `pages_fts` (`content='pages'`, `content_rowid='id'`, `tokenize="unicode61 remove_diacritics 2"`, `prefix='2 3 4'`).
   - Triggers automatiques de synchronisation FTS5 (`pages_ai`, `pages_ad`, `pages_au`).
2. **`sql.rs`** : Générateurs de requêtes SQL canoniques :
   - `build_search_query_sql(...)` : CTE calculant le score unifié.
   - `build_title_search_sql(...)` : Recherche FTS5 / LIKE sur les titres.
   - `build_doc_search_sql(...)` : Recherche dans un document cible (Split View).
   - Constantes DML : `INSERT_OR_REPLACE_DOC_SQL`, `DELETE_DOC_PAGES_SQL`, `INSERT_PAGE_SQL`, `DELETE_DOC_SQL`, etc.
3. **`matching.rs`** : Algorithme spatial de surbrillance (`find_occurrences_on_page`) et calcul du hash de requête.
4. **`crop.rs`** : Fonction pure `calculate_crop_bounds(rect, page_w, page_h, target_w, target_h)` dimensionnant les extraits à 300×120 px avec marge de respiration tout en restant dans les limites de la page.

### B. Le Backend Rust (Serveur & API Axum)
Localisation : [`backend-rust`](backend-rust)
- **Framework** : Axum 0.7, Rusqlite avec FTS5 activé, Tower-HTTP (CORS, compression, headers COOP/COEP).
- **Point d'entrée** : [`src/main.rs`](backend-rust/src/main.rs) et [`src/lib.rs`](backend-rust/src/lib.rs).
- **Fichiers statiques** : [`src/static_files.rs`](backend-rust/src/static_files.rs) sert les assets embarqués via `rust-embed` ou depuis le disque, avec types MIME stricts (`application/wasm`, `text/javascript; charset=utf-8`).
- **Endpoint Hors-Ligne Clé** : `GET /api/documents/:id/offline-bundle` dans [`src/routes/documents.rs`](backend-rust/src/routes/documents.rs) qui sérialise en un seul appel les métadonnées du document et toutes ses pages avec le tableau `words`.

### C. Le Client Web & l'Architecture Multi-Workers
Localisation : [`frontend`](frontend)
1. **`offline-search-worker.js`** : Gère l'instance SQLite-Wasm locale et exécute les requêtes SQL compilées par `search-wasm`.
2. **`crop-worker.js` & `worker-setup.js`** : Worker dédié au recadrage visuel local des PDF en mode déconnecté.
   - `worker-setup.js` est importé en premier pour polyfiller l'environnement DOM minimal requis par PDF.js et mapper sur `OffscreenCanvas`.
   - Rend les extraits en WebP (ou PNG en fallback) via `OffscreenCanvas.convertToBlob()` et dessine le surlignage jaune Goodnotes.
   - **Exécution directe** : Importe `pdf.worker.mjs` dans `globalThis.pdfjsWorker` pour exécuter le rendu directement sur son thread sans créer de sous-worker (compatible Firefox/Safari).
3. **`download-queue-manager.js`** : Orchestrateur de téléchargement hors-ligne (télécharge le bundle JSON, l'insère dans SQLite-Wasm, et découpe les chunks du binaire PDF dans IndexedDB `docseeker_pdf_chunks_v2`).
4. **`sw.js`** : Service Worker PWA (version actuelle : `docseeker-app-shell-v12`). Tolérance `{ ignoreSearch: true }` et interception navigation `index.html`.

### D. Découplage Strict En Ligne vs Hors-Ligne
- **Règle d'or** : L'affichage de la bibliothèque connectée ne doit **JAMAIS** être bloqué par l'initialisation asynchrone du Web Worker SQLite-Wasm.
- En ligne (`navigator.onLine !== false`), [`loadFoldersAndDocuments()`](frontend/app.js) déclenche immédiatement les requêtes réseau `/api/folders` et `/api/documents`. L'initialisation du cache hors-ligne tourne en tâche de fond non bloquante.
- En cas de coupure réseau ou d'échec HTTP (503), l'application bascule automatiquement sur les données locales du cache SQLite-Wasm.

---

## 4. Ce qui a été Réalisé & Historique des Décisions Clés

1. **Élimination totale de la duplication SQL** : Rust `search-core` compilé vers WebAssembly (`search-wasm`) pour SQLite-Wasm local et Axum serveur.
2. **Parité mathématique du Scoring Goodnotes validée** :
   `Score = (+1500 si correspondance Titre) + BM25 + (NombreDePagesAyantOccurrences * 5.0)`.
3. **Refonte de la consistance UI des boutons de cache** :
   - Badges compacts : tick vert `✓` quand le document/dossier est 100% en cache, tick ambré si partiellement en cache.
   - Bouton distinct **nuage barré** pour supprimer un document ou un dossier du cache local.
4. **Résolution des incompatibilités Firefox & Safari sur Synology** :
   - Élimination des Nested Workers dans `crop-worker.js`.
   - Résolution du blocage sur HTTP Synology grâce aux timeouts de secours (`sendToWorker` à 3s, `ensureInitialized` borné à 1.5s).
   - Détection automatique et bascule sur le moteur hors-ligne lors d'un `NetworkError`.
   - Ajout du fallback de navigation dans `sw.js` pour les rechargements F5 sans Wi-Fi.
5. **Intégration et versionnage des binaires Wasm** :
   - Suppression du `.gitignore` interne généré par `wasm-pack` qui masquait `search_wasm_bg.wasm` dans Docker.

---

## 5. Où en est le Projet Aujourd'hui

- **Branches** : `main` et `feat/offline-shared-search-engine` synchronisées au commit `9cf191e`.
- **Pipeline CI/CD** : GitHub Actions compile le binaire Rust multi-arch (AMD64 et ARM64), exécute `cargo test` avec `libpdfium`, et publie l'image Docker sur GitHub Packages / Docker Hub.
- **Statut des tests** : **11/11 tests Playwright passés avec succès** (0 erreur).
- **Statut de compilation** : `cargo check` clean (0 warning, 0 error).

---

## 6. Stratégie de Test & Suite de Tests Automatisés

### A. Suite Playwright UI Réelle (11/11 tests passés)
Fichier : [`tests/ui/ui_complete.spec.mjs`](tests/ui/ui_complete.spec.mjs)  
Exécution :
```bash
npx playwright test
```

Scénarios validés :
1. **1. Chargement & Exploration de la Bibliothèque en Ligne** : Navigation dans les dossiers, fil d'Ariane.
2. **2. Recherche Globale en Ligne & Rendu Visuel des Vignettes** : Rendu des extraits 300×120 px et surlignage.
3. **3. Mise en Cache Réelle** : Téléchargement bundle + PDF binaire dans IndexedDB, transition vers tick vert.
4. **4. Persistance du Cache après Rechargement (F5)** : Données conservées dans SQLite local après F5.
5. **5. Filtrage Hors-Ligne** : Affichage exclusif des dossiers et documents disponibles localement.
6. **6. Recherche & Split View en Full Hors-Ligne (Coupure Réseau)** : Coupure réseau simulée, recherche BM25 locale, rendu des vignettes via `crop-worker.js` (`blob:` URLs) et lecture PDF depuis IndexedDB.
7. **7. Cycle de Suppression du Cache Local** : Boîte modale de confirmation et purge du stockage.
8. **8. Sélection Multiple & Actions par lot** : Mise en cache et suppression par lot.
9. **9. Statut Cache Dossier** : Badge de complétude `✓ En cache` non tronqué (> 45 px).
10. **10. Parité Absolue Hors-Ligne** : Recherche de *« insuffisance rénale aigue »* dans *Néphrologie*, validation stricte du titre p. 267 en 1ère vignette et 25 vignettes affichées.
11. **11. Bouton Nuage Barré, Bascules Rapides & Réinitialisation** : 0 vignette blanche après bascules rapides, réinitialisation complète de la recherche via le bouton **X**, la touche **Échap** et le bouton **Scanner**.

### B. Suite complète d'intégration (`run_tests.sh`)
```bash
./run_tests.sh
```
Exécute les tests d'intégration API Rust, la vérification de compilation, les tests unitaires Wasm, les tests d'occurrences sur corpus réel et la suite Playwright.

---

## 7. Guide de Démarrage & Commandes Clés (Cheat-sheet)

### Lancer le backend en local
```bash
./run.sh
```
L'application est accessible sur `http://localhost:8080`.

### Recompiler le module WebAssembly client (`search-wasm`)
Si tu modifies [`backend-rust/crates/search-core`](backend-rust/crates/search-core) ou [`backend-rust/search-wasm`](backend-rust/search-wasm) :
```bash
cd backend-rust/search-wasm
wasm-pack build --target web --out-dir ../../frontend/wasm/search_wasm --release
cd ../..
# IMPORTANT : Supprimer immédiatement le .gitignore généré par wasm-pack !
rm -f frontend/wasm/search_wasm/.gitignore
git add frontend/wasm/search_wasm/
```

### Lancer les tests Playwright
```bash
npx playwright test
```

### Lancer la suite d'intégration complète
```bash
./run_tests.sh
```

---

## 8. Retours d'Expérience, Pièges Critiques & Points de Vigilance

### Piège 1 : `.gitignore` généré automatiquement par `wasm-pack`
- **Problème** : `wasm-pack build` écrit automatiquement un fichier `.gitignore` contenant `*` dans le répertoire de sortie `frontend/wasm/search_wasm/`.
- **Conséquence** : Git ignore silencieusement `search_wasm_bg.wasm` et `search_wasm.js`. En local, tout fonctionne car les fichiers sont sur le disque, mais le build Docker CI GitHub clone le repo sans ces fichiers, rendant l'image Docker défaillante (404 sur Wasm).
- **Règle** : Toujours supprimer ce fichier avec `rm -f frontend/wasm/search_wasm/.gitignore` et s'assurer que `search_wasm_bg.wasm` est bien tracké (`git status`).

### Piège 2 : Interdiction des Nested Workers dans Firefox & Safari
- **Problème** : Dans un Web Worker, exécuter `new Worker(...)` (par exemple ce que fait PDF.js par défaut via `GlobalWorkerOptions.workerSrc`) lève une exception fatale sous Firefox et Safari car les Nested Workers ne sont pas autorisés dans un `DedicatedWorkerGlobalScope`.
- **Solution mise en place** : Dans [`frontend/crop-worker.js`](frontend/crop-worker.js), `pdf.worker.mjs` est importé directement et exposé sur `globalThis.pdfjsWorker`. PDF.js exécute ainsi son pipeline directement sur le thread du crop-worker, sans sous-worker.

### Piège 3 : Découplage Online du Web Worker Wasm
- **Problème** : Sur un NAS Synology accédé en HTTP pur (non HTTPS), l'API OPFS (`navigator.storage.getDirectory()`) est bloquée par le navigateur (car réservée aux Secure Contexts). Si `loadFoldersAndDocuments()` attend le Web Worker de manière bloquante, l'application reste figée sur une page blanche.
- **Règle** : Ne jamais bloquer le chargement réseau en ligne sur le Web Worker. Toujours encadrer les communications worker par des timeouts stricts (ex: 3 000 ms dans `sendToWorker` et 1 500 ms dans `ensureInitialized`).

### Piège 4 : Service Worker HTTP 503 et Navigation F5 sans Wi-Fi
- **Problème** : En cas de coupure Wi-Fi, `sw.js` renvoie HTTP 503 pour les routes API. `fetch` ne lève donc pas d'exception JavaScript (`res.ok` est simplement faux).
- **Règle** : Dans [`app.js`](frontend/app.js), toujours vérifier `if (!res.ok) throw new Error(...)` pour forcer le basculement vers le bloc `catch` qui charge les données locales SQLite-Wasm. Dans `sw.js`, gérer `event.request.mode === 'navigate'` pour servir `index.html` depuis le cache.

### Piège 5 : Quotas de stockage et persistance (iOS 1 Go)
- **Règle** : Sur iOS/Safari, le quota initial est de 1 Go par origine. L'installation en mode PWA (*Ajouter à l'écran d'accueil*) et l'appel à `navigator.storage.persist()` protègent le stockage contre les purges automatiques du système.

---

## 9. Prochaines Étapes Recommandées

Si tu souhaites poursuivre l'amélioration de DocSeeker, voici les chantiers naturels suivants :
1. **Visualisation du statut de téléchargement en Split View** : Afficher une barre de progression discrète en bas du visualiseur PDF lors de la mise en cache complète d'un document ouvert.
2. **Exportation / Sauvegarde du cache local** : Proposer un bouton d'export/import d'archive de la base SQLite locale pour transférer ses documents hors-ligne entre deux appareils sans re-télécharger.
3. **Support étendu du moteur de recherche dans les annotations** : Étendre `build_search_query_sql` pour inclure les notes manuscrites et textes ajoutés par l'utilisateur dans les résultats de recherche.

---

Bonne continuation ! Le projet repose sur des fondations solides, modulaires et intégralement validées par les tests automatisés. En cas de doute, consulte les spécifications de référence ou relance la suite Playwright avec `npx playwright test`.
