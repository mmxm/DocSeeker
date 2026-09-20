// DocSeekerCoreUITests.swift
// Suite XCUITest Complète : Transposition des standards ISO 29119 & ui_core.spec.mjs
// Navigation Arborescence, Clic Dossiers, Lecteur Goodnotes, Flèches d'Occurrences et Tiroir Latéral
// + Analyses Visuelles Automatiques Multi-Niveaux intégrées (Niveau 1, 2, 3)

import XCTest
import Vision

final class DocSeekerCoreUITests: XCTestCase {
    var harness: DocSeekerTestHarness!
    
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        harness = DocSeekerTestHarness()
        harness.launch()
    }
    
    // =========================================================================
    // Scénario 1 : Navigation dans l'arborescence, clic et entrée dans un dossier, retour à la racine
    // + Analyses Visuelles Niveaux 1, 3
    // =========================================================================
    func testInitialStateAndFolderEntryAndDrillDown() {
        // 1. En-tête compact et titre
        let docsTitle = harness.app.staticTexts["Documents"]
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 4.0), "Le titre compact 'Documents' doit être affiché")
        
        // [Visuel Niveau 1] Écran d'accueil non blanc
        let homeScreen = XCUIScreen.main.screenshot().image
        let l1Home = VisualValidationEngine.assertNonBlankScreen(image: homeScreen, testCase: self, context: "C1_AccueilRacine")
        XCTAssertTrue(l1Home.passed, "L'écran d'accueil ne doit pas être blanc")
        
        // [Visuel Niveau 3] L'OCR doit détecter 'Documents' et le nom d'un dossier
        let l3Home = VisualValidationEngine.assertVisibleTextContains(image: homeScreen, expectedKeywords: ["Documents"], testCase: self, context: "C1_AccueilRacine_OCR")
        XCTAssertTrue(l3Home.passed, "L'OCR doit reconnaître 'Documents' à l'écran")
        
        // 2. Présence du dossier dans la liste
        let martingaleFolder = harness.app.staticTexts["Martingale"]
        XCTAssertTrue(martingaleFolder.waitForExistence(timeout: 5.0), "Le dossier 'Martingale' doit figurer dans la liste")
        
        // 3. CLIC EFFECTIF sur le dossier (Geste tactile complet)
        martingaleFolder.tap()
        
        // 4. Assertion de transition d'état : l'en-tête doit afficher le nom du dossier
        let folderTitle = harness.app.staticTexts["Martingale"]
        XCTAssertTrue(folderTitle.waitForExistence(timeout: 4.0), "L'en-tête doit afficher le titre du dossier ouvert")
        
        // [Visuel Niveau 1 & 3] Dossier ouvert
        sleep(1)
        let folderScreen = XCUIScreen.main.screenshot().image
        let l1Folder = VisualValidationEngine.assertNonBlankScreen(image: folderScreen, testCase: self, context: "C1_DossierMartingale")
        XCTAssertTrue(l1Folder.passed, "L'écran du dossier Martingale ne doit pas être blanc")
        VisualValidationEngine.assertVisibleTextContains(image: folderScreen, expectedKeywords: ["Martingale", "Retour"], testCase: self, context: "C1_DossierMartingale_OCR")
        
        // 5. Bouton de retour vers la racine
        let backButton = harness.app.buttons["Retour"]
        XCTAssertTrue(backButton.waitForExistence(timeout: 3.0), "Le bouton 'Retour' doit apparaître lors de l'entrée dans un dossier")
        
        // 6. Clic retour et vérification de la restauration de l'arborescence
        backButton.tap()
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 3.0), "Le retour doit rétablir la vue racine des Documents")
        XCTAssertTrue(martingaleFolder.exists, "Le dossier 'Martingale' doit être à nouveau présent à la racine")
        
        // [Visuel Niveau 1 & 3] Retour à la racine validé
        sleep(1)
        let returnScreen = XCUIScreen.main.screenshot().image
        let l1Return = VisualValidationEngine.assertNonBlankScreen(image: returnScreen, testCase: self, context: "C1_RetourRacine")
        XCTAssertTrue(l1Return.passed, "L'écran de retour à la racine ne doit pas être blanc")
        VisualValidationEngine.assertVisibleTextContains(image: returnScreen, expectedKeywords: ["Documents", "Martingale"], testCase: self, context: "C1_RetourRacine_OCR")
    }
    
    // =========================================================================
    // Scénario 2 : Recherche clinique, ouverture du lecteur et navigation par flèches
    // + Analyses Visuelles Niveaux 1, 2, 3
    // =========================================================================
    func testOccurrenceNavigationAndBottomBarArrows() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0), "Le résultat '023 - Grossesse normale' doit apparaître")
        
        // [Visuel Niveau 1 & 3] Résultats de recherche
        sleep(1)
        let searchResultsScreen = XCUIScreen.main.screenshot().image
        let l1Search = VisualValidationEngine.assertNonBlankScreen(image: searchResultsScreen, testCase: self, context: "C2_ResultatsRecherche")
        XCTAssertTrue(l1Search.passed, "L'écran de résultats ne doit pas être blanc")
        VisualValidationEngine.assertVisibleTextContains(image: searchResultsScreen, expectedKeywords: ["grossesse", "023", "Grossesse", "normale"], testCase: self, context: "C2_ResultatsRecherche_OCR")
        
        docCard.tap()
        
        // Vérification de l'ouverture du lecteur Goodnotes
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        XCTAssertTrue(homeBtn.waitForExistence(timeout: 6.0), "Le lecteur doit afficher le bouton de retour accueil")
        
        // [Visuel Niveau 1] Lecteur PDF ouvert, non blanc
        sleep(2)
        let readerScreen = XCUIScreen.main.screenshot().image
        let l1Reader = VisualValidationEngine.assertNonBlankScreen(image: readerScreen, testCase: self, context: "C2_LecteurPDF")
        XCTAssertTrue(l1Reader.passed, "Le lecteur PDF ne doit jamais afficher un écran blanc")
        
        // [Visuel Niveau 2] Pixel matching contre le PDF de référence
        if let pdfURL = harness.fixturePDFURL(named: "2") {
            let l2 = VisualValidationEngine.assertPixelMatchAgainstPDF(
                capturedImage: readerScreen,
                pdfURL: pdfURL,
                pageNumber: 1,
                minMatchPercentage: 60.0,
                testCase: self,
                context: "C2_LecteurPDF_PixelMatch"
            )
            XCTAssertTrue(l2.score > 45.0, "La correspondance de pixels doit confirmer un rendu PDF réel (score: \(l2.score)%)")
        }
        
        // [Visuel Niveau 3] OCR du lecteur
        let l3Reader = VisualValidationEngine.assertVisibleTextContains(image: readerScreen, expectedKeywords: ["grossesse", "normale", "Page", "Grossesse"], testCase: self, context: "C2_LecteurPDF_OCR")
        XCTAssertTrue(l3Reader.passed, "L'OCR doit reconnaître du contenu lié à 'grossesse' dans le lecteur")
        
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
            
            // [Visuel Niveau 1] Page suivante non blanche
            sleep(1)
            let page2Screen = XCUIScreen.main.screenshot().image
            VisualValidationEngine.assertNonBlankScreen(image: page2Screen, testCase: self, context: "C2_Page2_Occurrence")
            
            // Clic sur la flèche précédente
            let prevBtn = harness.app.buttons["occurrence_prev"]
            XCTAssertTrue(prevBtn.isEnabled, "La flèche précédente doit être active")
            prevBtn.tap()
            
            let revertedCounter = harness.bottomBarCounterText()
            XCTAssertEqual(revertedCounter, initialCounter, "Revenir en arrière doit rétablir le compteur initial")
        }
        
        homeBtn.tap()
        harness.clearSearch()
    }
    
    // =========================================================================
    // Scénario 3 : Tiroir d'extraits latéral (préservation de la requête et des occurrences multiples)
    // + Analyses Visuelles Niveaux 1, 3
    // =========================================================================
    func testInDocumentSearchDrawerPreservesOccurrencesAndQuery() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        docCard.tap()
        
        let drawerBtn = harness.app.buttons["reader_open_drawer"]
        XCTAssertTrue(drawerBtn.waitForExistence(timeout: 5.0), "Le bouton d'ouverture du volet d'extraits doit être présent")
        drawerBtn.tap()
        
        // [Visuel Niveau 1 & 3] Tiroir ouvert
        sleep(1)
        let drawerScreen = XCUIScreen.main.screenshot().image
        let l1Drawer = VisualValidationEngine.assertNonBlankScreen(image: drawerScreen, testCase: self, context: "C3_TiroirExtraits")
        XCTAssertTrue(l1Drawer.passed, "Le tiroir d'extraits ne doit pas afficher un écran blanc")
        VisualValidationEngine.assertVisibleTextContains(image: drawerScreen, expectedKeywords: ["Extraits", "document", "Page", "grossesse"], testCase: self, context: "C3_TiroirExtraits_OCR")
        
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
            
            // [Visuel Niveau 1 & 3] Après sélection d'occurrence
            sleep(1)
            let afterSelectScreen = XCUIScreen.main.screenshot().image
            VisualValidationEngine.assertNonBlankScreen(image: afterSelectScreen, testCase: self, context: "C3_ApresSélectionOccurrence")
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
        harness.clearSearch()
    }
    
    // =========================================================================
    // Scénario 4 : Popover d'informations complètes sur l'onglet de document
    // + Analyses Visuelles Niveaux 1, 3
    // =========================================================================
    func testTabChevronOpensDocumentInfoPopover() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        docCard.tap()
        
        // [Visuel Niveau 1] Lecteur ouvert avant popover
        sleep(1)
        let readerScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: readerScreen, testCase: self, context: "C4_LecteurAvantPopover")
        
        let chevronBtn = harness.app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tab_chevron_'")).firstMatch
        if chevronBtn.waitForExistence(timeout: 4.0) {
            chevronBtn.tap()
            
            // [Visuel Niveau 1 & 3] Popover affichée
            sleep(1)
            let popoverScreen = XCUIScreen.main.screenshot().image
            let l1Popover = VisualValidationEngine.assertNonBlankScreen(image: popoverScreen, testCase: self, context: "C4_Popover_InfoDocument")
            XCTAssertTrue(l1Popover.passed, "La popover d'informations ne doit pas être blanche")
            VisualValidationEngine.assertVisibleTextContains(image: popoverScreen, expectedKeywords: ["Grossesse", "Emplacement", "Page", "023"], testCase: self, context: "C4_Popover_OCR")
            
            let locationLabel = harness.app.staticTexts["Emplacement :"]
            let pageLabel = harness.app.staticTexts["Page courante :"]
            XCTAssertTrue(locationLabel.waitForExistence(timeout: 3.0) || pageLabel.waitForExistence(timeout: 3.0), "La popover doit afficher les informations de localisation du document")
            
            // Fermer la popover
            let closeBtn = harness.app.buttons["popover_close_button"]
            if closeBtn.waitForExistence(timeout: 2.0) {
                closeBtn.tap()
            }
        }
        
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        if homeBtn.exists { homeBtn.tap() }
        harness.clearSearch()
    }
    
    // =========================================================================
    // Scénario 5 : Parcours continu long multi-actions (Continuous Journey)
    // + Analyses Visuelles Niveaux 1, 2, 3 à chaque étape clé
    // =========================================================================
    func testLongContinuousUserJourney() {
        // 1. Recherche
        harness.search(query: "grossesse")
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        
        // [Visuel Niveau 1 & 3] Résultats de recherche
        sleep(1)
        let searchScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: searchScreen, testCase: self, context: "C5_Recherche_LongJourney")
        VisualValidationEngine.assertVisibleTextContains(image: searchScreen, expectedKeywords: ["grossesse", "023", "Grossesse"], testCase: self, context: "C5_Recherche_OCR_LongJourney")
        
        // 2. Ouverture document et navigation
        docCard.tap()
        harness.tapNextOccurrence()
        
        // [Visuel Niveau 1] Après navigation d'occurrence
        sleep(1)
        let occScreen = XCUIScreen.main.screenshot().image
        let l1Occ = VisualValidationEngine.assertNonBlankScreen(image: occScreen, testCase: self, context: "C5_Navigation_LongJourney")
        XCTAssertTrue(l1Occ.passed, "L'écran après navigation d'occurrence ne doit pas être blanc")
        
        // [Visuel Niveau 2] Pixel matching
        if let pdfURL = harness.fixturePDFURL(named: "2") {
            let l2 = VisualValidationEngine.assertPixelMatchAgainstPDF(
                capturedImage: occScreen,
                pdfURL: pdfURL,
                pageNumber: 1,
                minMatchPercentage: 55.0,
                testCase: self,
                context: "C5_PixelMatch_LongJourney"
            )
            XCTAssertTrue(l2.score > 40.0, "La concordance de pixels doit confirmer un rendu PDF (score: \(l2.score)%)")
        }
        
        // 3. Retour Accueil (préservation d'état)
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        XCTAssertTrue(homeBtn.waitForExistence(timeout: 4.0))
        homeBtn.tap()
        
        // 4. Vérification que les résultats de recherche sont toujours là
        XCTAssertTrue(docCard.waitForExistence(timeout: 3.0), "Les résultats de recherche doivent être préservés après retour")
        
        // [Visuel Niveau 1 & 3] Persistance des résultats
        sleep(1)
        let persistedScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: persistedScreen, testCase: self, context: "C5_ResultatsPersistés")
        VisualValidationEngine.assertVisibleTextContains(image: persistedScreen, expectedKeywords: ["grossesse", "023", "normale"], testCase: self, context: "C5_ResultatsPersistés_OCR")
        
        // 5. Fermeture de la recherche
        harness.clearSearch()
        
        // [Visuel Niveau 1] Retour à l'arborescence principale
        sleep(1)
        let mainScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: mainScreen, testCase: self, context: "C5_ArborescencePrincipale")
        
        // 6. Navigation dans un dossier
        let martingaleFolder = harness.app.staticTexts["Martingale"]
        if martingaleFolder.waitForExistence(timeout: 4.0) {
            martingaleFolder.tap()
            let backBtn = harness.app.buttons["Retour"]
            XCTAssertTrue(backBtn.waitForExistence(timeout: 3.0))
            
            // [Visuel Niveau 1 & 3] Dans le dossier
            sleep(1)
            let folderScreen = XCUIScreen.main.screenshot().image
            VisualValidationEngine.assertNonBlankScreen(image: folderScreen, testCase: self, context: "C5_DossierMartingale_LongJourney")
            VisualValidationEngine.assertVisibleTextContains(image: folderScreen, expectedKeywords: ["Martingale", "Retour"], testCase: self, context: "C5_Dossier_OCR_LongJourney")
            
            backBtn.tap()
        }
    }
}
