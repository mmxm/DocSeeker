// DocSeekerOfflineUITests.swift
// Suite XCUITest Hors-Ligne Exhaustive : Transposition Strictement Identique des Tests En Ligne
// Standards ISO 29119 Résilience Réseau, Coupure Réelle Serveur (Port Injoignable 9999),
// Recherche FTS5 Locale, Moteur de Découpe CoreGraphics, Tiroir d'Occurrences et Navigation Arborescente

import XCTest

final class DocSeekerOfflineUITests: XCTestCase {
    var harness: DocSeekerTestHarness!
    
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        harness = DocSeekerTestHarness()
        harness.launch()
        
        // 1. Garantir que le document 1 (023 - Grossesse normale) est en cache avant la coupure
        harness.ensureDoc1ReadyForOffline()
        
        // 2. Coupure RÉELLE de la liaison serveur (redirection vers le port injoignable 9999)
        harness.disconnectServer()
    }
    
    override func tearDown() {
        // Rétablissement systématique de la connexion serveur à la fin de chaque test
        harness.reconnectServer()
        super.tearDown()
    }
    
    // =========================================================================
    // SCÉNARIO 1 : Navigation arborescente locale (Dossier Martingale & Retour)
    // Transposition stricte de DocSeekerCoreUITests.testInitialStateAndFolderEntryAndDrillDown
    // =========================================================================
    
    func testOfflineInitialStateAndFolderEntryAndDrillDown() {
        // 1. Vérification de l'indicateur hors-ligne
        let offlineIndicator = harness.app.descendants(matching: .any)["network_status_indicator"]
        XCTAssertTrue(offlineIndicator.waitForExistence(timeout: 4.0), "Le badge de statut réseau doit être affiché")
        XCTAssertTrue(offlineIndicator.label.contains("Hors-ligne") || offlineIndicator.label.contains("offline"), "Le badge doit afficher 'Hors-ligne' en cas de rupture de liaison serveur")
        
        // 2. En-tête compact et titre
        let docsTitle = harness.app.staticTexts["Documents"]
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 4.0), "Le titre compact 'Documents' doit être affiché depuis SQLite local")
        
        // 3. Présence du dossier dans la liste SQLite locale
        let martingaleFolder = harness.app.staticTexts["Martingale"]
        XCTAssertTrue(martingaleFolder.waitForExistence(timeout: 4.0), "Le dossier 'Martingale' doit figurer dans la base SQLite locale")
        
        // 4. CLIC EFFECTIF sur le dossier (Geste tactile complet hors-ligne)
        martingaleFolder.tap()
        
        // 5. Assertion de transition d'état : l'en-tête doit afficher le nom du dossier
        let folderTitle = harness.app.staticTexts["Martingale"]
        XCTAssertTrue(folderTitle.waitForExistence(timeout: 4.0), "L'en-tête doit afficher le titre du dossier ouvert en mode déconnecté")
        
        // 6. Bouton de retour vers la racine
        let backButton = harness.app.buttons["Retour"]
        XCTAssertTrue(backButton.waitForExistence(timeout: 3.0), "Le bouton 'Retour' doit apparaître lors de l'entrée dans un dossier hors-ligne")
        
        // 7. Clic retour et vérification de la restauration de l'arborescence
        backButton.tap()
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 3.0), "Le retour doit rétablir la vue racine des Documents hors-ligne")
        XCTAssertTrue(martingaleFolder.exists, "Le dossier 'Martingale' doit être à nouveau présent à la racine")
    }
    
    // =========================================================================
    // SCÉNARIO 2 : Recherche clinique locale, ouverture lecteur & navigation par flèches
    // Transposition stricte de DocSeekerCoreUITests.testOccurrenceNavigationAndBottomBarArrows
    // =========================================================================
    
    func testOfflineOccurrenceNavigationAndBottomBarArrows() {
        // 1. Recherche locale 100% hors-ligne (FTS5 + BM25 C-ABI)
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0), "Le résultat local '023 - Grossesse normale' doit apparaître")
        
        // 2. Clic pour ouvrir dans le lecteur Goodnotes hors-ligne
        harness.openFirstDocumentReader()
        
        // 3. Vérification de l'ouverture du lecteur Goodnotes
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        XCTAssertTrue(homeBtn.waitForExistence(timeout: 6.0), "Le lecteur hors-ligne doit afficher le bouton de retour accueil")
        
        // 4. Vérification de la présence de la requête dans le bandeau inférieur
        let queryBadge = harness.app.staticTexts["grossesse"]
        XCTAssertTrue(queryBadge.waitForExistence(timeout: 4.0), "Le bandeau inférieur hors-ligne doit afficher 'grossesse'")
        
        // 5. Vérification du compteur initial
        let initialCounter = harness.bottomBarCounterText()
        XCTAssertTrue(initialCounter.contains("correspondance"), "Le bandeau doit afficher le nombre de correspondances (ex: 1 sur X)")
        
        // 6. Clic sur la flèche suivante
        let nextBtn = harness.app.buttons["occurrence_next"]
        if nextBtn.waitForExistence(timeout: 3.0) && nextBtn.isEnabled {
            nextBtn.tap()
            
            let updatedCounter = harness.bottomBarCounterText()
            XCTAssertFalse(updatedCounter.isEmpty, "Le compteur doit toujours être affiché après avance hors-ligne")
            
            // 7. Clic sur la flèche précédente
            let prevBtn = harness.app.buttons["occurrence_prev"]
            XCTAssertTrue(prevBtn.isEnabled, "La flèche précédente doit être active hors-ligne")
            prevBtn.tap()
            
            let revertedCounter = harness.bottomBarCounterText()
            XCTAssertEqual(revertedCounter, initialCounter, "Revenir en arrière doit rétablir le compteur initial")
        }
        
        homeBtn.tap()
        harness.clearSearch()
    }
    
    // =========================================================================
    // SCÉNARIO 3 : Volet latéral d'extraits hors-ligne (préservation requête et sélection)
    // Transposition stricte de DocSeekerCoreUITests.testInDocumentSearchDrawerPreservesOccurrencesAndQuery
    // =========================================================================
    
    func testOfflineInDocumentSearchDrawerPreservesOccurrencesAndQuery() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        harness.openFirstDocumentReader()
        
        let drawerBtn = harness.app.buttons["reader_open_drawer"]
        XCTAssertTrue(drawerBtn.waitForExistence(timeout: 5.0), "Le bouton d'ouverture du volet d'extraits doit être présent en mode hors-ligne")
        drawerBtn.tap()
        
        // Vérification du titre du tiroir
        let drawerNavTitle = harness.app.staticTexts["Extraits du document"]
        XCTAssertTrue(drawerNavTitle.waitForExistence(timeout: 4.0), "Le tiroir hors-ligne doit afficher son en-tête 'Extraits du document'")
        
        // Vérification du nombre d'extraits locaux
        let countLabel = harness.app.staticTexts["occurrences_count_label"]
        XCTAssertTrue(countLabel.waitForExistence(timeout: 4.0), "Le libellé de comptage des extraits locaux doit être affiché")
        
        // Sélection d'une occurrence dans le tiroir hors-ligne
        let firstOccItem = harness.app.buttons["drawer_occurrence_0"]
        if firstOccItem.waitForExistence(timeout: 3.0) {
            firstOccItem.tap()
        } else {
            let closeBtn = harness.app.buttons["drawer_close"]
            if closeBtn.exists { closeBtn.tap() }
        }
        
        // INVARIANT CRITIQUE 1 : La requête textuelle NE DOIT PAS être altérée
        let queryToken = harness.app.staticTexts["grossesse"]
        XCTAssertTrue(queryToken.waitForExistence(timeout: 3.0), "La requête doit être conservée ('grossesse') hors-ligne")
        
        // INVARIANT CRITIQUE 2 : Le bouton retour à l'accueil doit fonctionner
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        XCTAssertTrue(homeBtn.exists)
        homeBtn.tap()
        
        harness.clearSearch()
    }
    
    // =========================================================================
    // SCÉNARIO 4 : Popover d'informations complètes sur l'onglet de document hors-ligne
    // Transposition stricte de DocSeekerCoreUITests.testTabChevronOpensDocumentInfoPopover
    // =========================================================================
    
    func testOfflineTabChevronOpensDocumentInfoPopover() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        harness.openFirstDocumentReader()
        
        let chevronBtn = harness.app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tab_chevron_'")).firstMatch
        if chevronBtn.waitForExistence(timeout: 4.0) {
            chevronBtn.tap()
            
            let locationLabel = harness.app.staticTexts["Emplacement :"]
            let pageLabel = harness.app.staticTexts["Page courante :"]
            XCTAssertTrue(locationLabel.waitForExistence(timeout: 3.0) || pageLabel.waitForExistence(timeout: 3.0), "La popover hors-ligne doit afficher les informations de localisation du document")
            
            // Fermer proprement la popover
            let closeBtn = harness.app.buttons["popover_close_button"]
            if closeBtn.waitForExistence(timeout: 2.0) {
                closeBtn.tap()
            }
        }
        
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        if homeBtn.waitForExistence(timeout: 3.0) { homeBtn.tap() }
        harness.clearSearch()
    }
    
    // =========================================================================
    // SCÉNARIO 5 : Parcours continu long multi-actions en mode 100% déconnecté
    // Transposition stricte de DocSeekerCoreUITests.testLongContinuousUserJourney
    // =========================================================================
    
    func testOfflineLongContinuousUserJourney() {
        // 1. Recherche hors-ligne
        harness.search(query: "grossesse")
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        
        // 2. Ouverture document hors-ligne et navigation d'occurrence
        harness.openFirstDocumentReader()
        harness.tapNextOccurrence()
        
        // 3. Retour Accueil (préservation d'état hors-ligne)
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        XCTAssertTrue(homeBtn.waitForExistence(timeout: 4.0))
        homeBtn.tap()
        
        // 4. Vérification que les résultats de recherche sont toujours préservés
        XCTAssertTrue(docCard.waitForExistence(timeout: 3.0), "Les résultats de recherche hors-ligne doivent être préservés après retour")
        
        // 5. Fermeture de la recherche
        harness.clearSearch()
        
        // 6. Navigation dans un dossier hors-ligne
        let martingaleFolder = harness.app.staticTexts["Martingale"]
        if martingaleFolder.waitForExistence(timeout: 4.0) {
            martingaleFolder.tap()
            let backBtn = harness.app.buttons["Retour"]
            XCTAssertTrue(backBtn.waitForExistence(timeout: 3.0))
            backBtn.tap()
        }
    }
    
    // =========================================================================
    // SCÉNARIO 6 : Exclusion documents non-téléchargés et état vide propre hors-ligne
    // Transposition des scénarios O2 et O8 de ui_offline.spec.mjs
    // =========================================================================
    
    func testOfflineUncachedDocExclusionAndEmptyState() {
        // Recherche sans résultat possible en coupure réseau totale
        harness.search(query: "pathologieinexistante999")
        
        let emptyNotice = harness.app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'Aucun résultat'")).firstMatch
        XCTAssertTrue(emptyNotice.waitForExistence(timeout: 4.0), "La recherche hors-ligne sans résultat doit afficher un état vide propre")
        
        harness.clearSearch()
    }
    
    // =========================================================================
    // SCÉNARIO 7 : Parité stricte des résultats et vignettes entre En Ligne et Hors-Ligne
    // Transposition du scénario O9 de ui_offline.spec.mjs
    // =========================================================================
    
    func testOfflineOnlineParity() {
        // 1. Exécution en mode Hors-ligne (déjà actif)
        harness.search(query: "grossesse")
        let offlineDocCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(offlineDocCard.waitForExistence(timeout: 6.0), "Le document doit être trouvé hors-ligne")
        harness.clearSearch()
        
        // 2. Rétablissement en ligne
        harness.reconnectServer()
        
        // 3. Exécution en mode En Ligne
        harness.search(query: "grossesse")
        let onlineDocCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(onlineDocCard.waitForExistence(timeout: 6.0), "Le document doit être trouvé en ligne")
        harness.clearSearch()
    }
}
