# Guide d'Ingénierie & Bonnes Pratiques de Tests Logiciels
## Cadre Méthodologique & Référentiel Qualité — DocSeeker (Systèmes Distribués, Web & iOS)

---

## 1. Référentiels & Standards Internationaux de Référence

Ce guide s'appuie sur les standards internationaux reconnus en génie logiciel et assurance qualité :
- **ISO/IEC/IEEE 29119** (*Software Testing Standards*) : processus de test, techniques de conception et gestion des anomalies.
- **ISTQB** (*International Software Testing Qualifications Board*) : niveaux de test (Unitaire, Intégration, Système, Recette) et techniques boîte-noire.
- **Pyramide des Tests de Mike Cohn & Martin Fowler** : équilibre économique et temporel entre tests unitaires, tests de composants/services et tests de bout en bout (E2E).
- **Principes F.I.R.S.T.** (*Clean Code*, Robert C. Martin) : Fast, Independent, Repeatable, Self-Validating, Timely.
- **Philosophie de Kent C. Dodds** : *"The more your tests resemble the way your software is used, the more confidence they can give you."*
- **Standards Apple XCTest / XCUITest** : automatisation asynchrone, ancres d'accessibilité et résilience cycle de vie.

---

## 2. La Pyramide des Tests appliquée à DocSeeker

Pour garantir la pérennité du système sans ralentir les cycles de livraison, les tests sont organisés en 4 couches hermétiques :

```
             / \
            / E2E \           10% — Parcours utilisateur complets (XCUITest & Playwright)
           /-------\
          /  Système \        20% — Résilience réseau, offline, reprise & concurrence
         /-------------\
        /  Intégration   \    30% — C-ABI Rust, SQLite local, API REST, Cache Chunks
       /-----------------\
      /     Unitaires     \   40% — Tokenizers, BM25, Crop Bounds, Normalisation FTS5
     /---------------------\
```

### A. Couche Unitaire (Rust `cargo test` & Swift `DocSeekerTests`)
- **Objectif :** Valider la logique métier pure, algorithmique et déterministe (0 I/O réseau, 0 dépendance UI).
- **Périmètre :**
  - Tokenisation, normalisation Unicode diacritique, sanitization FTS5.
  - Formules de scoring BM25 multi-termes.
  - Calcul trigonométrique des boîtes englobantes et cadrages Goodnotes (`calculate_crop_bounds`).
  - Parsing des requêtes et encodage/décodage JSON/CBOR.
- **Règle :** Exécution instantanée (< 5 secondes pour toute la suite).

### B. Couche Intégration (C-ABI & Persistance)
- **Objectif :** Valider les frontières entre composants et couches logicielles hétérogènes.
- **Périmètre :**
  - Pont C-ABI Swift ↔ Rust (`DocSeekerCore`).
  - Initialisation et migration du schéma SQLite embarqué (`docseeker_init_db`).
  - Insertion atomique de bundles documentaires et synchronisation d'arborescence (`insert_bundle`, `sync_folders`).
  - Gestion des verrous de base de données (WAL mode, transactions concurrentes).

### C. Couche Système & Résilience Réseau (*Fault Injection*)
- **Objectif :** Valider la robustesse face à l'imprévu et à l'adversité réseau.
- **Périmètre :**
  - Coupure réseau brutale en cours de transfert (Simulation Mode Avion / HTTP 503 / Socket drop).
  - Reprise fragment par fragment (*Byte-Range Resume Data*).
  - Détection passive de connexion (zéro ping périodique conformément au cahier des charges).
  - Parité stricte des résultats : la recherche locale FTS5 doit produire les mêmes documents pertinents que l'API centrale en ligne.

### D. Couche E2E & Interface Utilisateur (XCUITest & Playwright)
- **Objectif :** Valider la fidélité de l'expérience utilisateur et les transitions d'état réelles.
- **Périmètre :**
  - Navigation dans l'arborescence de dossiers, sélection, retour en arrière.
  - Lecteur PDFKit natif, affichage des surlignages, bandeau Goodnotes inférieur.
  - Tiroir d'extraits pleine largeur, synchronisation bidirectionnelle de la page affichée.

---

## 3. Techniques de Conception de Tests Exigées (ISTQB / ISO 29119)

### 3.1. Partitionnement en Classes d'Équivalence & Valeurs Limites (BVA)
Ne pas tester uniquement la "valeur moyenne". Chaque champ ou résultat doit couvrir :
- **Classe vide :** 0 document, 0 dossier, 0 occurrence, recherche vide `""` ou espaces `"   "`.
- **Classe unitaire :** Exactement 1 dossier, 1 document, 1 occurrence (vérification singulier/pluriel : `1 document` vs `2 documents`).
- **Classe nominale :** Plusieurs résultats standards (ex. 5 à 15 documents).
- **Classe volumique / stress :** Document à 18 000 pages, recherche à 173 occurrences (« cardiaque » dans *Urgences*), fichier de 500 Mo.
- **Classe invalide / hostile :** Caractères spéciaux SQL/FTS (`*`, `"`, `'`, `AND`, `OR`, `NOT`), emojis, chaînes Unicode sans diacritiques.

### 3.2. Test des Transitions d'États (State Transition Testing)
L'application fonctionne comme un automate fini. Un test exhaustif doit valider **la transition** entre deux états et vérifier qu'aucune donnée n'est perdue lors du passage :

```
[ Racine (Root) ] ──(tap dossier 130)──► [ Vue Dossier 130 ]
       ▲                                         │
       └──────────────(tap Retour)───────────────┘
```
**Assertion obligatoire :** L'état au retour doit être **identique** à l'état initial (position du défilement préservée, sélection intacte).

```
[ Recherche active (173 occ) ] ──(tap vignette #2)──► [ Lecteur PDF (Page 45) ]
       ▲                                                      │
       └────────────────(tap bouton Accueil)──────────────────┘
```
**Assertion obligatoire :** La requête `"cardiaque"` et les 173 résultats de recherche doivent être conservés au retour.

### 3.3. Contrats d'Invariance (Property-Based & Metamorphic Testing)
Un invariant est une propriété mathématique ou logique qui doit demeurer vraie après n'importe quelle séquence d'actions utilisateur :
- **Invariant de Préservation de Requête :** Cliquer sur une vignette ou naviguer dans un document ne doit **jamais** modifier la requête textuelle en cours (`tab.searchQuery == initialQuery`).
- **Invariant de Volume d'Occurrences :** Sélectionner une vignette ne doit jamais réduire le tableau global des occurrences du document (`occurrences.count == totalFound`).
- **Invariant d'Exclusion Hors-Ligne :** En mode hors-ligne (`isOfflineMode == true`), aucun document dont le binaire PDF n'est pas présent sur le disque local ne doit pouvoir être listé ou ouvert.

---

## 4. Anti-Patterns & Bonnes Pratiques Spécifiques à SwiftUI & XCUITest

### ❌ Anti-Pattern 1 : Assertion de Surface (*Shallow Assertion*)
Tester qu'un élément visuel est présent dans l'arborescence SwiftUI ne prouve pas qu'il est cliquable ni que l'action associée s'exécute.
- **Mauvais :** `XCTAssertTrue(app.staticTexts["Martingale"].exists)`
- **Correct :**
  ```swift
  let folderRow = app.descendants(matching: .any)["folder_row_130"]
  XCTAssertTrue(folderRow.waitForExistence(timeout: 3.0), "La ligne de dossier doit exister")
  folderRow.tap() // Exécuter le geste utilisateur
  let childDoc = app.staticTexts["023 - Grossesse normale"]
  XCTAssertTrue(childDoc.waitForExistence(timeout: 3.0), "L'ouverture du dossier doit afficher les enfants")
  ```

### ❌ Anti-Pattern 2 : Boutons Imbriqués en SwiftUI (*Nested Tap Target Collision*)
Dans une cellule de `List`, ne jamais imbriquer un `Button` dans un autre `Button`.
- Le geste de navigation doit être porté par la cellule complète (`.contentShape(Rectangle()).onTapGesture { ... }`).
- Les actions secondaires (ex. bouton de téléchargement ou suppression de cache) doivent impérativement adopter le style `.buttonStyle(.borderless)` pour ne pas propager le tap à la cellule mère.
- **Test requis :** Vérifier que cliquer sur l'icône de statut de cache n'ouvre pas le document, et inversement.

### ❌ Anti-Pattern 3 : Sommeil Statique (*Thread Sleep*)
Ne jamais utiliser `sleep(2)` ou `Thread.sleep(forTimeInterval: 2.0)` dans les tests XCUITest ou Playwright. Cela crée des tests lents, instables et non déterministes (*flaky tests*).
- **Standard exigé :** Toujours utiliser des attentes sur prédicat ou événements explicites :
  `XCTAssertTrue(element.waitForExistence(timeout: 5.0))` ou `expectation(for:evaluatedWith:handler:)`.

---

## 5. Modèle Canonique de Test d'Interface (Pattern A.A.A. / Given-When-Then)

Chaque test d'interface doit être structuré de manière lisible selon le pattern **Arrange-Act-Assert** :

```swift
func testNominalOccurrenceNavigationFlow() {
    // 1. ARRANGE (Given) : État initial connu et déterministe
    harness.launch(cleanState: true)
    harness.ensureDocumentCached(docId: 1) // Document Grossesse normale
    
    // 2. ACT (When) : Actions utilisateur séquentielles
    harness.search(query: "grossesse")
    let targetDocCard = harness.app.staticTexts["023 - Grossesse normale"]
    XCTAssertTrue(targetDocCard.waitForExistence(timeout: 4.0))
    
    // Clic sur la vignette #2
    harness.selectVignette(docId: 1, index: 1)
    
    // 3. ASSERT (Then) : Vérification multidimensionnelle des invariants
    // Invariant A : Lecteur ouvert
    XCTAssertTrue(harness.app.buttons["Retour à l'accueil"].waitForExistence(timeout: 3.0))
    // Invariant B : Requête préservée
    XCTAssertEqual(harness.bottomBarQueryText(), "grossesse")
    // Invariant C : Index actif positionné
    XCTAssertEqual(harness.bottomBarCounterText(), "2 sur 5 correspondances")
    // Invariant D : Bouton Suivant actif et fonctionnel
    let nextBtn = harness.app.buttons["occurrence_next"]
    XCTAssertTrue(nextBtn.isEnabled)
    nextBtn.tap()
    XCTAssertEqual(harness.bottomBarCounterText(), "3 sur 5 correspondances")
}
```

---

## 6. Protocole de Validation Avant Déploiement

Avant toute mise à jour sur l'appareil de production (iPhone) ou déploiement NAS :
1. **Tests unitaires et algorithmiques Rust :** `cargo test --workspace` (100% vert).
2. **Tests unitaires et intégration Swift :** `xcodebuild test -scheme DocSeeker -only-testing:DocSeekerTests` (100% vert).
3. **Tests de résilience et interface XCUITest :** `xcodebuild test -scheme DocSeeker -only-testing:DocSeekerUITests` (100% vert).
4. **Vérification manuelle des audits d'accessibilité et de contraste** (thèmes clair et sombre).
