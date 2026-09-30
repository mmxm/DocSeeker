# DocSeeker 📑🔍

**DocSeeker** est une application web haute performance pour explorer, indexer et rechercher dans vos bibliothèques de documents PDF et notes Markdown.

---

## ✨ Points forts

- **Recherche visuelle Goodnotes-style** : extraits graphiques découpés à la volée avec surlignage des termes trouvés.
- **Classement BM25 multi-mots** : scoring temps réel, recherche par préfixe et tolérance diacritique (`unicode61`).
- **Notes Markdown structurées** :
  - Éditeur visuel moderne (Crepe / Milkdown) avec volet Markdown brut synchronisé.
  - Organisation disque par dossier : chaque note possède son dossier `nom/` contenant `nom.md` et son sous-dossier `assets/`.
  - Nettoyage automatique des images orphelines lors des modifications.
  - Corbeille avec rétention 30 jours et restauration complète (note + assets).
- **Téléchargement ZIP complet** : export en 1 clic de la note sous forme d'archive `.zip` incluant l'ensemble de ses assets et images.
- **Mode hors-ligne (PWA)** : recherche locale plein texte via SQLite-Wasm, mise en cache OPFS et synchronisation différentielle.
- **Lecteur PDF Split-View** : intégration Mozilla PDF.js avec streaming Byte-Range (HTTP 206) et annotations.

---

## 🚀 Démarrage

### Prérequis
- [Rust](https://www.rust-lang.org/) (Cargo)
- Navigateur moderne (Chrome, Firefox, Safari, Edge)

### Lancement local
```bash
./run.sh
```
L'application démarre sur : **http://localhost:8080**

---

## 🛠️ Architecture

- **Backend** : Rust (Axum, Rusqlite, Pdfium, Zip).
- **Base de données** : SQLite avec FTS5 (`remove_diacritics 2`).
- **Frontend** : Vanilla JS, CSS réactif, Milkdown Crepe, Mozilla PDF.js.
- **Offline / Mobile** : Service Worker PWA, IndexedDB / OPFS, SQLite-Wasm.
