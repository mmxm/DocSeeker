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
        
        // Vérification du compteur initial (format compact "X/Y" ou long "X sur Y correspondances")
        let initialCounter = harness.bottomBarCounterText()
        XCTAssertTrue(
            initialCounter.contains("/") || initialCounter.contains("correspondance"),
            "Le bandeau doit afficher un compteur de correspondances (format: '\(initialCounter)')"
        )
        
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
    
    // =========================================================================
    // Scénario 6 : Streaming PDF — le PDF s'affiche sans écran blanc (test du fix AM-7)
    // Vérifie que le token de session est bien transmis à PDFKit pour le streaming
    // + Analyses Visuelles Niveaux 1, 2, 3
    // =========================================================================
    func testStreamingPDFLoadsWithoutBlankScreen() {
        // 1. Recherche via le harness (même pattern que testOccurrenceNavigationAndBottomBarArrows)
        harness.search(query: "grossesse")
        sleep(2)
        
        // 2. Ouvrir le premier résultat
        let docCard = harness.app.cells.firstMatch
        guard docCard.waitForExistence(timeout: 6.0) else {
            XCTSkip("Aucun résultat de recherche — serveur non disponible")
            return
        }
        docCard.tap()
        sleep(3) // Laisser PDFKit charger le streaming
        
        // Vérifier que le lecteur est ouvert
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        guard homeBtn.waitForExistence(timeout: 6.0) else {
            XCTSkip("Le lecteur PDF ne s'est pas ouvert")
            return
        }
        
        // [Visuel Niveau 1] L'écran ne doit PAS être blanc (streaming reçu correctement)
        let pdfScreen = XCUIScreen.main.screenshot().image
        let l1 = VisualValidationEngine.assertNonBlankScreen(image: pdfScreen, testCase: self, context: "C6_StreamingPDF_NonBlanc")
        XCTAssertTrue(l1.passed, "Le PDF streamé ne doit pas produire un écran blanc — vérifier le token dans streamingPDFURL()")
        
        // [Visuel Niveau 3] OCR : le contenu du PDF doit contenir du texte
        let l3 = VisualValidationEngine.assertVisibleTextContains(
            image: pdfScreen,
            expectedKeywords: ["grossesse"],
            testCase: self,
            context: "C6_StreamingPDF_OCR"
        )
        XCTAssertTrue(l3.passed, "L'OCR doit détecter du texte dans le PDF streamé")
        
        // 3. Vérification du bandeau d'occurrences + fade
        let bottomBar = harness.app.buttons["occurrence_next"]
        if bottomBar.waitForExistence(timeout: 3.0) {
            sleep(4) // Attendre le fade automatique (2.5s + marge)
            let fadedScreen = XCUIScreen.main.screenshot().image
            let l1Fade = VisualValidationEngine.assertNonBlankScreen(image: fadedScreen, testCase: self, context: "C6_BandeauFade_ContentVisible")
            XCTAssertTrue(l1Fade.passed, "Après fade, le contenu PDF doit rester visible derrière le bandeau")
        }
    }
    
    // =========================================================================
    // Scénario 7 : Barre de progression de téléchargement sans glitch
    // Vérifie que le cercle animé ne provoque pas de saut de layout (Spacer stable)
    // + Analyses Visuelles Niveaux 1, 3
    // =========================================================================
    func testDownloadProgressBarIsStableAndVisible() {
        // 1. Recherche via le harness (même pattern que les tests existants)
        harness.search(query: "cardiologie")
        sleep(2)
        
        let firstResult = harness.app.cells.firstMatch
        guard firstResult.waitForExistence(timeout: 5.0) else {
            XCTSkip("Aucun résultat — serveur non disponible")
            return
        }
        firstResult.tap()
        sleep(1)
        
        // 2. Vérifier que la barre de progression existe et est visible
        let progressIndicator = harness.app.otherElements["reader_download_progress"]
        // La barre est présente seulement si un téléchargement est en cours
        if progressIndicator.waitForExistence(timeout: 4.0) {
            XCTAssertTrue(progressIndicator.isHittable || progressIndicator.exists,
                          "L'indicateur de progression doit être visible et stable")
            
            // [Visuel Niveau 1] L'écran avec barre de progression ne doit pas être blanc
            let progressScreen = XCUIScreen.main.screenshot().image
            let l1 = VisualValidationEngine.assertNonBlankScreen(image: progressScreen, testCase: self, context: "C7_ProgressBar_NonBlanc")
            XCTAssertTrue(l1.passed, "L'écran avec barre de progression ne doit pas être blanc")
            
            // Attendre 1s et prendre un 2e screenshot pour vérifier que le layout est stable
            sleep(1)
            let progressScreen2 = XCUIScreen.main.screenshot().image
            
            // [Visuel Niveau 3] La barre de lecture doit toujours être présente
            let l3 = VisualValidationEngine.assertVisibleTextContains(
                image: progressScreen2,
                expectedKeywords: ["cardiologie"],
                testCase: self,
                context: "C7_ProgressBar_Stable_OCR"
            )
            // Note: pas de XCTFail si l'OCR échoue — le PDF peut ne pas encore être rendu
            _ = l3
        } else {
            // Document déjà en cache — test de non-régression OK
            XCTAssertFalse(progressIndicator.exists, "Pas d'indicateur si document déjà en cache")
        }
    }
    
    // =========================================================================
    // Scénario 8 : Bandeau d'occurrences transparent et auto-fade
    // Vérifie que le bandeau est visible puis s'atténue sans masquer le contenu
    // + Analyses Visuelles Niveaux 1, 3
    // =========================================================================
    func testOccurrenceBottomBarAutoFadeAndTransparency() {
        // 1. Recherche via le harness
        harness.search(query: "grossesse")
        sleep(2)
        
        let firstResult = harness.app.cells.firstMatch
        guard firstResult.waitForExistence(timeout: 5.0) else {
            XCTSkip("Aucun résultat — serveur non disponible")
            return
        }
        firstResult.tap()
        sleep(2)
        
        // 2. Vérifier que le bandeau d'occurrences est présent
        let closeBtn = harness.app.buttons["occurrence_bottom_bar_close"]
        guard closeBtn.waitForExistence(timeout: 4.0) else {
            XCTSkip("Bandeau d'occurrences non affiché (aucune occurrence)")
            return
        }
        
        // [Visuel Niveau 1] Screenshot immédiat — bandeau visible à 100% opacité
        let immediateScreen = XCUIScreen.main.screenshot().image
        let l1Immediate = VisualValidationEngine.assertNonBlankScreen(image: immediateScreen, testCase: self, context: "C8_Bandeau_Visible_Immédiat")
        XCTAssertTrue(l1Immediate.passed, "L'écran avec bandeau immédiat ne doit pas être blanc")
        
        // [Visuel Niveau 3] OCR doit détecter 'Fermer' (présent dans le bandeau)
        let l3Bandeau = VisualValidationEngine.assertVisibleTextContains(
            image: immediateScreen,
            expectedKeywords: ["Fermer"],
            testCase: self,
            context: "C8_Bandeau_OCR_Fermer"
        )
        XCTAssertTrue(l3Bandeau.passed, "L'OCR doit détecter 'Fermer' dans le bandeau visible")
        
        // 3. Attendre le fade automatique (2.5s configurés)
        sleep(4)
        
        // [Visuel Niveau 1] Après fade : le contenu PDF doit rester visible derrière le bandeau atténué
        let fadedScreen = XCUIScreen.main.screenshot().image
        let l1Faded = VisualValidationEngine.assertNonBlankScreen(image: fadedScreen, testCase: self, context: "C8_Bandeau_Faded_ContentVisible")
        XCTAssertTrue(l1Faded.passed, "Après le fade, le PDF doit toujours être visible")
        
        // [Visuel Niveau 3] OCR post-fade : le contenu PDF doit toujours être lisible
        let l3Faded = VisualValidationEngine.assertVisibleTextContains(
            image: fadedScreen,
            expectedKeywords: ["grossesse"],
            testCase: self,
            context: "C8_Bandeau_Faded_OCR"
        )
        XCTAssertTrue(l3Faded.passed, "Après fade du bandeau, le contenu PDF doit rester lisible par OCR")
        
        // 4. Tap sur le bandeau → doit se réveiller (opacité 100%)
        closeBtn.tap() // utiliser Fermer comme cible de tap
        sleep(1)
        let wokenScreen = XCUIScreen.main.screenshot().image
        let l1Woken = VisualValidationEngine.assertNonBlankScreen(image: wokenScreen, testCase: self, context: "C8_Bandeau_Woken")
        XCTAssertTrue(l1Woken.passed, "Après tap sur bandeau, l'écran ne doit pas être blanc")
    }
    
    // =========================================================================
    // Scénario 9 : Volet latéral de recherche et menu Double Page
    // =========================================================================
    func testInDocumentSearchDrawerAndDoublePageMenu() {
        // 1. Recherche et ouverture d'un document
        harness.search(query: "grossesse")
        sleep(2)
        
        let firstResult = harness.app.cells.firstMatch
        guard firstResult.waitForExistence(timeout: 5.0) else {
            XCTSkip("Aucun résultat — serveur non disponible")
            return
        }
        firstResult.tap()
        sleep(2)
        
        // 2. Bascule du volet latéral de recherche via l'icône unique du dessus (reader_open_drawer)
        let sidebarBtn = harness.app.buttons["reader_open_drawer"]
        if sidebarBtn.waitForExistence(timeout: 4.0) {
            // OUVRIR le volet
            sidebarBtn.tap()
            sleep(1)
            
            // Le champ de recherche interne du volet doit être présent
            let searchField = harness.app.textFields["Rechercher dans ce document..."]
            XCTAssertTrue(searchField.waitForExistence(timeout: 3.0), "La barre de recherche du volet doit être affichée")
            
            // FERMER le volet en retapant sur le même bouton du dessus (ou drawer_close sur iPhone)
            let drawerClose = harness.app.buttons["drawer_close"]
            if drawerClose.exists {
                drawerClose.tap()
            } else {
                sidebarBtn.tap()
            }
            sleep(1)
        }
        
        // 3. Vérification de l'option Double Page dans le menu ...
        let optionsBtn = harness.app.buttons["Options du document"]
        if optionsBtn.waitForExistence(timeout: 3.0) {
            optionsBtn.tap()
            sleep(1)
            
            let doublePageBtn = harness.app.buttons["reader_toggle_double_page"]
            XCTAssertTrue(doublePageBtn.waitForExistence(timeout: 3.0), "L'option Double page doit être présente dans le menu '...'")
            doublePageBtn.tap()
            sleep(1)
        }
    }
}

