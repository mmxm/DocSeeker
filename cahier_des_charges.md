# CAHIER DES CHARGES TECHNIQUE & FONCTIONNEL
## Projet : DocSeeker (Moteur de recherche documentaire & visualiseur visuel PDF)

---

## 1. Synthèse et Vision du Projet

L'objectif de **DocSeeker** est de concevoir une application web légère, ultra-rapide et ergonomique permettant de rechercher des mots-clés dans un fonds documentaire volumineux de documents PDF, avec une expérience utilisateur calquée sur l'exploration visuelle de **Goodnotes** :
- **Expérience visuelle "Goodnotes"** : Au lieu d'une simple liste de lignes de texte brut (snippets textuels classiques), chaque occurrence est présentée sous la forme d'une **vignette graphique cropée et zoomée** exactement sur le mot-clé recherché et son paragraphe contextuel, avec le mot **surligné en couleur** et le **numéro de page**.
- **Classement intelligent par pertinence** : Les documents les plus pertinents (contenant l'ensemble des termes recherchés, forte densité et proximité des mots-clés) remontent automatiquement en tête de liste.
- **Exhaustivité organisée par document** : Pour chaque document pertinent, **toutes les occurrences** sont accessibles sous forme de ruban horizontal défilant de vignettes.
- **Navigation en Split View adaptatif** : Au clic sur une vignette, l'écran bascule en vue scindée : la liste de résultats se réduit élégamment à gauche, et le document s'ouvre à droite à la page exacte.
- **Performance & Économie de bande passante** : Zéro téléchargement de PDF lourd côté client pour la recherche. La visionneuse latérale utilise le streaming à la demande (HTTP Range Requests / PDF.js) pour ne charger que les pages visualisées.
- **Gestion simplifiée** : Téléversement (upload) par glisser-déposer et suppression en un clic.

---

## 2. Architecture Globale

```
+-----------------------------------------------------------------------------------------+
|                                    NAVIGATEUR CLIENT                                    |
|                                                                                         |
|  [ Barre de recherche : "hémorragie délivrance" ] ────────────── [ + Importer un PDF ]  |
|                                                                                         |
|  +---------------------------------------------+ +------------------------------------+ |
|  | LISTE RÉSULTATS (Réduite en Split View)     | | LECTEUR PDF LATÉRAL (PDF.js)       | |
|  |                                             | |                                    | |
|  | ★ DOC 1 : Gynécologie Obstétrique (Top 1)  | | Page 5 / 420                       | |
|  | [Cover] [Crop p.5] [Crop p.12] [Crop p.64]..| |                                    | |
|  |                                             | | [................................] | |
|  | DOC 2 : Grossesse extra-utérine             | | [... Hémorragie de la délivrance.] | |
|  | [Cover] [Crop p.2] [Crop p.4] ...           | | [................................] | |
|  |                                             | | (Seule la page 5 est streamée)     | |
|  +---------------------------------------------+ +------------------------------------+ |
+-----------------------------------------------------------------------------------------+
                                      ▲
                                      │ API REST JSON & Images WebP
                                      ▼
+-----------------------------------------------------------------------------------------+
|                                  SERVEUR BACKEND                                        |
|                                                                                         |
|  [FastAPI / Python]                                                                     |
|   ├── Ingestion & Indexation (PyMuPDF / Fitz) - Documents natifs texte                  |
|   │     └── Extraction texte + Coordonnées spatiales (x0, y0, x1, y1) par mot & page    |
|   ├── Moteur de recherche & Ranking (SQLite FTS5 avec BM25 + Stemming + Accents)        |
|   │     └── Classement pertinence multi-mots clés                                       |
|   ├── Micro-service de Crop visuel (PyMuPDF / Pillow)                                   |
|   │     └── Découpe du rectangle contextuel + surlignage couleur + export WebP léger    |
|   └── Serveur de fichiers avec support HTTP 206 Partial Content (Byte-Range)            |
|                                                                                         |
|  [Stockage Fichiers & Données]                                                          |
|   ├── /data/documents/ (PDF originaux)                                                  |
|   ├── /data/db.sqlite (Index FTS5 + métadonnées + coordonnées des mots)                 |
|   └── /data/cache_crops/ (Cache disque des vignettes générées)                          |
+-----------------------------------------------------------------------------------------+
```

---

## 3. Spécifications Fonctionnelles Détaillées

### 3.1. Périmètre documentaire (Phase 1)
- **Format cible** : PDF avec texte natif numérique (cours, polycopiés, thèses, manuels, articles scientifiques, exports bureautiques).
- **Pas de passe OCR lourde au démarrage** : permet une ingestion quasi instantanée (plusieurs centaines de pages indexées par seconde avec PyMuPDF).
- *Évolution ultérieure possible* : module OCR (Tesseract / EasyOCR) activable en tâche de fond pour les scans purs.

### 3.2. Moteur de Recherche & Algorithme de Ranking
1. **Normalisation linguistique** :
   - Insensibilité stricte à la casse et aux accents (rechercher `hemorragie` trouve `Hémorragie` et `hémorragies`).
   - Recherche par préfixe/racine automatique (`mot*`).
2. **Recherche Multi-termes & Ranking par Pertinence** :
   - Quand l'utilisateur saisit plusieurs mots-clés (ex: `hémorragie délivrance`) :
     - Les documents contenant **tous les termes** sont prioritaires.
     - Application du score **BM25** (fréquence du terme inversée, densité, proximité des termes dans la même page ou paragraphe).
     - Le document ayant le score global le plus élevé est positionné tout en haut des résultats avec un indicateur visuel de pertinence.
3. **Indexation spatiale (Bounding Boxes)** :
   - Lors de l'ingestion d'un document, la position géométrique de chaque mot `(page, x0, y0, x1, y1)` est stockée.
   - Cette étape est la clé qui permet de générer instantanément les vignettes cropées sans avoir à re-analyser tout le document.

### 3.3. Affichage des Résultats (Ergonomie Goodnotes)
1. **Structure en cartes horizontales** :
   - **Encart document** (à gauche) :
     - Miniature de la première page (couverture).
     - Titre du document (nom du fichier ou métadonnée titre).
     - Compteur d'occurrences trouvées (ex: `12 résultats`).
     - Badge de pertinence pour le document en tête.
   - **Ruban de vignettes contextuelles** (à droite) :
     - Défilement horizontal fluide de l'ensemble des occurrences trouvées.
     - **Vignette zoomée / cropée** : Rectangle centré sur l'occurrence incluant 2 à 3 lignes de contexte au-dessus et en-dessous.
     - **Surlignage** : Mot-clé surligné visuellement en jaune/orange translucide.
     - **Numéro de page** : Badge incrusté en bas à gauche de la vignette (ex: `p. 5`).

### 3.4. Navigation Split-View & Visualiseur PDF Streamé
1. **Comportement Split-View** :
   - **État initial** : La liste de recherche occupe toute la largeur de l'écran.
   - **Au clic sur une vignette** :
     - L'écran se scinde dynamiquement : la liste des résultats se réduit sur une colonne compacte à gauche (~35% à 40% de la largeur).
     - Le panneau latéral droit (~60% à 65%) s'ouvre pour afficher la visionneuse PDF.
     - Un bouton permet à tout moment de refermer la vue latérale pour retrouver la liste plein écran.
2. **Synchronisation directe** :
   - Le visualiseur s'ouvre immédiatement **à la page exacte** de la vignette cliquée.
   - L'occurrence est mise en évidence dans le visualiseur.
   - L'utilisateur peut continuer à cliquer sur les autres vignettes du ruban à gauche pour sauter d'une page à l'autre sans recharger l'interface.
3. **Faible bande passante & Streaming (Byte-Range)** :
   - Intégration de Mozilla PDF.js couplé au serveur FastAPI supportant l'en-tête `Range: bytes=X-Y`.
   - Même sur un fichier de plusieurs centaines de mégaoctets, le navigateur ne télécharge que les quelques kilo-octets nécessaires à l'affichage de la page demandée.

### 3.5. Gestion de la Bibliothèque
1. **Import (Upload)** :
   - Zone de glisser-déposer sur la page principale.
   - Ingestion en tâche de fond avec indicateur d'avancement (progression de l'indexation).
2. **Suppression** :
   - Bouton de suppression avec confirmation pour chaque document.
   - Nettoyage automatique : suppression du fichier physique, des entrées d'index en base et du cache d'images associé.

---

## 4. Choix Techniques & Justification

| Rôle | Technologie | Justification |
| :--- | :--- | :--- |
| **Backend & API** | **FastAPI (Python)** | Asynchrone, performant, gère nativement le streaming HTTP 206 (Range requests) et les tâches d'arrière-plan. |
| **Moteur PDF & Rendu** | **PyMuPDF (`fitz`)** | Bibliothèque C ultra-optimisée. Capable d'extraire le texte + coordonnées et de générer un crop d'image en 5 à 15 ms. |
| **Moteur de Recherche** | **SQLite FTS5** | Intégré, sans dépendance ni conteneur lourd, supporte la tokenisation Unicode (accents), les préfixes et l'algorithme de classement BM25. |
| **Frontend UI** | **HTML5 / CSS moderne / JavaScript Vanilla** | Interface réactive, ultra-légère, zéro dépendance complexe (pas de framework lourd superflu), transitions CSS fluides. |
| **Lecteur PDF** | **Mozilla PDF.js** | Le standard mondial pour l'affichage PDF web avec support natif du chargement partiel par pages (*chunking*). |

---

## 5. Performance & Économie de Ressources

- **Poids moyen d'une vignette WebP** : ~25 à 40 Ko.
- **Temps de réponse d'une recherche** : < 50 ms pour 50 000 pages indexées.
- **Cache disque** : Chaque vignette générée pour une occurrence est stockée sous une clé unique. Deux recherches identiques ne re-génèrent aucune image.
- **Bande passante client** : Moins de 1 Mo transféré pour afficher les résultats d'une recherche, et seulement quelques centaines de Ko lors de l'ouverture d'une page spécifique d'un gros document.

---

## 6. Plan d'Implémentation & Jalons

1. **Jalon 1 : Moteur Backend, Stockage & Indexation FTS5**
   - Modèle SQLite FTS5 (documents, pages, coordonnées des mots).
   - Ingestion PyMuPDF (extraction rapide du texte et des rectangles).
   - Endpoint de recherche avec score BM25 et classement par document.
2. **Jalon 2 : Service de Crop Visuel & Cache**
   - Découpe dynamique de la zone contextuelle du mot-clé avec marge.
   - Incrustation du surlignage jaune semi-transparent.
   - Mise en cache disque au format WebP/JPEG.
3. **Jalon 3 : Interface Utilisateur "Goodnotes" & Recherche**
   - Barre de recherche instantanée.
   - Affichage des cartes documents avec ruban horizontal de vignettes (numéro de page, image cropée).
4. **Jalon 4 : Split View & Intégration PDF.js Streamé**
   - Mise en place du layout Split-View rétractable.
   - Configuration de PDF.js avec support Range Requests (HTTP 206).
   - Saut automatique à la page de l'occurrence.
5. **Jalon 5 : Upload & Suppression**
   - Interface d'upload glisser-déposer.
   - Suppression et purge du cache.
