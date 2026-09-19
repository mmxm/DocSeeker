# Cahier des Charges : Application Native iOS & iPadOS (DocSeeker)

Ce document formalise l'intégralité des spécifications fonctionnelles, techniques, ergonomiques et de test pour le développement du client natif universel (iPhone & iPad) de DocSeeker.

---

## 1. Vision et Objectifs du Produit

1. **Parité fonctionnelle absolue** : Reproduction stricte de 100% des fonctionnalités de l'application Web DocSeeker (recherche textuelle et spatiale, scoring Goodnotes, surlignage jaune translucide, rubans horizontaux et tiroirs d'occurrences, sélection multiple).
2. **Fluidité équivalente à Aperçu iOS** : Exploitation directe du moteur vectoriel natif d'Apple (`PDFKit`) compilé sur GPU Metal (120 Hz ProMotion, tiling asynchrone matériel, zoom vectoriel sans latence ni flou).
3. **Architecture hybride rigoureuse (En ligne vs Hors-ligne)** :
   - **En ligne** : Tout est délégué au serveur NAS/Rust distant (recherche et crops WebP calculés côté serveur pour préserver la batterie et le CPU du smartphone).
   - **Hors-ligne** : Tout est exécuté localement sur l'appareil (recherche SQLite FTS5 via le moteur Rust local et découpe locale des vignettes via CoreGraphics).
4. **Construction locale stricte de l'index** : La base de données SQLite locale n'est **jamais** téléchargée pré-compilée du serveur. Elle est construite, structurée et indexée localement sur l'iPhone/iPad par le cœur Rust embarqué à partir des données brutes de synchronisation.
5. **Gestion de cache identique au Web & Stockage illimité** :
   - Téléchargement individuel par document ou en masse par dossier.
   - Téléchargement dynamique déclenché à l'ouverture d'un PDF avec pause/reprise sur interruption (`resumeData`).
   - Stockage illimité (pas d'éviction automatique arbitraire, contrôle manuel de libération d'espace).
6. **Installation par câble via Xcode** : Déploiement direct sans frais sur les appareils de test sans nécessiter de compte Apple Developer payant.
7. **Transposition intégrale des tests d'assurance qualité** : Écriture d'une suite de tests UI et unitaires native (XCTest / XCUITest) transposant 1:1 les matrices de tests automatisées existantes (Playwright M1 à M6, tests de stress et cas limites).

---

## 2. Architecture Technique et Stack Logicielle

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           Interface SwiftUI                             │
│       (iPhone: Sheets & Detents / iPad: NavigationSplitView 3 colonnes) │
├────────────────────────────────────┬────────────────────────────────────┤
│       Lecteur PDF & Découpe        │       Réseau & Surveillance        │
│     Apple PDFKit / CoreGraphics    │      URLSession (Background Tasks) │
│       (Accélération Metal GPU)     │      NWPathMonitor (Network.fwk)   │
├────────────────────────────────────┴────────────────────────────────────┤
│                       Gestionnaire de Téléchargement                     │
│    (File d'attente native, limitation concurrence à 2, pause/reprise)   │
├─────────────────────────────────────────────────────────────────────────┤
│                          Pont Swift ↔ Rust                              │
│                 (DocSeekerCore.xcframework / UniFFI)                    │
├─────────────────────────────────────────────────────────────────────────┤
│                      Cœur Algorithmique Rust                            │
│     (crates/search-core: BM25, Tokenisation, Crop Bounds, Schémas)      │
├─────────────────────────────────────────────────────────────────────────┤
│                           Stockage Local                                │
│   - Base SQLite FTS5 construite localement (docseeker_local.sqlite)     │
│   - Système de fichiers iOS sécurisé (Documents/pdfs/<id>.pdf)          │
│   - Trousseau iOS sécurisé (Keychain: session & mot de passe admin)     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1. Composants logiciels
- **Langages** : Swift 5.10+ / SwiftUI et Rust 1.78+.
- **Plateformes cibles** : iOS 17.0+ et iPadOS 17.0+ (Universal Binary).
- **Moteur PDF** : Apple `PDFKit` (`PDFView`) assisté de `CoreGraphics` pour la découpe d'extraits locaux.
- **Moteur de recherche local** : Crate Rust `crates/search-core` compilé en framework natif iOS (`DocSeekerCore.xcframework`).
- **Base de données locale** : SQLite 3 natif d'iOS avec support FTS5 intégré.
- **Réseau** : `URLSessionDownloadTask` avec gestion des `resumeData` pour les coupures réseau.
- **Détection de connectivité** : `NWPathMonitor` (`Network.framework`).
- **Sécurité & Authentification** : `Security.framework` (Keychain Services).

---

## 3. Spécifications Fonctionnelles Détaillées

### 3.1. Authentification et Connexion au Serveur NAS
- L'application se connecte au même backend Rust existant (ex: `http://mon-nas:8080` ou `https://docseeker.mondomaine.fr`).
- **Écran de connexion natif** : Saisie de l'URL du serveur et du mot de passe administrateur (`ADMIN_PASSWORD`).
- **Appel d'authentification** : `POST /api/auth/login`.
- **Persistance sécurisée** : Stockage du cookie de session / token dans le **Keychain iOS** (`kSecClassGenericPassword`). Zéro déconnexion intempestive.

---

### 3.2. Comportement Hybride : En Ligne vs Hors-Ligne Strict

#### A. Mode En Ligne (`NWPathMonitor.currentPath.status == .satisfied`)
- **Recherche** : Envoyée au serveur :  
  `GET /api/search?q={query}&folder_id={id}&titles_only={bool}&limit=15&offset={offset}`.
- **Vignettes** : Récupérées sous forme d'images WebP générées à distance par le NAS :  
  `GET /api/crop/{doc_id}/{page}/{idx}?h={hash}&terms={terms}`.
- **Zéro calcul local** : Batterie et processeur du téléphone totalement préservés.

#### B. Mode Hors-Ligne (`status != .satisfied` ou filtre "Hors-ligne" forcé)
- **Recherche** : Exécutée 100% en local sur l'appareil :
  1. La requête est analysée et convertie en SQL par le cœur Rust (`DocSeekerCore`).
  2. Le SQL FTS5 s'exécute sur le fichier SQLite local `docseeker_local.sqlite`.
  3. Le tri unifié Goodnotes (BM25 + bonus titre + bonus volume) est appliqué en RAM par Rust.
- **Vignettes** : Générées localement à la volée :
  1. `CoreGraphics` ouvre la page du PDF local stocké sur le SSD de l'iPhone.
  2. Le cœur Rust calcule le rectangle de cadrage optimal (`calculate_crop_bounds`).
  3. L'extrait est découpé, surligné en jaune Goodnotes (`rgba(255, 235, 59, 0.40)`) et mis en cache mémoire.

---

### 3.3. Construction 100% Locale de la Base d'Indexation

Conformément à l'exigence stricte de sécurité et de découplage :
- Le serveur ne transmet **jamais** de fichier `.sqlite` binaire pré-calculé.
- Pour chaque document synchronisé, l'application télécharge le bundle brut :  
  `GET /api/sync/bundle/{doc_id}` (JSON contenant les métadonnées, le texte brut de chaque page et les coordonnées spatiales `words_json`).
- **Ingestion locale par Rust** : Le cœur Rust embarqué exécute la transaction SQL sur la base SQLite locale :
  ```sql
  INSERT OR REPLACE INTO documents (id, filename, title, folder_id, total_pages, file_size) VALUES (...);
  INSERT OR REPLACE INTO pages (doc_id, page_number, text_content, words_json) VALUES (...);
  -- Le trigger local pages_ai alimente automatiquement l'index pages_fts (FTS5)
  ```
- La base est créée, vérifiée et réparée directement sur l'appareil.

---

### 3.4. Gestion de Cache Complète (À l'Ouverture, par Document et par Dossier)

Le gestionnaire de téléchargement natif (`DownloadQueueManager`) reproduit à l'identique l'expérience Web :

1. **Téléchargement individuel par document** :
   - Bouton de mise en cache présent sur chaque carte de document.
   - Téléchargement du bundle d'indexation + téléchargement du fichier PDF.
2. **Téléchargement groupé par dossier** :
   - Bouton « Télécharger tout le dossier » dans la barre d'outils.
   - Enfilement récursif de tous les documents du dossier dans la file d'attente.
3. **Aspiration dynamique à l'ouverture** :
   - À l'ouverture d'un PDF non encore disponible hors-ligne, un téléchargement en tâche de fond est automatiquement lancé pour le pérenniser.
4. **Reprise sur coupure (Resumable Downloads)** :
   - Les téléchargements de fichiers PDF s'effectuent via `URLSessionDownloadTask`.
   - Si l'utilisateur quitte le document, passe en mode avion ou ferme l'application, les `resumeData` sont sauvegardés.
   - À la reconnexion ou à la réouverture, le téléchargement reprend exactement là où il s'est interrompu.
5. **Gestion de la concurrence** :
   - Maximum 2 téléchargements simultanés pour ne pas saturer la bande passante.
   - Commandes globales : **Pause**, **Reprise**, **Tout annuler**.
6. **Stockage illimité et libération manuelle** :
   - Aucun plafond automatique n'expulse les documents.
   - Options de libération explicite : "Supprimer du cache local" par document ou pour tout un dossier.

---

### 3.5. Lecteur PDF Haute Performance (Moteur Aperçu iOS)

1. **Intégration Apple PDFKit** :
   - Composant `PDFView` configuré en défilement vertical continu (`displayMode = .singlePageContinuous`).
   - Rendu accéléré par GPU Metal : fluidité native 120 FPS constante sur iPhone et iPad ProMotion.
2. **Saut d'occurrence et surlignage haute fidélité** :
   - Clic sur une vignette dans le ruban ou le tiroir → saut instantané à la page (`go(to: page)`).
   - Centrage automatique sur la zone du mot recherché.
   - Surlignage dynamique avec `PDFAnnotation` native ou calque vectoriel superposé.
3. **Navigation dans les occurrences** :
   - Stepper flottant avec boutons Précédent / Suivant et compteur (`Occurrence 12 / 85`).
4. **Gestes natifs** :
   - Pincement pour zoomer (Pinch-to-zoom) fluide sans perte de netteté vectorielle.
   - Défilement inertiel et rebond élastique natif iOS.

---

### 3.6. Ergonomie Spécifique aux Formats Apple (HIG)

#### A. Sur iPhone
- **Navigation** : Barre de recherche supérieure avec filtres en pastilles (Tokens/Chips) : *Titres*, *Dossier*, *Hors-ligne*.
- **Ruban de résultats** : `ScrollView(.horizontal)` fluide affichant les extraits découpés avec surlignage jaune.
- **Tiroir d'occurrences** : Feuille native SwiftUI (`.sheet`) avec positions ajustables (`.presentationDetents([.medium, .large])`) pour feuilleter les extraits tout en consultant le PDF en arrière-plan.
- **Virtualisation native** : Utilisation de `LazyVStack` dans le tiroir (seules les ~10 vignettes visibles sont chargées en mémoire, éradiquant les saturations mémoire sur 600+ extraits).

#### B. Sur iPad
- **Navigation 3 colonnes (`NavigationSplitView`)** :
  - **Sidebar (gauche)** : Arborescence hiérarchique des dossiers avec compteurs et jauges de synchronisation.
  - **Liste centrale** : Documents du dossier ou résultats de recherche avec filtres et options de tri.
  - **Panneau de lecture (droite)** : Grand lecteur PDFKit avec volet latéral rétractable d'extraits.
- **Support Apple Pencil** : Défilement, sélection et navigation au stylet.

---

## 4. Transposition Complète de la Suite de Tests (XCTest & XCUITest)

Chaque test automatisé existant dans Playwright est transposé fidèlement en test natif sous Xcode :

| Test Playwright Web | Test Natif Xcode (XCTest / XCUITest) | Validation |
|---|---|---|
| **Core UI (ui_core.spec)** | `DocSeekerCoreUITests.testSearchAndFilters()` | Authentification, saisie recherche, affichage des cartes et dossiers. |
| **M1 (Isolation header / status bar)** | `DocSeekerMobileTests.testSafeAreaHeaderInsets()` | Vérification que le header ne chevauche jamais la Dynamic Island ni la barre d'état. |
| **M2 (Zoom focus)** | `DocSeekerMobileTests.testSearchBarFocusNoZoom()` | Comportement natif du champ de recherche. |
| **M3 (Tri Pages / Pertinence)** | `DocSeekerMobileTests.testDrawerSortingRelevanceAndPage()` | Tri des 619 occurrences de Martingales par pertinence et par page croissante. |
| **M4 (Vignettes Offline)** | `DocSeekerOfflineTests.testOfflineCropRendering()` | Découpe locale par CoreGraphics + Rust, vérification de la présence du surlignage. |
| **M5 & M6 (Full Offline Flow)** | `DocSeekerOfflineTests.testFullOfflineLifecycle()` | Coupure réseau complète, redémarrage de l'app, recherche FTS5 locale et ouverture viewer. |
| **Stress & Volume (1737 pages)** | `DocSeekerPerformanceTests.testMartingaleScroll120FPS()` | Mesure du taux de rafraîchissement (CADisplayLink) et de l'absence de fuite mémoire GPU. |

---

## 5. Méthode d'Installation par Câble (Gratuite)

- **Prérequis** : Un Mac équipé de macOS et de l'application gratuite **Xcode** (téléchargeable sur le Mac App Store).
- **Profil de signature personnel** : Connexion d'un compte Apple classique (identifiant Apple standard) dans Xcode (Settings > Accounts).
- **Déploiement** :
  1. Branchement de l'iPhone ou de l'iPad par câble USB/Lightning au Mac.
  2. Sélection de l'appareil dans Xcode.
  3. Clic sur le bouton **Run (Lecture)** : Xcode compile le cœur Rust, assemble l'application Swift et l'installe directement sur l'appareil.
  4. Validation initiale dans Réglages iPhone > Général > VPN et gestion des appareils.
- **Bénéfice** : Zéro abonnement payant ($99/an évités), cycle d'itération immédiat.

---

## 6. Plan de Réalisation et Jalons de Développement

| Phase | Intitulé | Durée estimée | Livrables techniques |
|---|---|---|---|
| **Jalon 1** | **Compilation Rust & Bridge Swift** | 3 jours | `DocSeekerCore.xcframework` généré, tests unitaires Rust ↔ Swift validés sur la base SQLite locale. |
| **Jalon 2** | **Client API & Download Manager** | 4 jours | Authentification Keychain, file d'attente résiliente (`URLSessionDownloadTask` avec reprise), ingestion du bundle dans SQLite. |
| **Jalon 3** | **Lecteur PDFKit & Découpe Native** | 4 jours | `PDFView` intégré en Metal 120 Hz, surlignage vectoriel, moteur de découpe locale d'extraits via CoreGraphics. |
| **Jalon 4** | **Interface iPhone & iPad SwiftUI** | 5 jours | Arborescence des dossiers, grille de documents, rubans horizontaux, tiroir vertical virtualisé (`LazyVStack`), vue 3 colonnes iPad. |
| **Jalon 5** | **Transposition des Tests & Recette** | 3 jours | Suite XCUITest / XCTest complète, validation de la fluidité sur *Martingales* (1737 pages). |
| **Total** | **Projet complet clé en main** | **~3 semaines** | **Application native iOS/iPadOS complète et testée** |
