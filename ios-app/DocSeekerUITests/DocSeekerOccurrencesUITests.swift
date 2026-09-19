// DocSeekerOccurrencesUITests.swift
// Transposition XCUITest de ui_mobile_pwa.spec.mjs : Ruban, tiroir d'occurrences et tri sur cas clinique réel

import XCTest

final class DocSeekerOccurrencesUITests: XCTestCase {
    var harness: DocSeekerTestHarness!
    
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        harness = DocSeekerTestHarness()
        harness.launch()
    }
    
    /// Test M3 : Recherche clinique réelle ('grossesse'), ruban et tiroir d'occurrences
    func testSearchAndOccurrenceDrawerTriggers() {
        harness.search(query: "grossesse")
        
        let occBtn = harness.app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Occurrences'")).firstMatch
        if occBtn.waitForExistence(timeout: 4.0) {
            harness
                .openFirstOccurrenceDrawer()
                .switchOccurrenceSortOrder(to: "Ordre de page")
                .switchOccurrenceSortOrder(to: "Pertinence")
                .closeOccurrenceDrawer()
        }
        
        harness.clearSearch()
    }
}
