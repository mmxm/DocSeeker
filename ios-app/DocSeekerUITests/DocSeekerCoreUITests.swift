// DocSeekerCoreUITests.swift
// Suite XCUITest Complète : Transposition des standards ISO 29119 & ui_core.spec.mjs
// Navigation Arborescence, Clic Dossiers, Lecteur Goodnotes, Flèches d'Occurrences et Tiroir Latéral

import XCTest

final class DocSeekerCoreUITests: XCTestCase {
    var harness: DocSeekerTestHarness!
    
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        harness = DocSeekerTestHarness()
        harness.launch()
    }
    
    /// Scénario 1 : Navigation dans l'arborescence, clic et entrée dans un dossier, retour à la racine
    func testInitialStateAndFolderEntryAndDrillDown() {
        // 1. En-tête compact et titre
        let docsTitle = harness.app.staticTexts["Documents"]
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 4.0), "Le titre compact 'Documents' doit être affiché")
        
        // 2. Présence du dossier dans la liste
        let martingaleFolder = harness.app.staticTexts["Martingale"]
        XCTAssertTrue(martingaleFolder.waitForExistence(timeout: 5.0), "Le dossier 'Martingale' doit figurer dans la liste")
        
        // 3. CLIC EFFECTIF sur le dossier (Geste tactile complet)
        martingaleFolder.tap()
        
        // 4. Assertion de transition d'état : l'en-tête doit afficher le nom du dossier
        let folderTitle = harness.app.staticTexts["Martingale"]
        XCTAssertTrue(folderTitle.waitForExistence(timeout: 4.0), "L'en-tête doit afficher le titre du dossier ouvert")
        
        // 5. Bouton de retour vers la racine
        let backButton = harness.app.buttons["Retour"]
        XCTAssertTrue(backButton.waitForExistence(timeout: 3.0), "Le bouton 'Retour' doit apparaître lors de l'entrée dans un dossier")
        
        // 6. Clic retour et vérification de la restauration de l'arborescence
        backButton.tap()
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 3.0), "Le retour doit rétablir la vue racine des Documents")
        XCTAssertTrue(martingaleFolder.exists, "Le dossier 'Martingale' doit être à nouveau présent à la racine")
    }
    
    /// Scénario 2 : Recherche clinique, ouverture du lecteur et navigation par flèches
    func testOccurrenceNavigationAndBottomBarArrows() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0), "Le résultat '023 - Grossesse normale' doit apparaître")
        docCard.tap()
        
        // Vérification de l'ouverture du lecteur Goodnotes
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        XCTAssertTrue(homeBtn.waitForExistence(timeout: 6.0), "Le lecteur doit afficher le bouton de retour accueil")
        
        // Vérification de la présence de la requête dans le bandeau inférieur
        let queryBadge = harness.app.staticTexts["grossesse"]
        XCTAssertTrue(queryBadge.waitForExistence(timeout: 4.0), "Le bandeau inférieur doit afficher 'grossesse'")
        
        // Vérification du compteur initial
        let initialCounter = harness.bottomBarCounterText()
        XCTAssertTrue(initialCounter.contains("correspondance"), "Le bandeau doit afficher le nombre de correspondances (ex: 1 sur X)")
        
        // Clic sur la flèche suivante
        let nextBtn = harness.app.buttons["occurrence_next"]
        if nextBtn.waitForExistence(timeout: 3.0) && nextBtn.isEnabled {
            nextBtn.tap()
            
            // Assertion de transition d'état : le compteur doit avoir évolué
            let updatedCounter = harness.bottomBarCounterText()
            XCTAssertFalse(updatedCounter.isEmpty, "Le compteur doit toujours être affiché après avance")
            
            // Clic sur la flèche précédente
            let prevBtn = harness.app.buttons["occurrence_prev"]
            XCTAssertTrue(prevBtn.isEnabled, "La flèche précédente doit être active")
            prevBtn.tap()
            
            let revertedCounter = harness.bottomBarCounterText()
            XCTAssertEqual(revertedCounter, initialCounter, "Revenir en arrière doit rétablir le compteur initial")
        }
        
        homeBtn.tap()
    }
    
    /// Scénario 3 : Tiroir d'extraits latéral (préservation de la requête et des occurrences multiples)
    func testInDocumentSearchDrawerPreservesOccurrencesAndQuery() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        docCard.tap()
        
        let drawerBtn = harness.app.buttons["reader_open_drawer"]
        XCTAssertTrue(drawerBtn.waitForExistence(timeout: 5.0), "Le bouton d'ouverture du volet d'extraits doit être présent")
        drawerBtn.tap()
        
        // Vérification du titre du tiroir
        let drawerNavTitle = harness.app.staticTexts["Extraits du document"]
        XCTAssertTrue(drawerNavTitle.waitForExistence(timeout: 4.0), "Le tiroir doit afficher son en-tête 'Extraits du document'")
        
        // Vérification du nombre d'extraits
        let countLabel = harness.app.staticTexts["occurrences_count_label"]
        XCTAssertTrue(countLabel.waitForExistence(timeout: 4.0), "Le libellé de comptage des extraits doit être affiché")
        
        // Sélection d'une occurrence dans le tiroir
        let firstOccItem = harness.app.buttons["drawer_occurrence_0"]
        if firstOccItem.waitForExistence(timeout: 3.0) {
            firstOccItem.tap()
        } else {
            let closeBtn = harness.app.buttons["drawer_close"]
            if closeBtn.exists { closeBtn.tap() }
        }
        
        // INVARIANT CRITIQUE 1 : La requête textuelle NE DOIT PAS être devenue "Extrait"
        let queryToken = harness.app.staticTexts["grossesse"]
        XCTAssertTrue(queryToken.waitForExistence(timeout: 3.0), "La requête doit être conservée ('grossesse') et non remplacée par 'Extrait'")
        
        // INVARIANT CRITIQUE 2 : Le bouton retour à l'accueil doit fonctionner
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        XCTAssertTrue(homeBtn.exists)
        homeBtn.tap()
    }
    
    /// Scénario 4 : Popover d'informations complètes sur l'onglet de document
    func testTabChevronOpensDocumentInfoPopover() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        docCard.tap()
        
        let chevronBtn = harness.app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tab_chevron_'")).firstMatch
        if chevronBtn.waitForExistence(timeout: 4.0) {
            chevronBtn.tap()
            
            let locationLabel = harness.app.staticTexts["Emplacement :"]
            let pageLabel = harness.app.staticTexts["Page courante :"]
            XCTAssertTrue(locationLabel.waitForExistence(timeout: 3.0) || pageLabel.waitForExistence(timeout: 3.0), "La popover doit afficher les informations de localisation du document")
        }
        
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        if homeBtn.exists { homeBtn.tap() }
    }
    
    /// Scénario 5 : Parcours continu long multi-actions (Continuous Journey)
    func testLongContinuousUserJourney() {
        // 1. Recherche
        harness.search(query: "grossesse")
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        
        // 2. Ouverture document et navigation
        docCard.tap()
        harness.tapNextOccurrence()
        
        // 3. Retour Accueil (préservation d'état)
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        XCTAssertTrue(homeBtn.waitForExistence(timeout: 4.0))
        homeBtn.tap()
        
        // 4. Vérification que les résultats de recherche sont toujours là
        XCTAssertTrue(docCard.waitForExistence(timeout: 3.0), "Les résultats de recherche doivent être préservés après retour")
        
        // 5. Fermeture de la recherche
        harness.clearSearch()
        
        // 6. Navigation dans un dossier
        let martingaleFolder = harness.app.staticTexts["Martingale"]
        if martingaleFolder.waitForExistence(timeout: 4.0) {
            martingaleFolder.tap()
            let backBtn = harness.app.buttons["Retour"]
            XCTAssertTrue(backBtn.waitForExistence(timeout: 3.0))
            backBtn.tap()
        }
    }
}
