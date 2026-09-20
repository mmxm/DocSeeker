// DocSeekerEdgeCasesUITests.swift
// Transposition XCUITest de ui_edge_cases.spec.mjs : Cas limites, requêtes inconnues et dialogues système
// + Analyses Visuelles Multi-Niveaux intégrées (Niveau 1, 3)

import XCTest
import Vision

final class DocSeekerEdgeCasesUITests: XCTestCase {
    var harness: DocSeekerTestHarness!
    
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        harness = DocSeekerTestHarness()
        harness.launch()
    }
    
    // =========================================================================
    // Test M2 : Requête clinique fictive sans correspondance affichant le message dédié
    // + Analyses Visuelles Niveaux 1, 3 sur l'état vide
    // =========================================================================
    func testNonMatchingSearchQuery() {
        let impossibleQuery = "pathologie_fictive_999xyz"
        harness.search(query: impossibleQuery)
        
        let noResultsNotice = harness.app.staticTexts["Aucun résultat pour \"\(impossibleQuery)\""]
        let errorBanner = harness.app.images["exclamationmark.triangle"]
        XCTAssertTrue(noResultsNotice.waitForExistence(timeout: 4.0) || errorBanner.waitForExistence(timeout: 4.0))
        
        // [Visuel Niveau 1] L'état vide ne doit jamais être un écran blanc
        sleep(1)
        let emptyScreen = XCUIScreen.main.screenshot().image
        let l1 = VisualValidationEngine.assertNonBlankScreen(image: emptyScreen, testCase: self, context: "EC_RequêteInexistante_EtatVide")
        XCTAssertTrue(l1.passed, "L'écran d'état vide pour requête inconnue ne doit pas être un écran blanc")
        
        // [Visuel Niveau 3] OCR doit détecter le message d'absence de résultats
        let l3 = VisualValidationEngine.assertVisibleTextContains(
            image: emptyScreen,
            expectedKeywords: ["Aucun", "résultat"],
            testCase: self,
            context: "EC_RequêteInexistante_OCR"
        )
        XCTAssertTrue(l3.passed, "L'OCR doit confirmer l'affichage du message 'Aucun résultat'")
        
        harness.clearSearch()
    }
    
    // =========================================================================
    // Test M5 : Arborescence des dossiers et navigation Goodnotes
    // + Analyses Visuelles Niveaux 1, 3
    // =========================================================================
    func testFoldersNavigationAndSelection() {
        harness.switchTab("Documents")
        
        let docsTitle = harness.app.staticTexts["Documents"]
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 3.0))
        
        // [Visuel Niveau 1 & 3] Vue racine
        sleep(1)
        let rootScreen = XCUIScreen.main.screenshot().image
        let l1Root = VisualValidationEngine.assertNonBlankScreen(image: rootScreen, testCase: self, context: "EC_Arborescence_Racine")
        XCTAssertTrue(l1Root.passed, "L'écran de l'arborescence racine ne doit pas être blanc")
        VisualValidationEngine.assertVisibleTextContains(image: rootScreen, expectedKeywords: ["Documents"], testCase: self, context: "EC_Arborescence_OCR")
        
        // Navigation dans le premier dossier s'il existe
        let folderButton = harness.app.buttons.matching(NSPredicate(format: "label CONTAINS 'Martingale' OR label CONTAINS 'Test'")).firstMatch
        if folderButton.waitForExistence(timeout: 3.0) {
            folderButton.tap()
            
            // [Visuel Niveau 1 & 3] Dans le dossier
            sleep(1)
            let folderScreen = XCUIScreen.main.screenshot().image
            let l1Folder = VisualValidationEngine.assertNonBlankScreen(image: folderScreen, testCase: self, context: "EC_DossierIntérieur")
            XCTAssertTrue(l1Folder.passed, "Le contenu du dossier ne doit pas être blanc")
            VisualValidationEngine.assertVisibleTextContains(image: folderScreen, expectedKeywords: ["Retour"], testCase: self, context: "EC_DossierIntérieur_OCR")
            
            // Retour en arrière
            let backButton = harness.app.buttons["Retour"]
            if backButton.waitForExistence(timeout: 3.0) {
                backButton.tap()
                
                // [Visuel Niveau 1] Après retour
                sleep(1)
                let afterBackScreen = XCUIScreen.main.screenshot().image
                VisualValidationEngine.assertNonBlankScreen(image: afterBackScreen, testCase: self, context: "EC_AprèsRetourDossier")
            }
        }
    }
    
    // =========================================================================
    // Test M6 : Dialogue de confirmation de vidage du cache
    // + Analyses Visuelles Niveaux 1, 3 sur le dialogue
    // =========================================================================
    func testClearCacheConfirmationDialog() {
        harness.switchTab("Réglages")
        
        // [Visuel Niveau 1 & 3] Écran des réglages
        sleep(1)
        let settingsScreen = XCUIScreen.main.screenshot().image
        let l1Settings = VisualValidationEngine.assertNonBlankScreen(image: settingsScreen, testCase: self, context: "EC_Réglages_Ouvert")
        XCTAssertTrue(l1Settings.passed, "L'écran des réglages ne doit pas être blanc")
        VisualValidationEngine.assertVisibleTextContains(image: settingsScreen, expectedKeywords: ["Réglages", "Serveur", "Réseau"], testCase: self, context: "EC_Réglages_OCR")
        
        harness.app.swipeUp()
        
        let clearButton = harness.app.buttons["Vider le cache hors-ligne"]
        if clearButton.waitForExistence(timeout: 3.0) {
            clearButton.tap()
            
            // [Visuel Niveau 1 & 3] Dialogue de confirmation
            sleep(1)
            let dialogScreen = XCUIScreen.main.screenshot().image
            let l1Dialog = VisualValidationEngine.assertNonBlankScreen(image: dialogScreen, testCase: self, context: "EC_DialogueConfirmationCache")
            XCTAssertTrue(l1Dialog.passed, "Le dialogue de confirmation de cache ne doit pas être blanc")
            VisualValidationEngine.assertVisibleTextContains(
                image: dialogScreen,
                expectedKeywords: ["Annuler", "cache", "vider", "hors-ligne"],
                testCase: self,
                context: "EC_Dialogue_OCR"
            )
            
            let cancelBtn = harness.app.buttons["Annuler"]
            if cancelBtn.waitForExistence(timeout: 2.0) {
                cancelBtn.tap()
                
                // [Visuel Niveau 1] Retour aux réglages après annulation
                sleep(1)
                let afterCancelScreen = XCUIScreen.main.screenshot().image
                VisualValidationEngine.assertNonBlankScreen(image: afterCancelScreen, testCase: self, context: "EC_AprèsAnnulationCache")
            }
        }
        
        harness.switchTab("Documents")
    }
    
    // =========================================================================
    // Test M7 : Robustesse de l'indicateur de statut réseau
    // + Analyses Visuelles Niveau 1, 3 sur la visibilité de l'indicateur
    // =========================================================================
    func testNetworkStatusIndicatorVisibility() {
        harness.switchTab("Documents")
        
        // [Visuel Niveau 1] Vue principale non blanche
        sleep(1)
        let mainScreen = XCUIScreen.main.screenshot().image
        let l1 = VisualValidationEngine.assertNonBlankScreen(image: mainScreen, testCase: self, context: "EC_IndicateurRéseau_Visible")
        XCTAssertTrue(l1.passed, "L'écran principal avec indicateur réseau ne doit pas être blanc")
        
        // Vérifier la présence de l'indicateur réseau
        let networkIndicator = harness.app.descendants(matching: .any)["network_status_indicator"]
        let hasIndicator = networkIndicator.waitForExistence(timeout: 3.0)
        
        if hasIndicator {
            // [Visuel Niveau 3] OCR sur le badge réseau
            let indicatorScreen = XCUIScreen.main.screenshot().image
            VisualValidationEngine.assertVisibleTextContains(
                image: indicatorScreen,
                expectedKeywords: ["En ligne", "Hors-ligne", "Connecté"],
                testCase: self,
                context: "EC_IndicateurRéseau_OCR"
            )
        }
        
        // [Visuel Niveau 3] L'UI complète doit toujours avoir du contenu
        VisualValidationEngine.assertVisibleTextContains(
            image: mainScreen,
            expectedKeywords: ["Documents"],
            testCase: self,
            context: "EC_UI_Principale_OCR"
        )
    }
}
