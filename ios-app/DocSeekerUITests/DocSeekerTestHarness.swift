// DocSeekerTestHarness.swift
// Page Object Model & Standardized Test Helper pour DocSeeker iOS XCUITest
// Reproduit le pattern d'architecture de tests automatisés de Playwright (harness.mjs)

import XCTest

public final class DocSeekerTestHarness {
    public let app: XCUIApplication
    
    public init(app: XCUIApplication = XCUIApplication()) {
        self.app = app
    }
    
    // MARK: - Cycle de vie
    
    @discardableResult
    public func launch() -> Self {
        app.launch()
        return self
    }
    
    // MARK: - Navigation & Onglets
    
    @discardableResult
    public func switchTab(_ tabName: String) -> Self {
        let btn = app.buttons["Onglet \(tabName)"].exists ? app.buttons["Onglet \(tabName)"] : app.buttons[tabName]
        if btn.waitForExistence(timeout: 2.0) {
            btn.tap()
        } else {
            let tabBar = app.tabBars.firstMatch
            if tabBar.exists {
                let tabButton = tabBar.buttons[tabName]
                if tabButton.waitForExistence(timeout: 2.0) {
                    tabButton.tap()
                }
            }
        }
        return self
    }
    
    // MARK: - Recherche
    
    @discardableResult
    public func search(query: String) -> Self {
        let searchBtn = app.buttons["Rechercher dans le dossier"]
        if searchBtn.exists {
            searchBtn.tap()
        }
        let searchField = app.textFields.firstMatch
        if searchField.waitForExistence(timeout: 2.0) {
            searchField.tap()
            searchField.typeText(query + "\n")
        }
        return self
    }
    
    @discardableResult
    public func clearSearch() -> Self {
        let clearBtn = app.buttons["xmark.circle.fill"]
        if clearBtn.exists {
            clearBtn.tap()
        }
        let backBtn = app.buttons["Retour"]
        if backBtn.exists {
            backBtn.tap()
        } else {
            let searchToggle = app.buttons["Rechercher dans le dossier"]
            if searchToggle.exists && app.textFields.firstMatch.exists {
                searchToggle.tap()
            }
        }
        return self
    }
    
    @discardableResult
    public func toggleTitlesOnly() -> Self {
        let toggle = app.buttons["Titres"].exists ? app.buttons["Titres"] : app.switches["Titres"]
        if toggle.waitForExistence(timeout: 2.0) {
            toggle.tap()
        }
        return self
    }
    
    // MARK: - Lecteur PDFKit Goodnotes
    
    @discardableResult
    public func openFirstDocumentReader() -> Self {
        let docBtn = app.buttons["doc_card_button_1"]
        if docBtn.waitForExistence(timeout: 3.0) {
            docBtn.tap()
            return self
        }
        let readButton = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Lire'")).firstMatch
        if readButton.exists {
            readButton.tap()
        } else {
            let docText = app.staticTexts["023 - Grossesse normale"]
            if docText.waitForExistence(timeout: 3.0) {
                docText.tap()
            } else {
                let docRow = app.buttons.matching(NSPredicate(format: "label CONTAINS 'pages' OR label CONTAINS 'Grossesse'")).firstMatch
                if docRow.waitForExistence(timeout: 3.0) {
                    docRow.tap()
                }
            }
        }
        return self
    }
    
    @discardableResult
    public func verifyPDFReaderActive() -> Self {
        let homeBtn = app.buttons["Retour à l'accueil"].exists ? app.buttons["Retour à l'accueil"] : app.buttons["house"]
        let closeBtn = app.buttons["Fermer"]
        XCTAssertTrue(homeBtn.waitForExistence(timeout: 4.0) || closeBtn.waitForExistence(timeout: 4.0), "Le lecteur PDF Goodnotes doit être ouvert")
        return self
    }
    
    @discardableResult
    public func closePDFReader() -> Self {
        let homeBtn = app.buttons["Retour à l'accueil"].exists ? app.buttons["Retour à l'accueil"] : app.buttons["house"]
        if homeBtn.exists {
            homeBtn.tap()
        } else {
            let closeBtn = app.buttons["Fermer"]
            if closeBtn.waitForExistence(timeout: 2.0) {
                closeBtn.tap()
            }
        }
        return self
    }
    
    // MARK: - Arborescence & Dossiers
    
    @discardableResult
    public func openFolder(id: Int64) -> Self {
        let folderRow = app.descendants(matching: .any)["folder_row_\(id)"]
        if folderRow.waitForExistence(timeout: 3.0) {
            folderRow.tap()
        }
        return self
    }
    
    @discardableResult
    public func goBack() -> Self {
        let backBtn = app.buttons["Retour"]
        if backBtn.waitForExistence(timeout: 2.0) {
            backBtn.tap()
        }
        return self
    }
    
    // MARK: - Bandeau Inférieur d'Occurrences
    
    public func bottomBarCounterText() -> String {
        // Priorité 1 : accessibilityIdentifier dédié (le plus fiable)
        let byId = app.staticTexts["occurrence_counter"]
        if byId.waitForExistence(timeout: 3.0) {
            return byId.label
        }
        // Fallback : chercher dans tous les staticTexts un label contenant "/" ou "correspondance"
        let allTexts = app.staticTexts.allElementsBoundByIndex
        for el in allTexts {
            let lbl = el.label
            if lbl.contains("/") && lbl.contains(el.label.filter { $0.isNumber || $0 == "/" }) {
                return lbl
            }
            if lbl.contains("correspondance") {
                return lbl
            }
        }
        return ""
    }
    
    @discardableResult
    public func tapNextOccurrence() -> Self {
        let nextBtn = app.buttons["occurrence_next"]
        if nextBtn.waitForExistence(timeout: 3.0) {
            nextBtn.tap()
        }
        return self
    }
    
    @discardableResult
    public func tapPrevOccurrence() -> Self {
        let prevBtn = app.buttons["occurrence_prev"]
        if prevBtn.waitForExistence(timeout: 3.0) {
            prevBtn.tap()
        }
        return self
    }
    
    // MARK: - Tiroir d'occurrences
    
    @discardableResult
    public func openFirstOccurrenceDrawer() -> Self {
        let occBtn = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Occurrences'")).firstMatch
        if occBtn.waitForExistence(timeout: 3.0) {
            occBtn.tap()
        } else {
            openReaderDrawer()
        }
        return self
    }
    
    @discardableResult
    public func switchOccurrenceSortOrder(to order: String) -> Self {
        let sortButton = app.buttons[order]
        if sortButton.waitForExistence(timeout: 2.0) {
            sortButton.tap()
        }
        return self
    }
    
    @discardableResult
    public func openReaderDrawer() -> Self {
        let drawerBtn = app.buttons["reader_open_drawer"]
        if drawerBtn.waitForExistence(timeout: 3.0) {
            drawerBtn.tap()
        }
        return self
    }
    
    @discardableResult
    public func selectDrawerOccurrence(index: Int) -> Self {
        let item = app.buttons["drawer_occurrence_\(index)"]
        if item.waitForExistence(timeout: 3.0) {
            item.tap()
        }
        return self
    }
    
    @discardableResult
    public func closeOccurrenceDrawer() -> Self {
        let closeBtn = app.buttons["drawer_close"]
        if closeBtn.waitForExistence(timeout: 2.0) {
            closeBtn.tap()
        }
        return self
    }
    
    // MARK: - Connectivité Serveur & Mode Hors-ligne Réel
    
    /// Télécharge et garantit que le document 1 est en cache local avant passage hors-ligne
    @discardableResult
    public func ensureDoc1ReadyForOffline() -> Self {
        switchTab("Documents")
        let cacheStatus = app.buttons["cache_status_1"]
        if cacheStatus.exists {
            return self
        }
        search(query: "grossesse")
        let docCard = app.staticTexts["023 - Grossesse normale"]
        if docCard.waitForExistence(timeout: 5.0) {
            let statusBtn = app.buttons["cache_status_1"]
            if !statusBtn.exists {
                let downloadBtn = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Télécharger'")).firstMatch
                if downloadBtn.exists {
                    downloadBtn.tap()
                    _ = statusBtn.waitForExistence(timeout: 15.0)
                }
            }
        }
        clearSearch()
        return self
    }
    
    @discardableResult
    public func disconnectServer() -> Self {
        // Le serveur est physiquement coupé au niveau OS par kill -TERM par l'orchestrateur de test
        switchTab("Documents")
        return self
    }
    
    @discardableResult
    public func reconnectServer() -> Self {
        // IMP-3 : IMPORTANT — cette méthode NE rallume PAS le serveur.
        // Le rallumage physique du serveur doit être effectué par le script shell orchestrateur
        // (run_real_server_offline_tests.sh) AVANT d'appeler cette méthode.
        //
        // Cette méthode provoque uniquement un refresh de l'état réseau côté app :
        // - tape sur le badge "network_status_indicator" pour forcer un probeServerReachability()
        // - revient sur l'onglet Documents pour déclencher un rechargement des données
        let statusBtn = app.buttons["network_status_indicator"]
        if statusBtn.exists {
            statusBtn.tap()
        }
        sleep(2) // Laisser le temps au NWPathMonitor de détecter le retour réseau
        switchTab("Documents")
        return self
    }
    
    @discardableResult
    public func setServerURL(_ newURL: String) -> Self {
        switchTab("Réglages")
        let urlField = app.textFields["server_url_input"]
        if urlField.waitForExistence(timeout: 3.0) {
            urlField.tap()
            if let strVal = urlField.value as? String, !strVal.isEmpty {
                let deleteString = String(repeating: XCUIKeyboardKey.delete.rawValue, count: strVal.count)
                urlField.typeText(deleteString)
            }
            urlField.typeText(newURL)
        }
        let connectBtn = app.buttons["server_connect_button"]
        if connectBtn.waitForExistence(timeout: 2.0) {
            connectBtn.tap()
            Thread.sleep(forTimeInterval: 1.0)
        }
        return self
    }
    
    @discardableResult
    public func setAppTheme(_ theme: String) -> Self {
        switchTab("Réglages")
        let themeSegment = app.buttons[theme]
        if themeSegment.waitForExistence(timeout: 2.0) {
            themeSegment.tap()
        }
        return self
    }
    
    public var fixturesDir: URL {
        if let bundleURL = Bundle(for: DocSeekerTestHarness.self).url(forResource: "2", withExtension: "pdf") {
            return bundleURL.deletingLastPathComponent()
        }
        return Bundle.main.bundleURL
    }
    
    public func fixturePDFURL(named name: String) -> URL? {
        Bundle(for: DocSeekerTestHarness.self).url(forResource: name, withExtension: "pdf")
            ?? Bundle.main.url(forResource: name, withExtension: "pdf")
    }
}
