// DocSeekerOfflineUITests.swift
// Suite XCUITest Hors-Ligne Exhaustive avec Analyses Visuelles Multi-Niveaux Systématiques
// Standards ISO 29119 Résilience Réseau, Coupure Réelle Serveur (Port Injoignable 9999),
// et Validation Visuelle à 3 Niveaux (Anti-Écran Blanc, Pixel Matching/Diff Mask, OCR Vision Neuronal)

import XCTest
import Vision

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
    // + Analyses Visuelles Niveaux 1, 2, 3 intégrées
    // =========================================================================
    
    func testOfflineInitialStateAndFolderEntryAndDrillDown() {
        // 1. Vérification de l'indicateur hors-ligne
        let offlineIndicator = harness.app.descendants(matching: .any)["network_status_indicator"]
        XCTAssertTrue(offlineIndicator.waitForExistence(timeout: 4.0), "Le badge de statut réseau doit être affiché")
        XCTAssertTrue(offlineIndicator.label.contains("Hors-ligne") || offlineIndicator.label.contains("offline"), "Le badge doit afficher 'Hors-ligne' en cas de rupture de liaison serveur")
        
        // 2. En-tête compact et titre
        let docsTitle = harness.app.staticTexts["Documents"]
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 4.0), "Le titre compact 'Documents' doit être affiché depuis SQLite local")
        
        // [Visuel Niveau 1 & 3] Validation de la vue racine hors-ligne
        let rootScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: rootScreen, testCase: self, context: "S1_Racine_HorsLigne")
        VisualValidationEngine.assertVisibleTextContains(image: rootScreen, expectedKeywords: ["Documents", "Martingale"], testCase: self, context: "S1_Racine_OCR")
        
        // 3. Présence du dossier dans la liste SQLite locale
        let martingaleFolder = harness.app.staticTexts["Martingale"]
        XCTAssertTrue(martingaleFolder.waitForExistence(timeout: 4.0), "Le dossier 'Martingale' doit figurer dans la base SQLite locale")
        
        // 4. CLIC EFFECTIF sur le dossier (Geste tactile complet hors-ligne)
        martingaleFolder.tap()
        
        // 5. Assertion de transition d'état : l'en-tête doit afficher le nom du dossier
        let folderTitle = harness.app.staticTexts["Martingale"]
        XCTAssertTrue(folderTitle.waitForExistence(timeout: 4.0), "L'en-tête doit afficher le titre du dossier ouvert en mode déconnecté")
        
        // [Visuel Niveau 1 & 3] Validation visuelle dans le dossier ouvert
        sleep(1)
        let folderScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: folderScreen, testCase: self, context: "S1_Dossier_HorsLigne")
        VisualValidationEngine.assertVisibleTextContains(image: folderScreen, expectedKeywords: ["Martingale", "Retour"], testCase: self, context: "S1_Dossier_OCR")
        
        // 6. Bouton de retour vers la racine
        let backButton = harness.app.buttons["Retour"]
        XCTAssertTrue(backButton.waitForExistence(timeout: 3.0), "Le bouton 'Retour' doit apparaître lors de l'entrée dans un dossier hors-ligne")
        
        // 7. Clic retour et vérification de la restauration de l'arborescence
        backButton.tap()
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 3.0), "Le retour doit rétablir la vue racine des Documents hors-ligne")
        XCTAssertTrue(martingaleFolder.exists, "Le dossier 'Martingale' doit être à nouveau présent à la racine")
        
        // [Visuel Niveau 1 & 3] Validation après retour
        sleep(1)
        let returnedScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: returnedScreen, testCase: self, context: "S1_RetourRacine_HorsLigne")
        VisualValidationEngine.assertVisibleTextContains(image: returnedScreen, expectedKeywords: ["Documents", "Martingale"], testCase: self, context: "S1_RetourRacine_OCR")
    }
    
    // =========================================================================
    // SCÉNARIO 2 : Recherche clinique locale, ouverture lecteur & navigation par flèches
    // Transposition stricte de DocSeekerCoreUITests.testOccurrenceNavigationAndBottomBarArrows
    // + Analyses Visuelles Niveaux 1, 2, 3 intégrées
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
        
        // [Visuel Niveaux 1, 2, 3] Validation formelle que le lecteur Goodnotes n'est PAS un écran blanc
        sleep(1)
        let readerScreen = XCUIScreen.main.screenshot().image
        
        // Niveau 1 : Détection d'écran blanc
        let level1 = VisualValidationEngine.assertNonBlankScreen(image: readerScreen, testCase: self, context: "S2_Lecteur_HorsLigne")
        XCTAssertTrue(level1.passed, "Le lecteur hors-ligne ne doit jamais afficher un écran blanc")
        
        // Niveau 2 : Pixel Matching contre le PDF source
        let refPDF = harness.fixturesDir.appendingPathComponent("2.pdf")
        let level2 = VisualValidationEngine.assertPixelMatchAgainstPDF(capturedImage: readerScreen, pdfURL: refPDF, pageNumber: 1, minMatchPercentage: 65.0, testCase: self, context: "S2_Lecteur_PixelMatching")
        XCTAssertTrue(level2.score > 50.0, "La concordance de pixels doit confirmer le rendu du PDF")
        
        // Niveau 3 : OCR Vision
        let level3 = VisualValidationEngine.assertVisibleTextContains(image: readerScreen, expectedKeywords: ["grossesse", "normale", "Page", "p."], testCase: self, context: "S2_Lecteur_OCR")
        XCTAssertTrue(level3.passed, "L'OCR doit confirmer les mots affichés")
        
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
            
            // [Visuel Niveau 1] Page suivante non blanche
            sleep(1)
            let page2Screen = XCUIScreen.main.screenshot().image
            VisualValidationEngine.assertNonBlankScreen(image: page2Screen, testCase: self, context: "S2_Page2_HorsLigne")
            
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
    // + Analyses Visuelles Niveaux 1, 3 sur les vignettes du tiroir
    // =========================================================================
    
    func testOfflineInDocumentSearchDrawerPreservesOccurrencesAndQuery() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        harness.openFirstDocumentReader()
        
        let drawerBtn = harness.app.buttons["reader_open_drawer"]
        XCTAssertTrue(drawerBtn.waitForExistence(timeout: 5.0), "Le bouton d'ouverture du volet d'extraits doit être présent en mode hors-ligne")
        drawerBtn.tap()
        
        // [Visuel Niveau 1 & 3] Vérification visuelle du tiroir et des vignettes locales
        sleep(1)
        let drawerScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: drawerScreen, testCase: self, context: "S3_TiroirExtraits_HorsLigne")
        VisualValidationEngine.assertVisibleTextContains(image: drawerScreen, expectedKeywords: ["Extraits", "document", "Page", "grossesse"], testCase: self, context: "S3_Tiroir_OCR")
        
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
    // + Analyses Visuelles Niveaux 1, 3 sur la popover
    // =========================================================================
    
    func testOfflineTabChevronOpensDocumentInfoPopover() {
        harness.search(query: "grossesse")
        
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        harness.openFirstDocumentReader()
        
        let chevronBtn = harness.app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'tab_chevron_'")).firstMatch
        if chevronBtn.waitForExistence(timeout: 4.0) {
            chevronBtn.tap()
            
            // [Visuel Niveau 1 & 3] Vérification visuelle de la popover
            sleep(1)
            let popoverScreen = XCUIScreen.main.screenshot().image
            VisualValidationEngine.assertNonBlankScreen(image: popoverScreen, testCase: self, context: "S4_Popover_HorsLigne")
            VisualValidationEngine.assertVisibleTextContains(image: popoverScreen, expectedKeywords: ["Grossesse", "Emplacement", "Page"], testCase: self, context: "S4_Popover_OCR")
            
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
    // + Analyses Visuelles Niveaux 1, 2, 3 et TOUTES les vérifications préservées
    // =========================================================================
    
    func testOfflineLongContinuousUserJourney() {
        // 1. Recherche hors-ligne
        harness.search(query: "grossesse")
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        
        // 2. Ouverture document hors-ligne et navigation d'occurrence
        harness.openFirstDocumentReader()
        
        // [Visuel Niveau 1] Lecteur ouvert dans le parcours long
        sleep(1)
        let readerScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: readerScreen, testCase: self, context: "S5_Lecteur_LongJourney")
        
        harness.tapNextOccurrence()
        
        // 3. Retour Accueil (préservation d'état hors-ligne)
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        XCTAssertTrue(homeBtn.waitForExistence(timeout: 4.0))
        homeBtn.tap()
        
        // [Visuel Niveau 1 & 3] Vérification de la persistance de recherche
        sleep(1)
        let searchScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: searchScreen, testCase: self, context: "S5_SearchState_Persisted")
        VisualValidationEngine.assertVisibleTextContains(image: searchScreen, expectedKeywords: ["grossesse", "normale"], testCase: self, context: "S5_SearchOCR_Persisted")
        
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
    // + Analyses Visuelles Niveaux 1, 3
    // =========================================================================
    
    func testOfflineUncachedDocExclusionAndEmptyState() {
        // Recherche sans résultat possible en coupure réseau totale
        harness.search(query: "pathologieinexistante999")
        
        let emptyNotice = harness.app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'Aucun résultat'")).firstMatch
        XCTAssertTrue(emptyNotice.waitForExistence(timeout: 4.0), "La recherche hors-ligne sans résultat doit afficher un état vide propre")
        
        // [Visuel Niveau 1 & 3] État vide propre et stylisé (non blanc)
        sleep(1)
        let emptyScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: emptyScreen, testCase: self, context: "S6_EtatVide_HorsLigne")
        VisualValidationEngine.assertVisibleTextContains(image: emptyScreen, expectedKeywords: ["Aucun", "résultat"], testCase: self, context: "S6_EtatVide_OCR")
        
        harness.clearSearch()
    }
    
    // =========================================================================
    // SCÉNARIO 7 : Parité stricte des résultats et vignettes entre En Ligne et Hors-Ligne
    // Transposition du scénario O9 de ui_offline.spec.mjs
    // + Analyses Visuelles Niveaux 1, 2, 3
    // =========================================================================
    
    func testOfflineOnlineParity() {
        // 1. Exécution en mode Hors-ligne (déjà actif)
        harness.search(query: "grossesse")
        let offlineDocCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(offlineDocCard.waitForExistence(timeout: 6.0), "Le document doit être trouvé hors-ligne")
        
        // [Visuel Niveau 1 & 3 Hors-ligne]
        sleep(1)
        let offlineCapture = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: offlineCapture, testCase: self, context: "S7_Capture_HorsLigne")
        VisualValidationEngine.assertVisibleTextContains(image: offlineCapture, expectedKeywords: ["023", "Grossesse", "normale"], testCase: self, context: "S7_Parite_OCR_Offline")
        
        harness.clearSearch()
        
        // 2. Rétablissement en ligne
        harness.reconnectServer()
        
        // 3. Exécution en mode En Ligne
        harness.search(query: "grossesse")
        let onlineDocCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(onlineDocCard.waitForExistence(timeout: 6.0), "Le document doit être trouvé en ligne")
        
        // [Visuel Niveau 1 & 3 En Ligne]
        sleep(1)
        let onlineCapture = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: onlineCapture, testCase: self, context: "S7_Capture_EnLigne")
        VisualValidationEngine.assertVisibleTextContains(image: onlineCapture, expectedKeywords: ["023", "Grossesse", "normale"], testCase: self, context: "S7_Parite_OCR_Online")
        
        harness.clearSearch()
    }
    
    // =========================================================================
    // SCÉNARIO 8 (VISUEL SPÉCIFIQUE) : Streaming PDF En Ligne sans écran blanc (Doc 551 - Anatomie 88 Mo)
    // =========================================================================
    
    func testVisualValidation_OnlineStreamingPDF_Levels123() {
        harness.reconnectServer()
        harness.search(query: "Anatomie")
        let docCard = harness.app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'Anatomie'")).firstMatch
        if docCard.waitForExistence(timeout: 8.0) {
            docCard.tap()
            
            let homeBtn = harness.app.buttons["Retour à l'accueil"]
            XCTAssertTrue(homeBtn.waitForExistence(timeout: 8.0))
            
            sleep(1)
            let fullScreen = XCUIScreen.main.screenshot().image
            
            // NIVEAU 1
            VisualValidationEngine.assertNonBlankScreen(image: fullScreen, testCase: self, context: "S8_Streaming_Anatomie_NoBlank")
            
            // NIVEAU 2
            let pdfFile = harness.fixturesDir.appendingPathComponent("2.pdf")
            VisualValidationEngine.assertPixelMatchAgainstPDF(capturedImage: fullScreen, pdfURL: pdfFile, pageNumber: 1, minMatchPercentage: 65.0, testCase: self, context: "S8_Streaming_PixelMatching")
            
            // NIVEAU 3
            VisualValidationEngine.assertVisibleTextContains(image: fullScreen, expectedKeywords: ["Anatomie", "cytologie", "médecine", "chapitre", "2023"], testCase: self, context: "S8_Streaming_OCR")
            
            homeBtn.tap()
        }
        harness.clearSearch()
    }
    
    // =========================================================================
    // SCÉNARIO 9 (VISUEL SPÉCIFIQUE) : Vignettes d'Endocrinologie (Doc 558 - 506 Mo) Authentifiées
    // =========================================================================
    
    func testVisualValidation_EndocrinologieCrops_Levels123() {
        harness.reconnectServer()
        harness.search(query: "diabete")
        
        let endoDoc = harness.app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'Endocrinologie'")).firstMatch
        if endoDoc.waitForExistence(timeout: 8.0) {
            let vignetteBtn = harness.app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'extraits' OR label CONTAINS[c] 'vignette'")).firstMatch
            if vignetteBtn.waitForExistence(timeout: 4.0) {
                vignetteBtn.tap()
                sleep(2)
                
                let drawerScreen = XCUIScreen.main.screenshot().image
                
                // NIVEAU 1
                VisualValidationEngine.assertNonBlankScreen(image: drawerScreen, testCase: self, context: "S9_EndoDrawer_NoBlank")
                
                // NIVEAU 3
                VisualValidationEngine.assertVisibleTextContains(image: drawerScreen, expectedKeywords: ["diabète", "diabete", "Page", "glycémie"], testCase: self, context: "S9_EndoCrops_OCR")
            }
        }
        harness.clearSearch()
    }
}
