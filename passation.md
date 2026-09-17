# PASSATION — Documentation Technique & Bilan DocSeeker v2.0

> **Date :** 17 Septembre 2026 — 23h35  
> **Auteur :** Antigravity (Agent Pair Programming)  
> **Destinataire :** Développeur successeur / Équipe de maintenance  
> **État du projet :** **100% OPÉRATIONNEL & VALIDÉ PAR LES TESTS**  
> *(Stable 22/22 ✅ | Stress 51/51 ✅ | Edge Cases 18/18 dont Matrice I ✅)*

---

## 1. Vue d'Ensemble de l'Architecture

DocSeeker est un moteur de recherche visuelle haute performance dans les documents PDF, fonctionnant en ligne et hors-ligne (PWA) :

1. **Backend Rust (Axum, port 8080) :**
   - Base de données locale SQLite (`data/db.sqlite`) avec moteur FTS5 pour la recherche plein texte instantanée.
   - Moteur PDFium (`libpdfium`) pour l'extraction de texte/coordonnées de mots et le rendu des vignettes WebP haute fidélité.
   - Pipeline d'indexation asynchrone en arrière-plan avec file d'attente thread-safe.
   - Authentification par session sécurisée (`__Host-docseeker_session`).

2. **Frontend SPA (Vanilla JavaScript, HTML5, CSS3) :**
   - Zéro framework lourd (performance native maximale et maintenance pérenne).
   - PWA complète avec Service Worker (`frontend/sw.js`) agissant comme reverse proxy local pour le cache des PDF, vignettes et couvertures.
   - Recherche locale hors-ligne décentralisée : Web Worker (`offline-search-worker.js`) avec SQLite-Wasm sur OPFS (Origin Private File System) et moteur de scoring BM25 Rust-Wasm.
   - Rendu des vignettes hors-ligne : Worker dédié (`crop-worker.js`) avec PDF.js.

---

## 2. Synthèse Complète des Bugs Résolus & Correctifs Applicatifs

### Bug #1 : Race Condition UI sur double-clic (Suppression / Téléchargement du Cache)
- **Symptôme :** Un double-clic rapide sur l'icône de suppression du cache local (`.btn-delete-doc-cache`) supprimait le document puis le re-téléchargeait immédiatement en cache à l'insu de l'utilisateur.
- **Cause :** Dès le 1er clic, le bouton de suppression passait en `display: none` et révélait le bouton adjacent `.doc-cache-btn`. Le 2e clic (survenu 11ms plus tard) atterrissait sur le bouton de téléchargement.
- **Correction (`frontend/app.js`) :**
  - Ajout d'une fenêtre de cooldown anti-rebond de 500ms (`lastCacheActionTime`).
  - Blocage immédiat de tout événement résiduel sur `cacheBtn` dans cette fenêtre.
  - Bouton temporairement désactivé pendant l'opération (`disabled = true`).

---

### Bug #2 : Clics rapides sur un dossier → Doublons dans le fil d'Ariane
- **Symptôme :** Cliquer plusieurs fois d'affilée sur une carte dossier avant la fin du chargement affichait `Documents > Dossier > Dossier` dans le fil d'Ariane.
- **Cause :** `enterFolder()` empilait sans vérification d'idempotence les entrées alors que les requêtes réseau étaient en vol et le DOM cliquable.
- **Correction (`frontend/app.js`) :**
  - Guard d'idempotence : vérification `currentFolderId === folder.id`.
  - Verrou de navigation asynchrone : `foldersContainer.style.pointerEvents = "none"` libéré dans un bloc `finally`.
  - Déduplication consécutive défensive dans `renderBreadcrumbs()`.

---

### Bug #3 : Erreurs HTTP 400 lors de l'Upload de gros fichiers (> 2 Mo)
- **Symptôme :** Sur le Synology (`https://docseeker.bluevdo.synology.me`), les imports de fichiers volumineux échouaient en série avec `POST /api/upload?sync=false [HTTP/2 400]`.
- **Cause :** Axum applique par défaut un `DefaultBodyLimit` de 2 Mo. Dès qu'un fichier dépassait 2 Mo, le flux multipart terminait prématurément avec `PayloadTooLarge`, rendant `file_bytes` vide et déclenchant une erreur 400.
- **Correction (`backend-rust/src/routes/mod.rs`) :**
  - Ajout de `.layer(DefaultBodyLimit::max(1024 * 1024 * 1024))` sur la route `/upload` (limite portée à **1 Go**).

---

### Bug #4 : Rejet de PDF réels (BOM UTF-8, en-têtes scanners) — Norme ISO 32000-1
- **Symptôme :** Des PDF valides de 467 Ko ou scannés étaient rejetés avec `Format invalide : signature PDF manquante` à l'upload ou affichaient un badge rouge « Échec » et 0 page dans l'UI.
- **Cause :** L'ancien code effectuait `if !file_bytes.starts_with(b"%PDF-")` (uniquement au tout premier octet) dans `documents.rs` ET dans `indexer.rs`. Or, selon l'ISO 32000-1 (§7.5.2), la signature `%PDF-` peut légitimement se situer n'importe où dans les **1024 premiers octets** (précédée d'un BOM UTF-8 `\xEF\xBB\xBF`, de métadonnées PJL ou de retours à la ligne).
- **Correction (`documents.rs` et `indexer.rs`) :**
  - Inspection d'une fenêtre de 1024 octets :
    ```rust
    let header_window = &file_bytes[..file_bytes.len().min(1024)];
    let has_pdf_magic = header_window.windows(5).any(|w| w == b"%PDF-");
    if !has_pdf_magic {
        return Err((StatusCode::BAD_REQUEST, ...));
    }
    ```
  - Alignement identique dans `pdf/indexer.rs` pour la phase d'indexation.

---

### Bug #5 : Crash JS sur réindexation (`TypeError: can't access property "classList", btnElement is null`)
- **Symptôme :** Clic sur « Réindexer » dans le menu contextuel à 3 points d'un document en échec provoquait un crash JS silencieux dans la console.
- **Cause :** L'écouteur du menu contextuel appelait `handleReindexDocument(id, title, null)` sans élément bouton, tandis que la fonction tentait immédiatement `btnElement.classList.add("spinning")`.
- **Correction (`frontend/app.js`) :**
  - Garde défensive `if (btnElement) { ... }`.
  - Re-clic simplifié : cliquer sur une carte en « Échec » déclenche désormais automatiquement sa réindexation au lieu d'afficher une alerte bloquante.

---

### Bug #6 : Documents en échec ignorés lors de la synchronisation globale
- **Symptôme :** Après correction d'un bug d'indexation, cliquer sur « Scanner les nouveaux PDF » ne relançait pas les documents qui avaient échoué précédemment.
- **Cause :** `scan_and_sync_documents` filtrait les fichiers par `SELECT filename FROM documents` sans exclure `status = 'failed'`, les considérant donc déjà traités. De plus, `pipeline.retry_failed()` n'était jamais appelé.
- **Correction (`indexer.rs` et `documents.rs`) :**
  - Requête ajustée : `SELECT filename, file_hash FROM documents WHERE status != 'failed'`.
  - Appel automatique de `state.pipeline.retry_failed()` dans le handler `/api/sync` : un clic sur l'icône de synchronisation en haut à droite ré-enfile automatiquement tous les documents en échec.

---

## 3. Optimisations Majeures des Performances Hors-Ligne

Implémentées dans `crop-worker.js` et `frontend/app.js` :
1. **Concurrence dynamique multi-cœurs :**
   - `MAX_CONCURRENT_RENDERS = (navigator.hardwareConcurrency > 2) ? 2 : 1;` (débit de rendu doublé sur machines multi-cœurs via sémaphore asynchrone).
2. **File prioritaire LIFO :**
   - Dépilement par `renderQueue.pop()` : les vignettes visibles sous les yeux de l'utilisateur au scroll sont traitées immédiatement avant les vignettes déjà dépassées.
3. **Annulation hors-champ (`IntersectionObserver` + `CANCEL_TASK`) :**
   - Lorsqu'une image quitte le viewport avant traitement, le Worker retire la tâche de la file sans aucun calcul CPU inutile.
4. **Cache LRU de page décodée (`PAGE_CACHE_MAX = 3`) :**
   - Conservation en mémoire des objets pages PDF.js pour éviter de re-parser le flux PDF à chaque extrait sur une même page.
5. **Encodage WebP optimisé :**
   - `quality: 0.80` au lieu de `0.85` (gain de vitesse CPU significatif, imperceptible à l'œil).

---

## 4. Matrice Complète des Tests Automatisés (Playwright)

Les tests se trouvent dans le répertoire `tests/ui/` :

| Fichier de Test | Périmètre & Cas Validés | Statut |
|---|---|---|
| **`ui_core.spec.mjs`** | Bibliothèque, navigation, cache local OPFS, sélections tactiles, tri, Split View, toggle offline. | **22 / 22 passés ✅** |
| **`ui_stress_matrix.spec.mjs`** | Matrices A à F + Matrice S (10 cycles intensifs en ligne et hors-ligne, double-clics, flapping réseau). | **51 / 51 passés ✅** |
| **`ui_edge_cases.spec.mjs`** | **EC** (Edge cases généraux, token expiré), **G** (PWA/Service Worker), **H** (Dossiers), **I** (Import & Upload). | **18 / 18 passés ✅** |

### Détail de la Suite Matrice I (Import / Upload) :
- **I2 :** Upload fichier non-PDF → Message d'erreur clair, 0 crash.
- **I4 :** Upload pendant un téléchargement de cache actif → 0 interférence, stabilité totale.
- **I5 :** Import massif (101 fichiers dont 25 doublons réels + 1 gros fichier de 205 Mo) → 76 envoyés, 25 doublons ignorés, 0 erreur 400.
- **I6 :** Coupure réseau en plein milieu d'un import → Interruption propre de la boucle, documents déjà reçus conservés et indexés en base.
- **I7 :** Tentative d'import hors-ligne → Bloqué immédiatement, toast d'avertissement, 0 requête réseau émise.
- **I8 :** **Flux complet E2E :** Téléversement d'un PDF avec BOM UTF-8 → Indexation complète en arrière-plan (2 p., 0 badge Échec) → Recherche FTS mot-clé (*"coelioscopie"*) → Clic vignette et ouverture du panneau Split View (`#viewerPane`).

---

## 5. Commandes Utiles & Procédures d'Exploitation

### Démarrer le serveur local de développement :
```bash
./run.sh
# Lance le backend Axum compilé en mode Release sur http://localhost:8080
```

### Compiler le backend Rust :
```bash
# Vérification rapide
cargo check --manifest-path backend-rust/Cargo.toml

# Binaire optimisé Release
cargo build --release --manifest-path backend-rust/Cargo.toml
```

### Lancer les suites de tests Playwright :
```bash
# Suite Stable (~42s)
npx playwright test --project=stable

# Suite Stress (~3.3 min)
npx playwright test --project=stress

# Suite Edge Cases & Importation Matrice I (~13s)
npx playwright test tests/ui/ui_edge_cases.spec.mjs -g "Matrice I"

# Lancer un test ciblé
npx playwright test tests/ui/ui_edge_cases.spec.mjs -g "I8"
```

### Mise à jour et déploiement sur Synology NAS :
1. Les modifications sont poussées sur la branche `main` du dépôt GitHub `mmxm/DocSeeker`.
2. Sur le Synology (selon l'installation Docker / conteneur ou binaire natif) :
   ```bash
   git pull origin main
   # Si binaire natif :
   cargo build --release --manifest-path backend-rust/Cargo.toml
   # Redémarrer le service ou le conteneur Docker
   ```
3. Une fois en ligne, un simple clic sur le bouton de synchronisation (deux flèches en cercle dans le header) relancera automatiquement tous les anciens documents en statut `failed`.

---

## 6. Historique Git Récent

- **`10d21d0`** : `fix: resolve reindex btnElement null crash and align PDF header check to ISO 32000-1 in indexer`
- **`646ebbb`** : `fix(upload): ISO 32000-1 PDF magic detection in first 1024 bytes and explicit multipart error reporting`
- **`432ded0`** : `feat(upload): 1GB limit in Axum, offline guard, duplicate handling and mid-import network cut recovery`
- **`741d8cd`** : `perf(offline): optimize crop rendering with 2x concurrency, LIFO priority queue, page caching and cancellation`
- **`b26aac3`** : `fix(ui): prevent duplicate breadcrumbs on rapid folder clicks and add H6 test`
