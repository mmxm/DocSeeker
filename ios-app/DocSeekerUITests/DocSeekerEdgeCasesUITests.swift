// DocSeekerEdgeCasesUITests.swift
// Transposition XCUITest de ui_edge_cases.spec.mjs : Cas limites, requêtes inconnues et dialogues système

import XCTest

final class DocSeekerEdgeCasesUITests: XCTestCase {
    var harness: DocSeekerTestHarness!
    
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        harness = DocSeekerTestHarness()
        harness.launch()
    }
    
    /// Test M2 : Requête clinique fictive sans correspondance affichant le message dédié
    func testNonMatchingSearchQuery() {
        let impossibleQuery = "pathologie_fictive_999xyz"
        harness.search(query: impossibleQuery)
        
        let noResultsNotice = harness.app.staticTexts["Aucun résultat pour \"\(impossibleQuery)\""]
        let errorBanner = harness.app.images["exclamationmark.triangle"]
        XCTAssertTrue(noResultsNotice.waitForExistence(timeout: 4.0) || errorBanner.waitForExistence(timeout: 4.0))
        
        harness.clearSearch()
    }
    
    /// Test M5 : Arborescence des dossiers et navigation Goodnotes
    func testFoldersNavigationAndSelection() {
        harness.switchTab("Documents")
        
        let docsTitle = harness.app.staticTexts["Documents"]
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 3.0))
        
        // Navigation dans le premier dossier s'il existe
        let folderButton = harness.app.buttons.matching(NSPredicate(format: "label CONTAINS 'Martingale' OR label CONTAINS 'Test'")).firstMatch
        if folderButton.waitForExistence(timeout: 3.0) {
            folderButton.tap()
            // Retour en arrière
            let backButton = harness.app.buttons["Retour"]
            if backButton.waitForExistence(timeout: 3.0) {
                backButton.tap()
            }
        }
    }
    
    /// Test M6 : Dialogue de confirmation de vidage du cache
    func testClearCacheConfirmationDialog() {
        harness.switchTab("Réglages")
        
        harness.app.swipeUp()
        
        let clearButton = harness.app.buttons["Vider le cache hors-ligne"]
        if clearButton.waitForExistence(timeout: 3.0) {
            clearButton.tap()
            
            let cancelBtn = harness.app.buttons["Annuler"]
            if cancelBtn.waitForExistence(timeout: 2.0) {
                cancelBtn.tap()
            }
        }
        
        harness.switchTab("Documents")
    }
}
