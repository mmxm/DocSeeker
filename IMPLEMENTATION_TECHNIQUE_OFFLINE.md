# GUIDE D'IMPLÉMENTATION TECHNIQUE
## Architecture & Réalisation du Mode Hors-Ligne & Synchronisation pour DocSeeker

---

## 1. Vue d'Ensemble de l'Architecture

Pour garantir que le code du client web (`app.js`) demeure **100% identique** entre le mode en ligne et le mode hors-ligne, l'architecture repose sur le patron du **Serveur Local Virtuel (Reverse Proxy Service Worker)** :

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND UNIQUE (app.js)                                  │
│  Requêtes HTTP invariables :                                                           │
│    - GET /api/search?q=...&offline_only=false|true                                     │
│    - GET /api/crop/{docId}/{page}/{occId}?h=...&terms=...                              │
│    - GET /api/pdf/{docId}                                                              │
│    - GET /api/folders                                                                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          SERVICE WORKER (Reverse Proxy Local)                          │
│                                                                                        │
│  Routage transparent :                                                                 │
│    - Si offline_only=true OU perte de connexion (offline)                              │
│         ──► Aiguillage vers les micro-moteurs locaux (Wasm / IDB / Canvas)             │
│    - Sinon (connecté et recherche globale)                                             │
│         ──► Passe-plat direct vers le backend Rust distant                             │
└────────────────────────────────────────────────────────────────────────────────────────┘
                    │                                                │
         (Hors-Ligne / Local)                               (En Ligne / Distant)
                    ▼                                                ▼
┌──────────────────────────────────────┐          ┌──────────────────────────────────────┐
│       "SERVEUR RUST LOCAL IN-BROWSER" │          │        SERVEUR RUST DISTANT          │
│                                      │          │          (DocSeeker Backend)         │
│  1. Moteur de Recherche :            │          │                                      │
│     Wasm (Rust engine.rs compilé)    │          │  - Axum REST API                     │
│     + SQLite FTS5 (OPFS/IndexedDB)   │          │  - SQLite FTS5 + BM25                │
│                                      │          │  - Moteur de rendu Pdfium            │
│  2. Moteur de Crop Vignettes :       │          │  - Byte-Range Streamer               │
│     Web Worker PDF.js Canvas Render  │          │                                      │
│                                      │          │  Nouveaux endpoints de sync :        │
│  3. Stockage Données :               │          │  - GET /api/documents/:id/offline-...│
│     - PDF Chunks 256 Ko (IDB v2)     │          │  - POST /api/sync/check              │
│     - Couvertures WebP (Cache API)   │          └──────────────────────────────────────┘
└──────────────────────────────────────┘
```

---

## 2. Nouveaux Endpoints Backend (Serveur Rust)

Deux nouvelles routes doivent être ajoutées dans `backend-rust/src/routes/documents.rs` pour alimenter le cache local.

### 2.1. Paquet d'Index Hors-Ligne : `GET /api/documents/{id}/offline-bundle`

Ce point d'accès exporte en une seule requête compacte tout le matériel textuel et spatial nécessaire à la recherche locale sans télécharger le PDF d'un bloc.

- **Requête :** `GET /api/documents/42/offline-bundle`
- **Réponse HTTP 200 (JSON Gzippé) :**
```json
{
  "document": {
    "id": 42,
    "filename": "cours_cardiologie.pdf",
    "title": "Cardiologie et Pathologies Vasculaires",
    "file_hash": "a1b2c3d4e5f6...",
    "folder_id": 3,
    "total_pages": 140,
    "file_size": 84521092,
    "created_at": "2026-09-10T12:00:00Z",
    "updated_at": "2026-09-12T14:30:00Z"
  },
  "pages": [
    {
      "page_number": 1,
      "text_content": "Faculté de Médecine - Chapitre 1...",
      "words": [
        [45.2, 110.5, 92.4, 122.1, "Faculté", 0, 0],
        [96.0, 110.5, 112.3, 122.1, "de", 0, 0]
      ]
    }
  ]
}
```
*Note technique :* `words` respecte la structure compacte de `WordEntry(x0, y0, x1, y1, word, block_no, line_no)` déjà définie dans [`backend-rust/src/search/types.rs`](file:///Users/francois/Documents/DocFastExplorer/backend-rust/src/search/types.rs).

### 2.2. Vérification de Synchronisation : `POST /api/sync/check`

Permet au client de soumettre la liste de ses documents locaux pour détecter les modifications distantes selon la stratégie **Last-Write-Wins**.

- **Payload envoyé par le client :**
```json
{
  "cached_documents": [
    { "id": 42, "file_hash": "a1b2c3d4...", "updated_at": "2026-09-12T14:30:00Z" },
    { "id": 43, "file_hash": "e5f6a1b2...", "updated_at": "2026-09-10T08:00:00Z" }
  ]
}
```
- **Réponse HTTP 200 :**
```json
{
  "outdated_ids": [42],
  "deleted_ids": [43],
  "server_time": "2026-09-15T19:00:00Z"
}
```

---

## 3. Moteur de Recherche Wasm & Base Locale

### 3.1. Compilation du Moteur Rust en WebAssembly
Le moteur d'appariement spatial, de scoring et de regroupement des occurrences situé dans [`backend-rust/src/search/engine.rs`](file:///Users/francois/Documents/DocFastExplorer/backend-rust/src/search/engine.rs) est compilé pour le navigateur via `wasm-pack` :

```bash
# Dans backend-rust/ (ou sous-crate dédié search-wasm) :
wasm-pack build --target web --out-dir ../frontend/wasm/search_engine --release
```

- **Fonctions exportées par le module Wasm :**
  - `init_engine(pages_json: &str)` : Charge l'index des documents locaux en mémoire (table de hachage inversée ou FTS).
  - `search_local(query: &str, limit: usize, offset: usize) -> String` : Exécute `sanitize_fts_query`, calcule les scores BM25, regroupe les mots contigus avec `find_occurrences_on_page` et retourne un `SearchResponse` JSON strictement identique à celui du serveur Rust.

### 3.2. Schéma de la Base Locale SQLite (SQLite-Wasm avec OPFS)
Si l'option SQLite-Wasm est privilégiée pour manipuler 70+ documents (~400 Mo d'index) :
- Schéma cloné de [`backend-rust/src/db/schema.rs`](file:///Users/francois/Documents/DocFastExplorer/backend-rust/src/db/schema.rs) :
  - `folders(id, name, parent_id, color)`
  - `documents(id, filename, title, file_hash, folder_id, total_pages, file_size, updated_at)`
  - `pages(id, doc_id, page_number, text_content, words_json)`
  - `pages_fts USING fts5(text_content, content='pages', content_rowid='id', tokenize='unicode61 remove_diacritics 2')`
- La base est stockée dans l'**Origin Private File System (OPFS)** (`/docseeker_local.sqlite`), garantissant des écritures directes à haute vitesse sans blocage du thread principal.

---

## 4. Génération Locale des Vignettes (Crops) via PDF.js

En ligne, le serveur génère les crops via Pdfium (`/api/crop/{doc_id}/{page}/{occ_id}`).
Hors-ligne, le Service Worker intercepte cette URL et délègue la découpe à un **Crop Worker** utilisant PDF.js Canvas :

### Algorithme du Crop Worker local (`crop-worker.js`) :
```javascript
// Découpage dynamique de la zone de l'occurrence
async function renderOfflineCrop(docId, pageNumber, highlightRects, contextRect) {
  // 1. Ouvrir le document depuis le cache IndexedDB
  const pdfDoc = await pdfjsLib.getDocument({ url: `/api/pdf/${docId}` }).promise;
  const page = await pdfDoc.getPage(pageNumber);

  // 2. Calculer l'échelle et les coordonnées de la bounding box contextuelle
  const [rx0, ry0, rx1, ry1] = contextRect;
  const cropWidth = rx1 - rx0;
  const cropHeight = ry1 - ry0;

  // 3. Dessin sur OffscreenCanvas
  const canvas = new OffscreenCanvas(cropWidth * 2, cropHeight * 2);
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  // Rendu de la sous-région PDF
  const viewport = page.getViewport({ scale: 2.0 });
  await page.render({
    canvasContext: ctx,
    viewport: viewport,
    transform: [1, 0, 0, 1, -rx0, -ry0]
  }).promise;

  // 4. Application du surlignage jaune translucide sur chaque mot trouvé
  ctx.fillStyle = "rgba(255, 226, 0, 0.45)";
  for (const [hx0, hy0, hx1, hy1] of highlightRects) {
    ctx.fillRect(hx0 - rx0, hy0 - ry0, hx1 - hx0, hy1 - hy0);
  }

  // 5. Conversion en Blob WebP
  return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
}
```

---

## 5. Gestionnaire de Téléchargement & Stockage (`DownloadQueueManager`)

Le gestionnaire s'intègre en surcouche de [`frontend/pdf-cache.js`](file:///Users/francois/Documents/DocFastExplorer/frontend/pdf-cache.js) :

### 5.1. Téléchargement Résilient par Chunks de 256 Ko
- Pour chaque document :
  1. `GET /api/documents/{id}/offline-bundle` : Téléchargement et insertion de l'index dans la BDD locale.
  2. `GET /api/cover/{id}` : Mise en cache de l'image de couverture dans `CacheStorage`.
  3. **Itération sur les Range Requests** : Requêtes successives de 256 Ko (`bytes=0-262143`, `bytes=262144-524287`, etc.) écrites immédiatement dans l'object store `chunks` d'IndexedDB (`docseeker_pdf_chunks_v2`).
- **En cas de coupure :** Le curseur est conservé dans l'object store `meta` sous `downloadedBytes`. Dès reconnexion, la file reprend au bloc exact suivant.
- **Concurrence contrôlée :** Maximum 2 fichiers en transfert simultané.

### 5.2. Résolution Récursive de Dossier
- Lors du clic sur la mise en cache d'un dossier (`folder_id`) :
  1. Le client interroge l'arborescence complète (en ligne : `GET /api/folders`, ou depuis la table `folders` locale).
  2. Construction de la liste récursive des identifiants (`get_folder_and_subfolder_ids`).
  3. Récupération de tous les documents rattachés (`GET /api/documents?folder_id=...`).
  4. Enfilement séquentiel dans le `DownloadQueueManager`.

---

## 6. Routage Transparent dans le Service Worker (`sw.js`)

Le Service Worker intercepte les requêtes de l'application :

```javascript
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. App Shell (HTML, CSS, JS, PDF.js assets) -> Cache First avec Network Fallback
  if (!url.pathname.startsWith('/api/')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // 2. Requête API de Recherche (/api/search)
  if (url.pathname === '/api/search') {
    const isOfflineOnly = url.searchParams.get('offline_only') === 'true';
    const isActuallyOffline = !navigator.onLine;

    if (isOfflineOnly || isActuallyOffline) {
      event.respondWith(handleLocalSearch(url.searchParams));
      return;
    }
    // Mode en ligne standard : tentative réseau avec bascule automatique sur incident
    event.respondWith(
      fetch(event.request).catch(() => handleLocalSearch(url.searchParams))
    );
    return;
  }

  // 3. Requête de Vignette (/api/crop)
  if (url.pathname.startsWith('/api/crop/')) {
    event.respondWith(
      fetch(event.request).catch(() => handleLocalCrop(url.pathname, url.searchParams))
    );
    return;
  }

  // 4. Requête du Binaire PDF (/api/pdf)
  if (url.pathname.startsWith('/api/pdf/')) {
    // PDF.js lit déjà nativement ses fragments dans docseeker_pdf_chunks_v2
    return; 
  }
});
```

---

## 7. Modifications Frontend dans `frontend/app.js`

1. **Ajout de l'état de mise en cache sur les cartes et dossiers :**
   - Injection d'un bouton d'action avec l'icône unifiée (nuage/check) dans `doc-meta-badges` et dans l'arbre des dossiers `folder-tree-item`.
   - Écoute du clic pour invoquer `window.downloadQueueManager.enqueueDocument(docId)` ou `enqueueFolder(folderId)`.
2. **Case à cocher `[ ] Hors-ligne uniquement` :**
   - Élément HTML placé dans la barre d'outils de recherche (`#search-bar-container`).
   - Écouteurs d'événements réseau passifs :
     ```javascript
     window.addEventListener('offline', () => setOfflineUIState(true));
     window.addEventListener('online', () => setOfflineUIState(false));
     ```
3. **Persistance du stockage :**
   - Appel automatique au démarrage :
     ```javascript
     if (navigator.storage && navigator.storage.persist) {
       navigator.storage.persist().then(granted => {
         console.log(`[Storage] Persistance disque accordée : ${granted}`);
       });
     }
     ```

---

## 8. Plan de Déploiement & Validation

1. **Étape 1 (Backend Rust) :** Implémenter `/api/documents/{id}/offline-bundle` et `/api/sync/check`, valider la vitesse de sérialisation JSON avec compression Gzip.
2. **Étape 2 (Compilation Wasm) :** Mettre en place le module Rust `search_wasm` et valider les tests unitaires Wasm avec `wasm-pack test`.
3. **Étape 3 (Service Worker & Storage) :** Déployer `sw.js`, initialiser la base locale et tester la reprise de téléchargement d'un fichier de 500 Mo en coupant artificiellement le serveur.
4. **Étape 4 (UI / UX) :** Intégrer les icônes de synchronisation et la case à cocher dans `app.js` et `style.css`.
