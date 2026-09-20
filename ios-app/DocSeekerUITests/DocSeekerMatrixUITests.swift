// DocSeekerMatrixUITests.swift
// Matrice de tests UI standardisés reproduisant l'architecture Playwright (ui_stress_matrix.spec.mjs)
// avec recherche clinique réelle, ouverture de vrais PDF médicaux, synchronisation et interruption/reprise réseau
// + Analyses Visuelles Multi-Niveaux intégrées (Niveau 1, 2, 3) à chaque scénario

import XCTest
import Vision

struct SearchScenario {
    let name: String
    let query: String
    let expectedNotice: String?
}

final class DocSeekerMatrixUITests: XCTestCase {
    var harness: DocSeekerTestHarness!
    
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        harness = DocSeekerTestHarness()
        harness.launch()
    }
    
    // =========================================================================
    // MATRICE 1 : Enchaînement complet d'actions sur un VRAI PDF médical (023 - Grossesse normale)
    // + Analyses Visuelles Niveaux 1, 2, 3
    // =========================================================================
    
    func testMatrix1_ActionChainingSearchToRealisticPDFReader() {
        harness
            .search(query: "grossesse")
            .openFirstDocumentReader()
        
        // [Visuel Niveau 1] Le lecteur ne doit pas être blanc
        sleep(2)
        let readerScreen = XCUIScreen.main.screenshot().image
        let l1 = VisualValidationEngine.assertNonBlankScreen(image: readerScreen, testCase: self, context: "M1_LecteurPDF_Ouvert")
        XCTAssertTrue(l1.passed, "Le lecteur PDF ouvert via recherche ne doit pas afficher un écran blanc")
        
        // [Visuel Niveau 2] Pixel matching contre le PDF de référence
        if let pdfURL = harness.fixturePDFURL(named: "2") {
            let l2 = VisualValidationEngine.assertPixelMatchAgainstPDF(
                capturedImage: readerScreen,
                pdfURL: pdfURL,
                pageNumber: 1,
                minMatchPercentage: 60.0,
                testCase: self,
                context: "M1_LecteurPDF_PixelMatch"
            )
            XCTAssertTrue(l2.score > 45.0, "La correspondance de pixels doit confirmer un rendu PDF réel (score: \(l2.score)%)")
        }
        
        // [Visuel Niveau 3] OCR doit détecter du contenu médical
        let l3 = VisualValidationEngine.assertVisibleTextContains(
            image: readerScreen,
            expectedKeywords: ["grossesse", "Grossesse", "normale", "023"],
            testCase: self,
            context: "M1_LecteurPDF_OCR"
        )
        XCTAssertTrue(l3.passed, "L'OCR doit reconnaître du contenu médical dans le lecteur PDF")
        
        // Si le lecteur s'ouvre avec le vrai PDF
        let closeBtn = harness.app.buttons["Fermer"]
        if closeBtn.waitForExistence(timeout: 4.0) {
            harness
                .verifyPDFReaderActive()
                .closePDFReader()
        } else {
            let homeBtn = harness.app.buttons["Retour à l'accueil"]
            if homeBtn.waitForExistence(timeout: 3.0) { homeBtn.tap() }
        }
        
        // Nettoyage de la barre de recherche
        harness.clearSearch()
    }
    
    // =========================================================================
    // MATRICE 2 : Tiroir d'occurrences et tri sur terme clinique réel ('toxoplasmose')
    // + Analyses Visuelles Niveaux 1, 3
    // =========================================================================
    
    func testMatrix2_OccurrenceDrawerAndSortingOnRealisticPDF() {
        harness.search(query: "toxoplasmose")
        
        // [Visuel Niveau 1 & 3] Résultats de recherche toxoplasmose
        sleep(1)
        let searchScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: searchScreen, testCase: self, context: "M2_ResultatsToxoplasmose")
        VisualValidationEngine.assertVisibleTextContains(image: searchScreen, expectedKeywords: ["toxoplasmose"], testCase: self, context: "M2_ResultatsToxoplasmose_OCR")
        
        let occButton = harness.app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Occurrences'")).firstMatch
        if occButton.exists {
            harness
                .openFirstOccurrenceDrawer()
                .switchOccurrenceSortOrder(to: "Ordre de page")
                .switchOccurrenceSortOrder(to: "Pertinence")
                .closeOccurrenceDrawer()
        } else {
            // Dans le style Goodnotes, un clic sur la carte ouvre le lecteur puis le volet d'extraits
            harness.openFirstDocumentReader()
            
            // [Visuel Niveau 1] Lecteur ouvert
            sleep(1)
            let lScreen = XCUIScreen.main.screenshot().image
            VisualValidationEngine.assertNonBlankScreen(image: lScreen, testCase: self, context: "M2_LecteurToxoplasmose")
            
            let sidebarBtn = harness.app.buttons["sidebar.left"]
            if sidebarBtn.waitForExistence(timeout: 4.0) {
                sidebarBtn.tap()
                
                // [Visuel Niveau 1 & 3] Volet latéral ouvert
                sleep(1)
                let drawerScreen = XCUIScreen.main.screenshot().image
                VisualValidationEngine.assertNonBlankScreen(image: drawerScreen, testCase: self, context: "M2_TiroirToxoplasmose")
                VisualValidationEngine.assertVisibleTextContains(image: drawerScreen, expectedKeywords: ["toxoplasmose", "Extraits"], testCase: self, context: "M2_TiroirToxoplasmose_OCR")
                
                let closeBtn = harness.app.buttons.matching(identifier: "drawer_close").firstMatch
                if closeBtn.waitForExistence(timeout: 3.0) {
                    closeBtn.tap()
                }
            }
            harness.closePDFReader()
        }
        
        harness.clearSearch()
    }
    
    // =========================================================================
    // MATRICE 3 : Matrice paramétrée de recherches cliniques réelles
    // + Analyses Visuelles Niveau 1 & 3 pour chaque requête
    // =========================================================================
    
    func testMatrix3_RealisticClinicalSearchQueries() {
        let scenarios = [
            SearchScenario(name: "Recherche Clinique Standard", query: "grossesse", expectedNotice: nil),
            SearchScenario(name: "Recherche avec Accents", query: "échographie", expectedNotice: nil),
            SearchScenario(name: "Recherche Pathologie", query: "diabète", expectedNotice: nil),
            SearchScenario(name: "Recherche Thérapeutique", query: "insuline", expectedNotice: nil),
            SearchScenario(name: "Recherche Inexistante", query: "pathologieinexistante999", expectedNotice: "Aucun résultat"),
        ]
        
        for scenario in scenarios {
            harness.search(query: scenario.query)
            
            // [Visuel Niveau 1] Chaque écran de résultat non blanc
            sleep(1)
            let resultScreen = XCUIScreen.main.screenshot().image
            let l1 = VisualValidationEngine.assertNonBlankScreen(
                image: resultScreen,
                testCase: self,
                context: "M3_Scénario_\(scenario.name.replacingOccurrences(of: " ", with: "_"))"
            )
            XCTAssertTrue(l1.passed, "[\(scenario.name)] L'écran de résultats ne doit pas être blanc")
            
            // [Visuel Niveau 3] OCR pour chaque scénario
            if let notice = scenario.expectedNotice {
                // Scénario résultat vide : OCR doit détecter le message d'état vide
                VisualValidationEngine.assertVisibleTextContains(
                    image: resultScreen,
                    expectedKeywords: [notice, "Aucun"],
                    testCase: self,
                    context: "M3_Scénario_\(scenario.name.replacingOccurrences(of: " ", with: "_"))_OCR"
                )
                
                let noticeElement = harness.app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", notice)).firstMatch
                let errorBanner = harness.app.images["exclamationmark.triangle"]
                XCTAssertTrue(
                    noticeElement.waitForExistence(timeout: 3.0) || errorBanner.waitForExistence(timeout: 3.0),
                    "Scénario '\(scenario.name)' doit afficher la notice attendue"
                )
            } else {
                // Scénario avec résultats : OCR doit détecter le terme recherché
                VisualValidationEngine.assertVisibleTextContains(
                    image: resultScreen,
                    expectedKeywords: [scenario.query],
                    testCase: self,
                    context: "M3_Scénario_\(scenario.name.replacingOccurrences(of: " ", with: "_"))_OCR"
                )
            }
            
            harness.clearSearch()
        }
    }
    
    // =========================================================================
    // MATRICE 4 : Synchronisation des dossiers et arborescence
    // + Analyses Visuelles Niveaux 1, 3
    // =========================================================================
    
    func testMatrix4_FolderSynchronizationAndCacheState() {
        harness.switchTab("Documents")
        
        // [Visuel Niveau 1] Arborescence visible
        sleep(1)
        let arboScreen = XCUIScreen.main.screenshot().image
        let l1 = VisualValidationEngine.assertNonBlankScreen(image: arboScreen, testCase: self, context: "M4_Arborescence")
        XCTAssertTrue(l1.passed, "L'arborescence des documents ne doit pas être blanche")
        
        // [Visuel Niveau 3] OCR doit détecter le titre principal
        VisualValidationEngine.assertVisibleTextContains(
            image: arboScreen,
            expectedKeywords: ["Documents"],
            testCase: self,
            context: "M4_Arborescence_OCR"
        )
        
        // Déclencher ou vérifier le bouton de synchronisation
        let syncButton = harness.app.buttons["Synchroniser"]
        if syncButton.waitForExistence(timeout: 2.0) {
            syncButton.tap()
            
            // [Visuel Niveau 1] Vérifier que la synchronisation ne blanche pas l'écran
            sleep(1)
            let syncScreen = XCUIScreen.main.screenshot().image
            VisualValidationEngine.assertNonBlankScreen(image: syncScreen, testCase: self, context: "M4_PendantSync")
        }
    }
    
    // =========================================================================
    // MATRICE 5 : Interruption et Reprise Réseau (Coupure réelle OS)
    // + Analyses Visuelles Niveaux 1, 3 avant et après interruption
    // =========================================================================
    
    func testMatrix5_NetworkInterruptionAndResumeFlow() {
        // 1. Recherche initiale en ligne
        harness.search(query: "grossesse")
        
        // [Visuel Niveau 1 & 3] Résultats en ligne
        sleep(1)
        let onlineScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: onlineScreen, testCase: self, context: "M5_EnLigne_Avant")
        VisualValidationEngine.assertVisibleTextContains(image: onlineScreen, expectedKeywords: ["grossesse"], testCase: self, context: "M5_EnLigne_OCR")
        
        // 2. Interruption du réseau (coupure réelle serveur - gérée au niveau OS par l'orchestrateur)
        harness.disconnectServer()
        harness.switchTab("Documents")
        
        // [Visuel Niveau 1] L'arborescence locale reste accessible
        sleep(1)
        let offlineScreen = XCUIScreen.main.screenshot().image
        let l1Offline = VisualValidationEngine.assertNonBlankScreen(image: offlineScreen, testCase: self, context: "M5_HorsLigne_Arborescence")
        XCTAssertTrue(l1Offline.passed, "L'arborescence doit rester visible hors-ligne (données SQLite locales)")
        
        // 3. Vérifier que la recherche fonctionne en local hors-ligne
        harness.search(query: "toxoplasmose")
        
        // [Visuel Niveau 1] Résultats locaux non blancs
        sleep(1)
        let localSearchScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: localSearchScreen, testCase: self, context: "M5_RechercheLocale_HorsLigne")
        
        // 4. Rétablissement du réseau (reprise transparente)
        harness.reconnectServer()
        harness.switchTab("Documents")
        
        // [Visuel Niveau 1 & 3] Retour en ligne
        sleep(2)
        let returnOnlineScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: returnOnlineScreen, testCase: self, context: "M5_EnLigne_Après")
        VisualValidationEngine.assertVisibleTextContains(image: returnOnlineScreen, expectedKeywords: ["Documents"], testCase: self, context: "M5_EnLigne_Après_OCR")
        
        harness.clearSearch()
    }
    
    // =========================================================================
    // MATRICE 6 : Cycle de vie des thèmes (Clair par défaut, Sombre, Système)
    // + Analyses Visuelles Niveau 1 & 2 pour chaque thème
    // =========================================================================
    
    func testMatrix6_ThemeSwitching() {
        // Capture baseline en thème clair
        harness.switchTab("Documents")
        sleep(1)
        let lightThemeScreen = XCUIScreen.main.screenshot().image
        VisualValidationEngine.assertNonBlankScreen(image: lightThemeScreen, testCase: self, context: "M6_ThemeClair_Baseline")
        
        // Passage au thème sombre
        harness.setAppTheme("Sombre")
        sleep(1)
        let darkThemeScreen = XCUIScreen.main.screenshot().image
        let l1Dark = VisualValidationEngine.assertNonBlankScreen(image: darkThemeScreen, testCase: self, context: "M6_ThemeSombre")
        XCTAssertTrue(l1Dark.passed, "Le thème sombre ne doit pas afficher un écran blanc")
        
        // [Visuel Niveau 3] OCR en thème sombre
        VisualValidationEngine.assertVisibleTextContains(image: darkThemeScreen, expectedKeywords: ["Documents", "Réglages"], testCase: self, context: "M6_ThemeSombre_OCR")
        
        // Retour au thème clair
        harness.setAppTheme("Clair")
        sleep(1)
        let restoredScreen = XCUIScreen.main.screenshot().image
        let l1Restored = VisualValidationEngine.assertNonBlankScreen(image: restoredScreen, testCase: self, context: "M6_ThemeClair_Restauré")
        XCTAssertTrue(l1Restored.passed, "Après restauration du thème clair, l'écran ne doit pas être blanc")
    }
}
