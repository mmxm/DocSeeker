# Diagnostic Technique : Comportements et Limitations iOS WebKit (PWA Safari & Firefox iOS)

Ce document consigne les anomalies structurelles, les preuves expérimentales recueillies dans WebKit et les solutions architecturales pour la version mobile iOS de DocSeeker.

---

## 1. Contexte Moteur : Pourquoi Firefox iOS et Safari partagent les mêmes bugs

Sur iOS et iPadOS, les règles de l'App Store d'Apple imposent à **tous les navigateurs** (Safari, Firefox pour iOS, Google Chrome, Edge) d'utiliser le moteur système **WebKit (`WKWebView`)**. 
Bien que l'enveloppe UI soit Firefox, le moteur d'exécution JavaScript (JavaScriptCore), le compositeur graphique et la pile réseau sont ceux d'Apple WebKit.

---

## 2. Anomalie 1 : Blocage des URLs `blob:` en mode hors-ligne

### Symptôme
En mode hors-ligne (mode avion ou réseau coupé), les vignettes dynamiques ne s'affichent pas, restent blanches ou basculent en snippets texte jaunes avec l'icône de rupture d'image `[?]`.

### Preuve expérimentale (mesurée sous Playwright WebKit)
```javascript
// En ligne
img.src = URL.createObjectURL(blob);
// Résultat : { success: true, width: 100 }

// Hors-ligne (context.setOffline(true))
img.src = URL.createObjectURL(blob);
// Résultat : { success: false, error: "img.onerror" }
// fetch(blobUrl) -> TypeError: Load failed / WebKit encountered an internal error
// FileReader.readAsDataURL(blob) -> Error: "The I/O read operation failed."
```

### Cause racine
Dans WebKit, la résolution d'une URL de schéma `blob:` passe par le **NetworkProcess** (processus réseau d'Apple). Lorsque le terminal est hors-ligne, le processus réseau refuse de résoudre l'URI du blob et lève une erreur réseau interne. À l'inverse, Chromium et Gecko (Firefox Desktop/Android) gèrent les Blobs directement en mémoire dans le processus de rendu.

### Solution recommandée
1. Remplacer l'échange de `Blob` par le transfert direct d'**`ImageBitmap`** via `transferToImageBitmap()` du Web Worker vers le thread UI.
2. Peindre l'image directement dans un `<canvas>` ou générer une **Data URL** locale (`canvas.toDataURL('image/png')`), qui est décodée en mémoire sans jamais solliciter le NetworkProcess de WebKit.

---

## 3. Anomalie 2 : Gel de 8 secondes d'OPFS dans SQLite-Wasm & Timeout 10s

### Symptôme
Message rouge : `Erreur lors de la recherche (Timeout (10000ms) en attente du worker pour SEARCH)`.

### Preuve expérimentale (Logs WebKit)
```text
[Console] [OfflineSearchWorker] Initialisation du runtime SQLite-Wasm et Rust-Wasm...
[Console] Ignoring inability to install 'opfs' sqlite3_vfs: Error: Timeout while waiting for OPFS async proxy worker.
[Console] Ignoring inability to install the opfs-wl sqlite3_vfs: Error: Timeout while waiting for OPFS async proxy worker.
[Console] [OfflineSearchWorker] OpfsDb non disponible, fallback VFS standard
```

### Cause racine
SQLite-Wasm tente d'instancier un sous-worker mandataire (`sqlite3-opfs-async-proxy.js`) pour contourner les verrous exclusifs d'Apple sur l'OPFS. Sur WebKit, cette instanciation suspend l'exécution pendant **4 000 ms** sur le VFS `opfs` puis **4 000 ms** sur `opfs-wl` (soit **8,0 secondes perdues**).
Le budget de 10 secondes de `downloadQueueManager` est presque épuisé avant même que la requête FTS5 ne commence. De plus, le repli sur le "VFS standard" bascule sur une base SQLite **en mémoire vive volatile** qui est effacée à la fermeture de l'onglet.

### Solution recommandée
1. Désactiver explicitement la tentative proxy OPFS sur Safari/WebKit via la configuration SQLite :
   `sqlite3.config.disable.vfs['opfs'] = true;` ou configurer un stockage persistant via IndexedDB/KV store adapté.
2. Augmenter le timeout de garde à 30 secondes pour les recherches massives.
3. Ne pas charger `words_json` lors de la recherche multi-documents générale (pagination et extraction différée).

---

## 4. Anomalie 3 : Débordement mémoire sur gros PDFs & Icône `[?]` dans le Drawer

### Symptôme
Sur de très gros volumes (ex: *Fiches Martingales*, 1737 pages, 619 occurrences de "cardiaque"), certaines vignettes s'affichent correctement tandis que d'autres affichent le carré bleu `[?]`.

### Cause racine
1. **Épuisement de textures GPU sur écran Retina 3x** : Sur iPhone 15/16 Pro, le `devicePixelRatio` est de `3.0`. PDF.js et les canvas de découpe allouent des textures 3 fois plus denses (jusqu'à 3000x4000 pixels par page). Sur un document de 1737 pages, l'accumulation de ces textures dans le DOM du tiroir (619 cartes créées d'un coup) sature le quota mémoire alloué par iOS à la `WKWebView` (environ 1.5 Go).
2. iOS détruit silencieusement les contextes graphiques les plus anciens pour éviter le crash de l'application, transformant les vignettes évincées en icônes `[?]`.

### Solution recommandée
1. **Virtualisation de la liste du tiroir vertical** : Au lieu de générer 619 éléments DOM simultanés, ne rendre que les ~10 cartes visibles à l'écran (`virtual scroll` ou pagination par tranches de 20).
2. **Plafonner l'échelle de rastérisation** : Brider `CROP_RENDER_SCALE` à `1.5` ou `2.0` max sur mobile (au lieu de suivre aveuglément le DPR de 3.0).

---

## 5. Optimisation de la fluidité de défilement du PDF (vs Aperçu iOS)

### Différence d'architecture
- **Aperçu iOS (Apple PDFKit)** : Moteur natif C++/Metal compilé directement sur GPU, découpant le document en tuiles vectorielles asynchrones avec décodage prédictif matériel.
- **PDF.js dans l'iframe** : Moteur JavaScript interprété qui rastérise chaque page dans un `<canvas>` HTML5 avec surcouche de texte DOM (`textLayer`).

### Leviers d'optimisation pour PDF.js sur mobile :
1. **Limiter la résolution des toiles (`maxCanvasPixels`)** :
   Dans les options de PDF.js (`AppOptions`), brider la résolution maximale des pages sur mobile pour diviser par 4 l'empreinte mémoire et soulager le compositeur d'iOS.
2. **Désactiver les formulaires interactifs** :
   `renderInteractiveForms: false` supprime l'analyse d'annotations lourdes au scroll.
3. **Accélération matérielle CSS** :
   Appliquer `transform: translateZ(0);` et `-webkit-overflow-scrolling: touch;` sur le conteneur du visualiseur.
4. **Rendu différé du TextLayer** :
   Ne générer la couche de sélection textuelle qu'une fois le scroll arrêté (idle), et non pendant le geste tactile de défilement rapide.
