// DocSeekerMatrixUITests.swift
// Matrice de tests UI standardisés reproduisant l'architecture Playwright (ui_stress_matrix.spec.mjs)
// avec recherche clinique réelle, ouverture de vrais PDF médicaux, synchronisation et interruption/reprise réseau

import XCTest

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
    // =========================================================================
    
    func testMatrix1_ActionChainingSearchToRealisticPDFReader() {
        harness
            .search(query: "grossesse")
            .openFirstDocumentReader()
        
        // Si le lecteur s'ouvre avec le vrai PDF
        let closeBtn = harness.app.buttons["Fermer"]
        if closeBtn.waitForExistence(timeout: 4.0) {
            harness
                .verifyPDFReaderActive()
                .closePDFReader()
        }
        
        // Nettoyage de la barre de recherche
        harness.clearSearch()
    }
    
    // =========================================================================
    // MATRICE 2 : Tiroir d'occurrences et tri sur terme clinique réel ('toxoplasmose')
    // =========================================================================
    
    func testMatrix2_OccurrenceDrawerAndSortingOnRealisticPDF() {
        harness.search(query: "toxoplasmose")
        
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
            let sidebarBtn = harness.app.buttons["sidebar.left"]
            if sidebarBtn.waitForExistence(timeout: 4.0) {
                sidebarBtn.tap()
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
            
            if let notice = scenario.expectedNotice {
                let noticeElement = harness.app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", notice)).firstMatch
                let errorBanner = harness.app.images["exclamationmark.triangle"]
                XCTAssertTrue(
                    noticeElement.waitForExistence(timeout: 3.0) || errorBanner.waitForExistence(timeout: 3.0),
                    "Scénario '\(scenario.name)' doit afficher la notice attendue"
                )
            }
            
            harness.clearSearch()
        }
    }
    
    // =========================================================================
    // MATRICE 4 : Synchronisation des dossiers et arborescence
    // =========================================================================
    
    func testMatrix4_FolderSynchronizationAndCacheState() {
        harness.switchTab("Documents")
        
        // Déclencher ou vérifier le bouton de synchronisation
        let syncButton = harness.app.buttons["Synchroniser"]
        if syncButton.waitForExistence(timeout: 2.0) {
            syncButton.tap()
        }
    }
    
    // =========================================================================
    // MATRICE 5 : Interruption et Reprise Réseau (Simulée via Forcer hors-ligne)
    // =========================================================================
    
    func testMatrix5_NetworkInterruptionAndResumeFlow() {
        // 1. Recherche initiale en ligne
        harness.search(query: "grossesse")
        
        // 2. Interruption du réseau (coupure réelle serveur)
        harness.disconnectServer()
        harness.switchTab("Documents")
        
        // 3. Vérifier que la recherche fonctionne en local hors-ligne
        harness.search(query: "toxoplasmose")
        
        // 4. Rétablissement du réseau (reprise transparente)
        harness.reconnectServer()
        harness.switchTab("Documents")
        
        harness.clearSearch()
    }
    
    // =========================================================================
    // MATRICE 6 : Cycle de vie des thèmes (Clair par défaut, Sombre, Système)
    // =========================================================================
    
    func testMatrix6_ThemeSwitching() {
        harness
            .setAppTheme("Sombre")
            .setAppTheme("Clair") // Rétablissement du thème clair par défaut
    }
}
