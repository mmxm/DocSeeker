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

## 3. Moteur de Recherche Partagé : Rust-Wasm & SQLite-Wasm (FTS5)

Pour concilier **vitesse extrême**, **gestion de grands volumes (70+ PDF / 18 000 pages)** et **parité algorithmique absolue**, le moteur local s'articule en deux piliers dans un Dedicated Web Worker (`offline-search-worker.js`) :

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 OFFLINE SEARCH WORKER (offline-search-worker.js)            │
│                                                                             │
│  1. Couche Base de Données : SQLite-Wasm (avec extension FTS5 active)       │
│     - Stockage : Origin Private File System (OPFS) / Fallback IDB VFS       │
│     - Schéma & Index : Strictement identiques à backend-rust/src/db/schema.rs│
│     - Exécute la requête SQL FTS5 et calcule bm25(pages_fts)                │
│                                                                             │
│  2. Couche Algorithmique : Module Rust partagé compilé en Wasm (search-wasm)│
│     - Code source partagé : backend-rust/src/search/engine.rs               │
│     - Fonctions exportées : find_occurrences_on_page(), sanitize_fts_query()│
│     - Regroupement spatial des mots contigus et bounding boxes de contexte │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1. Compilation du Module Rust Partagé (`search-wasm`)
Un crate dédié `backend-rust/search-wasm` référence directement les structures et fonctions de `backend-rust/src/search/` :

```bash
# Dans backend-rust/search-wasm/ :
wasm-pack build --target web --out-dir ../../frontend/wasm/search_wasm --release
```

- **Fonctions exportées par le binaire Wasm :**
  - `find_occurrences_wasm(words_json: &str, query_terms_json: &str, query_hash: &str, doc_id: i64, page_number: i64, bm25_score: f64) -> String` : Exécute l'algorithme exact de regroupement d'occurrences et de découpage spatial du backend.
  - `sanitize_query_wasm(query: &str) -> String` : Tokenise la requête utilisateur avec les mêmes règles Unicode que le serveur.
  - `get_query_hash_wasm(terms_json: &str) -> String` : Calcule le hash unique SHA256 pour identifier les occurrences et leurs vignettes de façon cohérente.

### 3.2. Schéma et Exécution SQL dans SQLite-Wasm
- La base SQLite locale (`/docseeker_local.sqlite`) est pilotée par le SDK officiel SQLite-Wasm avec FTS5 compilé.
- Schéma 100% clone de [`backend-rust/src/db/schema.rs`](file:///Users/francois/Documents/DocFastExplorer/backend-rust/src/db/schema.rs) :
  - `folders(id, name, parent_id, color)`
  - `documents(id, filename, title, file_hash, folder_id, total_pages, file_size, updated_at)`
  - `pages(id, doc_id, page_number, text_content, words_json)`
  - `pages_fts USING fts5(text_content, content='pages', content_rowid='id', tokenize='unicode61 remove_diacritics 2')`
- La requête de recherche exécutée dans le worker réutilise les mêmes CTE et formules de pertinence que [`backend-rust/src/search/engine.rs`](file:///Users/francois/Documents/DocFastExplorer/backend-rust/src/search/engine.rs).

---

## 4. Génération Locale des Vignettes (Crops) via PDF.js

En ligne, le serveur génère les crops via Pdfium avec un sémaphore tokio limité à 2 tâches ([`backend-rust/src/routes/media.rs:L159`](file:///Users/francois/Documents/DocFastExplorer/backend-rust/src/routes/media.rs#L159)).
Hors-ligne, le Service Worker intercepte `/api/crop/{doc_id}/{page}/{occ_id}` et délègue au **Crop Worker** (`crop-worker.js`) avec le même niveau de rigueur :

### 4.1. Concurrence Contrôlée & Cache Immédiat
1. **File d'attente (Sémaphore client)** : Limite stricte à **2 rendus simultanés** pour éviter toute surconsommation de mémoire (OOM) sur Safari iOS.
2. **Mise en cache `CacheStorage` (`docseeker_offline_crops`)** : Chaque crop généré sous forme de Blob WebP est immédiatement stocké dans le cache HTTP local. Si l'utilisateur réaffiche l'occurrence ou scrolle, la vignette est servie à 0 ms sans réexécuter PDF.js.

### 4.2. Algorithme du Crop Worker local (`crop-worker.js`) :
```javascript
// Découpage dynamique de la zone de l'occurrence avec OffscreenCanvas
async function renderOfflineCrop(docId, pageNumber, highlightRects, contextRect) {
  // 1. Ouvrir le document depuis le cache IndexedDB (alimenté par pdf.mjs)
  const pdfDoc = await pdfjsLib.getDocument({ url: `/api/pdf/${docId}` }).promise;
  const page = await pdfDoc.getPage(pageNumber);

  // 2. Coordonnées de la fenêtre Goodnotes (300 x 120 pt)
  const [rx0, ry0, rx1, ry1] = contextRect;
  const cropWidth = rx1 - rx0;
  const cropHeight = ry1 - ry0;

  // 3. Rendu haute résolution (scale 2.0) sur OffscreenCanvas
  const canvas = new OffscreenCanvas(cropWidth * 2, cropHeight * 2);
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  const viewport = page.getViewport({ scale: 2.0 });
  await page.render({
    canvasContext: ctx,
    viewport: viewport,
    transform: [1, 0, 0, 1, -rx0, -ry0]
  }).promise;

  // 4. Surbrillance jaune Goodnotes translucide (alpha 0.45)
  ctx.fillStyle = "rgba(255, 226, 0, 0.45)";
  for (const [hx0, hy0, hx1, hy1] of highlightRects) {
    ctx.fillRect(hx0 - rx0, hy0 - ry0, hx1 - hx0, hy1 - hy0);
  }

  // 5. Encodage WebP et libération des ressources de page
  page.cleanup();
  return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
}
```

---

## 5. Gestionnaire de Téléchargement & Délégation Stricte à `pdf.mjs`

Pour respecter le principe d'unicité du moteur de transfert et éliminer tout risque de divergence dans IndexedDB :

### 5.1. Téléchargement Sans Duplication de Code
Le `DownloadQueueManager` ne réécrit **aucun** gestionnaire manuel de fragments :
1. **Étape 1 : Index & Couverture**
   - Télécharge `GET /api/documents/{id}/offline-bundle` et injecte le document et ses pages dans SQLite-Wasm.
   - Met en cache `GET /api/cover/{id}` dans le `CacheStorage`.
2. **Étape 2 : Binaire PDF via instance headless de `pdf.mjs`**
   - Instancie en tâche de fond le chargement PDF.js :
     ```javascript
     const task = pdfjsLib.getDocument({
       url: `/api/pdf/${docId}`,
       disableAutoFetch: false,
       disableStream: false
     });
     const pdfDoc = await task.promise;
     await pdfDoc.getData(); // Déclenche le streaming séquentiel complet de blocs de 256 Ko
     ```
   - C'est le code natif de `pdf.mjs` (déjà optimisé dans `main`) qui effectue les Range Requests et écrit dans le store `chunks` d'IndexedDB (`docseeker_pdf_chunks_v2`).
   - [`frontend/pdf-cache.js`](file:///Users/francois/Documents/DocFastExplorer/frontend/pdf-cache.js) capte automatiquement la progression réelle et notifie l'UI.

### 5.2. Résolution Récursive & Résilience
- Le clic sur un dossier résout récursivement tous les identifiants de documents (`GET /api/folders` ou table locale `folders`).
- File d'attente à 2 téléchargements simultanés maximum avec pause, reprise et reprise automatique après reconnexion.

---

## 6. Routage Transparent dans le Service Worker (`sw.js`)

Le Service Worker sert de passe-plat intelligent et intercepte toutes les requêtes de l'application :

```javascript
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. App Shell (HTML, CSS, JS, Wasm, polices, PDF.js) -> Cache First
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
    // Mode connecté standard avec bascule transparente sur incident
    event.respondWith(
      fetch(event.request).catch(() => handleLocalSearch(url.searchParams))
    );
    return;
  }

  // 3. Requête de Vignette (/api/crop)
  if (url.pathname.startsWith('/api/crop/')) {
    event.respondWith(
      caches.open('docseeker_offline_crops').then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        return fetch(event.request).catch(async () => {
          const blob = await handleLocalCrop(url.pathname, url.searchParams);
          const response = new Response(blob, { headers: { 'Content-Type': 'image/webp' } });
          cache.put(event.request, response.clone());
          return response;
        });
      })
    );
    return;
  }

  // 4. Requête du Binaire PDF (/api/pdf)
  if (url.pathname.startsWith('/api/pdf/')) {
    // PDF.js lit nativement ses fragments dans docseeker_pdf_chunks_v2
    return;
  }
});
```

---

## 7. Sécurité, Sessions & Compatibilité Synology DSM

### 7.1. En-têtes HTTP de Sécurité pour Wasm / OPFS
Dans [`backend-rust/src/main.rs`](file:///Users/francois/Documents/DocFastExplorer/backend-rust/src/main.rs), le middleware de sécurité ajoute :
- `Cross-Origin-Opener-Policy: same-origin` (COOP)
- `Cross-Origin-Embedder-Policy: require-corp` (COEP)
- Ces headers autorisent `SharedArrayBuffer` et les accès OPFS ultra-rapides (`SyncAccessHandle`).
- **Tolérance DSM :** Si le reverse-proxy DSM filtre ces en-têtes ou en l'absence de `SharedArrayBuffer`, le worker SQLite bascule automatiquement sur le VFS IndexedDB (`wa-sqlite` / `idb-vfs`) sans interrompre le fonctionnement.

### 7.2. Authentification par Token Local à Expiration
- L'état de session est mémorisé localement avec un horodatage d'expiration dans un stockage persistant sécurisé (`localStorage` ou IDB).
- En mode hors-ligne, si le token n'a pas expiré, l'accès aux documents locaux et à la recherche est accordé immédiatement sans modale de blocage.

### 7.3. Persistance du Stockage Navigateur
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

1. **Étape 1 (Backend Rust) :** Implémenter `/api/documents/{id}/offline-bundle` et `/api/sync/check`, ajouter les headers COOP/COEP dans `main.rs`.
2. **Étape 2 (Module Rust-Wasm) :** Créer la sous-crate `search-wasm`, exporter les fonctions spatiales et compiler avec `wasm-pack`.
3. **Étape 3 (Service Worker & Stockage) :** Déployer `sw.js`, `offline-search-worker.js` et `crop-worker.js`.
4. **Étape 4 (DownloadQueueManager & UI) :** Brancher le flux headless `pdf.mjs`, ajouter le tiroir de téléchargement, le bouton de cache et la case `[✓] Hors-ligne uniquement` dans `app.js`.
5. **Étape 5 (Recette) :** Validation fonctionnelle complète AC-01 à AC-07 en simulant des coupures réseau et en testant sous mobile.

