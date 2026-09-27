# Étude de Faisabilité & Plan d'Implémentation : Prise de Notes & Markdown dans DocSeeker

## 1. Objectifs
- Permettre d'importer, de créer et de rechercher dans des notes texte (`.txt`) et Markdown (`.md`).
- Conserver le même affichage que les documents PDF existants (vignettes de couverture, cartes dans l'explorateur, métadonnées, dossiers).
- Ajouter un éditeur Markdown moderne s'ouvrant dans un onglet dédié (multi-onglets de DocSeeker).
- Offrir une expérience utilisateur fluide et WYSIWYG en temps réel (« Instant Rendering »), similaire à **MarkText** (ou Typora).

---

## 2. Ingestion, Indexation & Vignettes

### A. Modèle de données & Stockage
- **Stockage physique** : Fichiers stockés dans `data/documents/` (ou sous-dossier) aux côtés des PDF.
- **Base de données** : Réutilisation de la table `documents` existante.
  - Ajout d'une colonne `doc_type TEXT DEFAULT 'pdf'` (valeurs : `'pdf'`, `'markdown'`, `'text'`).
  - Détection automatique lors du scan : extension `.md`, `.markdown`, `.txt`.
- **Extraction des titres** :
  - Pour le Markdown : extraction du premier titre `# Mon Titre` si présent, sinon repli sur le nom de fichier nettoyé.
  - Pour le texte brut : première ligne non vide ou nom de fichier.

### B. Indexation dans le moteur FTS5
- **Segmentation en « pages »** :
  - Le schéma SQLite unifié utilise la table `pages` liée à `pages_fts`.
  - **Option 1 (Simple & robuste)** : 1 note = Page 1 (`page_number = 1`). Le texte est inséré dans `pages` et indexé automatiquement par le trigger SQLite existant `pages_ai`.
  - **Option 2 (Par sections/chapitres)** : Découpage virtuel selon les titres (`# ` ou `## `) en pages `1, 2, 3...` pour permettre de sauter directement à la section correspondante lors d'une recherche.
- **Recherche & Scoring** :
  - 100% compatible avec l'algorithme Goodnotes existant (Score Titre 1500 + BM25 + densité).

### C. Vignettes (Thumbnails)
- Pour conserver la grille homogène de l'explorateur sans dépendre de PDF.js :
  - Génération côté serveur d'une miniature WebP dans `data/covers/{doc_id}.webp`.
  - Rendu d'une carte stylisée (fond papier légèrement texturé, badge `#MD`, typographie élégante affichant le titre et les 6 premières lignes du document).
  - Généré en quelques millisecondes via la crate Rust `image` ou `resvg`.

---

## 3. Comparatif des Librairies Markdown Open Source (Style MarkText)

MarkText utilise le moteur **Muya** (conçu par l'équipe de MarkText pour reproduire le WYSIWYG instantané de Typora). Voici l'état de l'art des bibliothèques open source pour le web :

| Bibliothèque | Architecture | Mode WYSIWYG / Typora-like | Fonctionnalités clés (Math, Tables, Code) | Poids & Maintenabilité |
| :--- | :--- | :--- | :--- | :--- |
| **1. Vditor** *(Recommandé)* | Vanilla JS / TS pur | **Oui (Mode IR - Instant Rendering)** identique à Typora/MarkText | Tableaux interactifs, KaTeX (formules maths), Prism (coloration syntaxique), diagrammes Mermaid, listes de tâches, export HTML/PDF/MD | ⭐ **Excellente** (5.5k★, très actif, 0 dépendance framework, bundle autonome) |
| **2. Milkdown** | ProseMirror + Remark | **Oui** (Plugin-based WYSIWYG) | Tout en plugins : tables, code blocks, math KaTeX, slash commands `/` | ⭐ **Très bonne** (8k★, très moderne, modulaire mais intégration plus verbeuse) |
| **3. TipTap (Markdown)** | ProseMirror | **Oui** (Éditeur riche sérialisé en Markdown) | Supporte tout, UX ultra-léchée, raccourcis clavier riches | ⚠️ Nécessite de concevoir soi-même la barre d'outils et les contrôles Markdown |
| **4. EasyMDE / SimpleMDE** | CodeMirror | **Non** (Éditeur syntaxique avec aperçu séparé / split-view) | Markdown classique, mode split-view | ❌ Moins moderne, éloigné de l'expérience fluide de MarkText |

### Pourquoi Vditor est la solution retenue :
1. **Mode Instant Rendering (`mode: 'ir'`)** : La syntaxe markdown (`**gras**`, `# titre`, etc.) se transforme visuellement dès qu'on change de mot ou de ligne, exactement comme MarkText.
2. **Vanilla JS** : Aucune dépendance React/Vue requise, intégration directe et légère dans `frontend/`.
3. **Batteries incluses** : KaTeX, Prism, tableaux redimensionnables, glisser-déposer d'images, support tactile et mobile.
4. **100% Hors-ligne** : Les scripts et styles peuvent être embarqués localement sans aucun appel à un CDN externe.

---

## 4. Intégration dans les Onglets & Synchronisation

### A. Gestionnaire d'Onglets (`tabManager`)
- Ajout d'un conteneur `#markdownEditorContainer` à côté de l'iframe `#pdfFrame`.
- Structure de l'onglet :
  ```javascript
  {
    id: "tab_note_123",
    docId: 123,
    docType: "markdown", // ou "pdf"
    title: "Notes de Sémiologie",
    isDirty: false,
    content: "# Titre..."
  }
  ```
- Lors de l'activation d'un onglet, affichage de l'éditeur Markdown ou de l'iframe PDF selon `docType`.

### B. Sauvegarde & Synchronisation
- **Auto-save** avec debounce (1.5s d'inactivité) ou raccourci `Cmd+S` / `Ctrl+S`.
- Endpoints API :
  - `GET /api/documents/:id/content` : Lecture du texte brut.
  - `PUT /api/documents/:id/content` : Sauvegarde, mise à jour des pages FTS5 et regénération de la vignette.
- **Bouton d'action rapide** : "+ Nouvelle note" dans la barre latérale ou le menu contextuel des dossiers.

---

## 5. Questions d'arbitrage à trancher
1. **Mode d'édition** : Souhaitez-vous un mode WYSIWYG instantané pur (Typora/MarkText) avec bascule optionnelle vers le code brut (`source code mode`) ?
2. **Découpage des pages pour la recherche** : 1 note = 1 page globale, ou découpage virtuel par chapitres (`# `) ?
3. **Gestion des images** : Stockage automatique des images collées / glissées dans un sous-dossier `data/documents/assets/` ?
4. **Style des vignettes** : Validation du style de carte texturée avec titre et extrait textuel.
