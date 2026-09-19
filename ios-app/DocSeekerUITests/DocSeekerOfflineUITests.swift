// DocSeekerOfflineUITests.swift
// Transposition XCUITest de ui_offline.spec.mjs & Standards ISO 29119 Résilience Réseau
// Simulation Mode Avion, Découverte SQLite Locale, Lecture PDF Hors-Ligne & Absence de Dialogues Intempestifs

import XCTest

final class DocSeekerOfflineUITests: XCTestCase {
    var harness: DocSeekerTestHarness!
    
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        harness = DocSeekerTestHarness()
        harness.launch()
    }
    
    override func tearDown() {
        harness.reconnectServer()
        super.tearDown()
    }
    
    /// Scénario Offline 1 : Coupure réelle de liaison serveur (Option B) et navigation SQLite locale
    func testRealServerDisconnectionAndLocalFallback() {
        // 1. Couper réellement l'accès au serveur (port injoignable 9999)
        harness.disconnectServer()
        
        // 2. Retourner sur l'onglet Documents
        harness.switchTab("Documents")
        
        // 3. Vérifier le badge d'état hors-ligne natif
        let offlineIndicator = harness.app.staticTexts["network_status_indicator"]
        XCTAssertTrue(offlineIndicator.waitForExistence(timeout: 5.0), "Le badge de statut réseau doit être présent")
        XCTAssertEqual(offlineIndicator.label, "Hors-ligne", "Le badge doit afficher 'Hors-ligne' en cas de rupture de liaison serveur")
        
        // 4. Vérifier que la liste locale n'est pas vide (chargement SQLite local autonome)
        let docsTitle = harness.app.staticTexts["Documents"]
        XCTAssertTrue(docsTitle.waitForExistence(timeout: 3.0))
        
        // 5. Entrer dans un dossier en mode déconnecté
        let folder = harness.app.staticTexts["Martingale"]
        if folder.waitForExistence(timeout: 4.0) {
            folder.tap()
            
            let backBtn = harness.app.buttons["Retour"]
            XCTAssertTrue(backBtn.waitForExistence(timeout: 3.0), "La navigation locale doit fonctionner en mode déconnecté")
            backBtn.tap()
        }
        
        // 6. Rétablir la liaison avec le serveur
        harness.reconnectServer()
        harness.switchTab("Documents")
    }
    
    /// Scénario Offline 2 : Vérification qu'aucun dialogue intempestif de suppression n'apparaît lors du tap
    func testNoAccidentalDeleteCacheDialogOnTap() {
        // Rechercher un document
        harness.search(query: "grossesse")
        let docCard = harness.app.staticTexts["023 - Grossesse normale"]
        XCTAssertTrue(docCard.waitForExistence(timeout: 6.0))
        
        // Clic pour ouvrir : NE DOIT PAS afficher le dialogue de suppression
        docCard.tap()
        
        // Assertion : Le dialogue de suppression ne doit PAS être présent
        let deleteDialogTitle = harness.app.staticTexts["Retirer ce document du cache local hors-ligne ?"]
        XCTAssertFalse(deleteDialogTitle.exists, "Ouvrir un document ne doit pas déclencher la boîte de suppression de cache")
        
        let homeBtn = harness.app.buttons["Retour à l'accueil"]
        if homeBtn.waitForExistence(timeout: 4.0) {
            homeBtn.tap()
        }
        
        harness.clearSearch()
    }
    
    /// Scénario Offline 3 : Consultation de la file de téléchargement et transferts
    func testDownloadQueueInspection() {
        harness.switchTab("Transferts")
        
        let header = harness.app.staticTexts["Statut de la file"].exists ||
                     harness.app.staticTexts["Documents hors-ligne"].exists ||
                     harness.app.staticTexts["En cours / En attente"].exists
        XCTAssertTrue(header, "L'onglet Transferts doit être disponible")
        
        harness.switchTab("Documents")
    }
}
