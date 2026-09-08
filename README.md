# DocSeeker 📑🔍

**DocSeeker** est une application web légère et rapide pour explorer et rechercher des mots-clés dans des documents PDF, avec une expérience utilisateur calquée sur **Goodnotes** (vignettes cropées/zoomées avec surlignage des mots trouvés) et un visualiseur en **Split View** synchronisé.

---

## ✨ Fonctionnalités Clés

1. **Recherche Visuelle "Goodnotes"** :
   - Présentation des résultats sous forme de rangées horizontales de vignettes.
   - Chaque vignette est un **extrait graphique zoomé** sur la phrase ou le paragraphe où le mot-clé apparaît.
   - **Surlignage en jaune** du mot-clé directement sur l'extrait.
   - Badge discret du numéro de page (`p. 1`, `p. 14`, etc.).

2. **Classement par Pertinence Multi-mots (Ranking BM25)** :
   - Si vous recherchez plusieurs termes (ex: `hémorragie délivrance`), les documents contenant **l'ensemble des termes** sont priorisés et placés en tête avec le badge `★ Le plus pertinent`.
   - Insensible à la casse et aux accents (`hémorragie` = `hemorragie`).
   - Recherche par préfixe automatique.

3. **Navigation Split-View & Streaming PDF** :
   - Au clic sur une vignette ou une couverture, l'interface bascule en vue scindée :
     - La liste de résultats se réduit à gauche (~38%) pour continuer à naviguer d'un extrait à l'autre sans perdre la recherche des yeux.
     - Le volet droit (~62%) ouvre la visionneuse **Mozilla PDF.js** directement à la page de l'occurrence.
   - **Faible bande passante** : Le serveur implémente le support des requêtes HTTP Range (`206 Partial Content`). Même sur un gros fichier de 200 Mo, seules les pages consultées sont transférées.

4. **Gestion de Bibliothèque** :
   - Zone de glisser-déposer (Drag & Drop) pour importer de nouveaux PDF.
   - Extraction et indexation en quelques millisecondes avec PyMuPDF.
   - Bouton de suppression en 1 clic pour purger le document, son index et son cache.

---

## 🚀 Démarrage Rapide

### Prérequis
- Python 3.10+ (testé avec Python 3.13)
- Navigateur web moderne (Chrome, Firefox, Safari, Edge)

### Lancer l'application
Exécutez simplement le script de démarrage :
```bash
./run.sh
```

L'application sera accessible immédiatement sur :
👉 **http://localhost:8000**

---

## 🛠️ Architecture Technique

- **Backend** : FastAPI (Python)
- **Moteur PDF & Rendu visuel** : PyMuPDF (`fitz`) pour l'extraction de texte, le calcul des bounding boxes et le découpage instantané des vignettes.
- **Indexation & Recherche** : SQLite FTS5 (`unicode61 remove_diacritics 2`) avec BM25.
- **Frontend** : HTML5 / CSS moderne (Vanilla) / JavaScript réactif.
- **Lecteur PDF** : Mozilla PDF.js officiel intégré en mode streaming Byte-Range.
