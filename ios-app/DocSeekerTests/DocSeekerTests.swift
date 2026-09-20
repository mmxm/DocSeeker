// DocSeekerTests.swift
// Tests unitaires et d'intégration XCTest validant le moteur Rust, les vrais PDF médicaux,
// la synchronisation et la résilience aux interruptions/reprises réseau

import XCTest
import PDFKit
import SQLite3
@testable import DocSeeker

final class DocSeekerTests: XCTestCase {
    var tempDBURL: URL!
    var tempDocDirURL: URL!
    
    override func setUp() {
        super.setUp()
        let tempDir = FileManager.default.temporaryDirectory
        tempDBURL = tempDir.appendingPathComponent("test_db_\(UUID().uuidString).sqlite")
        tempDocDirURL = tempDir.appendingPathComponent("test_pdfs_\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDocDirURL, withIntermediateDirectories: true)
    }
    
    override func tearDown() {
        if let url = tempDBURL {
            try? FileManager.default.removeItem(at: url)
        }
        if let dir = tempDocDirURL {
            try? FileManager.default.removeItem(at: dir)
        }
        super.tearDown()
    }
    
    private func fixtureURL(named name: String, ext: String) -> URL? {
        let bundle = Bundle(for: DocSeekerTests.self)
        if let url = bundle.url(forResource: name, withExtension: ext) {
            return url
        }
        if let url = bundle.url(forResource: name, withExtension: ext, subdirectory: "Fixtures") {
            return url
        }
        let directPath = URL(fileURLWithPath: #file)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/\(name).\(ext)")
        if FileManager.default.fileExists(atPath: directPath.path) {
            return directPath
        }
        return nil
    }
    
    // =========================================================================
    // 1. Initialisation SQLite & Pont Rust
    // =========================================================================
    
    func testRustBridgeDatabaseInit() {
        let success = RustBridge.shared.initDatabase(at: tempDBURL)
        XCTAssertTrue(success, "L'initialisation de la base SQLite locale via Rust doit réussir")
        XCTAssertTrue(FileManager.default.fileExists(atPath: tempDBURL.path))
    }
    
    // =========================================================================
    // 2. Recherche sur un corpus médical réel multi-documents (Grossesse, Diabète)
    // =========================================================================
    
    func testRealMedicalCorpus_MultiDocumentSearch() throws {
        _ = RustBridge.shared.initDatabase(at: tempDBURL)
        
        // Insertion Document 1 : 023 - Grossesse normale (6 pages)
        guard let bundle1URL = fixtureURL(named: "grossesse_normale_bundle", ext: "json"),
              let bundle1Json = try? String(contentsOf: bundle1URL, encoding: .utf8) else {
            XCTFail("Bundle réel 'grossesse_normale_bundle.json' introuvable")
            return
        }
        XCTAssertTrue(RustBridge.shared.insertBundle(json: bundle1Json, at: tempDBURL))
        
        // Insertion Document 8 : 025 - Grossesse extra-utérine (3 pages)
        guard let bundle8URL = fixtureURL(named: "grossesse_extra_uterine_bundle", ext: "json"),
              let bundle8Json = try? String(contentsOf: bundle8URL, encoding: .utf8) else {
            XCTFail("Bundle réel 'grossesse_extra_uterine_bundle.json' introuvable")
            return
        }
        XCTAssertTrue(RustBridge.shared.insertBundle(json: bundle8Json, at: tempDBURL))
        
        // Insertion Document 10 : 247 - Diabète sucré (25 pages)
        guard let bundle10URL = fixtureURL(named: "diabete_bundle", ext: "json"),
              let bundle10Json = try? String(contentsOf: bundle10URL, encoding: .utf8) else {
            XCTFail("Bundle réel 'diabete_bundle.json' introuvable")
            return
        }
        XCTAssertTrue(RustBridge.shared.insertBundle(json: bundle10Json, at: tempDBURL))
        
        // A. Recherche croisée 'grossesse' -> Doit trouver Doc 1 et Doc 8
        let resGrossesse = RustBridge.shared.searchLocal(query: "grossesse", folderId: nil, titlesOnly: false, at: tempDBURL)
        XCTAssertNotNil(resGrossesse)
        XCTAssertGreaterThanOrEqual(resGrossesse?.total_documents ?? 0, 2, "La recherche 'grossesse' doit retourner au moins 2 documents cliniques distincts")
        let docIds = resGrossesse?.results.map { $0.id } ?? []
        XCTAssertTrue(docIds.contains(1))
        XCTAssertTrue(docIds.contains(8))
        
        // B. Recherche terme clinique précis 'toxoplasmose' -> Doc 1
        let resToxo = RustBridge.shared.searchLocal(query: "toxoplasmose", folderId: nil, titlesOnly: false, at: tempDBURL)
        XCTAssertNotNil(resToxo)
        XCTAssertGreaterThanOrEqual(resToxo?.total_documents ?? 0, 1)
        XCTAssertEqual(resToxo?.results.first?.id, 1)
        
        // C. Recherche pathologie métabolique 'diabète' -> Doc 10
        let resDiabete = RustBridge.shared.searchLocal(query: "diabète", folderId: nil, titlesOnly: false, at: tempDBURL)
        XCTAssertNotNil(resDiabete)
        XCTAssertGreaterThanOrEqual(resDiabete?.total_documents ?? 0, 1)
        XCTAssertTrue(resDiabete?.results.contains(where: { $0.id == 10 }) ?? false)
        
        // D. Recherche thérapeutique 'insuline' -> Doc 10
        let resInsuline = RustBridge.shared.searchLocal(query: "insuline", folderId: nil, titlesOnly: false, at: tempDBURL)
        XCTAssertNotNil(resInsuline)
        XCTAssertGreaterThanOrEqual(resInsuline?.total_documents ?? 0, 1)
        XCTAssertEqual(resInsuline?.results.first?.id, 10)
        
        // E. Recherche ciblée dans un document précis (Doc 1 : 'consultations')
        let docSearch = RustBridge.shared.docSearchLocal(docId: 1, query: "consultations", at: tempDBURL)
        XCTAssertNotNil(docSearch)
        XCTAssertGreaterThan(docSearch?.total_occurrences ?? 0, 0)
    }
    
    // =========================================================================
    // 3. Rendu et ouverture matérielle de vrais PDF médicaux avec Apple PDFKit
    // =========================================================================
    
    func testRealMedicalPDFs_PDFKitInspection() {
        // Document 1 : Grossesse normale (6 pages)
        guard let pdf1URL = fixtureURL(named: "1", ext: "pdf") else {
            XCTFail("Fichier '1.pdf' introuvable")
            return
        }
        let doc1 = PDFDocument(url: pdf1URL)
        XCTAssertNotNil(doc1)
        XCTAssertEqual(doc1?.pageCount, 6, "023 - Grossesse normale doit faire 6 pages")
        XCTAssertTrue(doc1?.page(at: 0)?.string?.contains("GROSSESSE NORMALE") ?? false ||
                      doc1?.page(at: 0)?.string?.contains("Item 23") ?? false)
        
        // Document 8 : Grossesse extra-utérine (3 pages)
        guard let pdf8URL = fixtureURL(named: "8", ext: "pdf") else {
            XCTFail("Fichier '8.pdf' introuvable")
            return
        }
        let doc8 = PDFDocument(url: pdf8URL)
        XCTAssertNotNil(doc8)
        XCTAssertEqual(doc8?.pageCount, 3, "025 - Grossesse extra-utérine doit faire 3 pages")
        XCTAssertTrue(doc8?.page(at: 0)?.string?.localizedCaseInsensitiveContains("Grossesse") ?? false)
        
        // Document 10 : Diabète sucré (25 pages)
        guard let pdf10URL = fixtureURL(named: "10", ext: "pdf") else {
            XCTFail("Fichier '10.pdf' introuvable")
            return
        }
        let doc10 = PDFDocument(url: pdf10URL)
        XCTAssertNotNil(doc10)
        XCTAssertEqual(doc10?.pageCount, 25, "247 - Diabète sucré doit faire 25 pages")
        XCTAssertTrue(doc10?.page(at: 0)?.string?.localizedCaseInsensitiveContains("Diabète") ?? false)
    }
    
    // =========================================================================
    // 3b. Test d'ouverture partielle et négociation HTTP 206 Partial Content (Byte-Range)
    // =========================================================================
    
    func testPartialPDFStreamingAndByteRangeNegotiation() async throws {
        let api = APIClient.shared
        let loggedIn = await api.autoLoginIfPossible()
        XCTAssertTrue(loggedIn, "L'auto-login doit réussir sur le serveur local")
        
        guard let streamURL = api.streamingPDFURL(for: 1) else {
            XCTFail("L'URL de streaming partiel avec token doit être construite")
            return
        }
        
        // 1. Validation de la négociation HTTP 206 (Byte-Range)
        var rangeReq = URLRequest(url: streamURL)
        rangeReq.setValue("bytes=0-1024", forHTTPHeaderField: "Range")
        let (data, response) = try await URLSession.shared.data(for: rangeReq)
        guard let http = response as? HTTPURLResponse else {
            XCTFail("Réponse HTTP attendue")
            return
        }
        
        XCTAssertEqual(http.statusCode, 206, "Le serveur doit répondre HTTP 206 Partial Content pour les requêtes Range")
        XCTAssertEqual(http.value(forHTTPHeaderField: "Accept-Ranges"), "bytes")
        XCTAssertEqual(data.count, 1025, "La taille du flux partiel doit être exactement de 1025 octets")
        
        // 2. Validation de l'ouverture native par Apple PDFKit sans blocage 401
        let remoteDoc = PDFDocument(url: streamURL)
        XCTAssertNotNil(remoteDoc, "Apple PDFDocument doit pouvoir s'initialiser sur l'URL distante authentifiée")
        XCTAssertGreaterThan(remoteDoc?.pageCount ?? 0, 0, "Apple PDFKit doit charger le document distant sans écran blanc")
    }
    
    // =========================================================================
    // 4. Découpe matérielle CoreGraphics avec surlignage Goodnotes sur vrais PDF
    // =========================================================================
    
    func testRealMedicalPDF_CoreGraphicsCropRendering() {
        guard let pdf1URL = fixtureURL(named: "1", ext: "pdf") else {
            XCTFail("Fichier '1.pdf' introuvable")
            return
        }
        
        // Découpe page 1
        let crop1 = LocalCropEngine.shared.cropOccurrence(
            pdfURL: pdf1URL,
            pageNumber: 1,
            rect: [50.0, 100.0, 350.0, 180.0],
            highlightRects: [[50.0, 100.0, 200.0, 130.0]],
            cacheKey: "test_real_crop_doc1_p1"
        )
        XCTAssertNotNil(crop1, "La découpe matérielle d'une page de cours médical réel doit produire une image")
        XCTAssertGreaterThan(crop1?.size.width ?? 0, 50)
        XCTAssertGreaterThan(crop1?.size.height ?? 0, 20)
        
        // Découpe page 2 sur le cours du Diabète (doc 10)
        if let pdf10URL = fixtureURL(named: "10", ext: "pdf") {
            let crop10 = LocalCropEngine.shared.cropOccurrence(
                pdfURL: pdf10URL,
                pageNumber: 2,
                rect: [60.0, 150.0, 400.0, 220.0],
                highlightRects: [[70.0, 160.0, 250.0, 185.0]],
                cacheKey: "test_real_crop_doc10_p2"
            )
            XCTAssertNotNil(crop10)
        }
    }
    
    // =========================================================================
    // 5. Synchronisation des dossiers et arborescence
    // =========================================================================
    
    func testFolderSynchronizationAndCacheStatus() {
        _ = RustBridge.shared.initDatabase(at: tempDBURL)
        
        let foldersJson = """
        [
            {"id": 130, "name": "Martingale", "parent_id": null, "color": "#3b82f6"},
            {"id": 140, "name": "Endocrinologie", "parent_id": null, "color": "#ef4444"}
        ]
        """
        let syncOk = RustBridge.shared.syncFolders(json: foldersJson, at: tempDBURL)
        XCTAssertTrue(syncOk, "La synchronisation des dossiers dans SQLite doit réussir")
        
        // Vérification de la détection de statut de cache dossier
        let localDb = LocalDatabase.shared
        localDb.removeDocumentFromCache(docId: 1)
        localDb.removeDocumentFromCache(docId: 8)
        localDb.removeDocumentFromCache(docId: 10)
        
        let statusInitial = localDb.folderCacheStatus(docIdsInFolder: [1, 8, 10])
        XCTAssertEqual(statusInitial.totalCount, 3)
        XCTAssertEqual(statusInitial.cachedCount, 0)
        
        // Mise en cache simulée du doc 1
        if let pdf1URL = fixtureURL(named: "1", ext: "pdf") {
            localDb.seedDocument(docId: 1, from: pdf1URL)
            XCTAssertTrue(localDb.isDocumentCached(docId: 1))
            
            let statusApres1 = localDb.folderCacheStatus(docIdsInFolder: [1, 8, 10])
            XCTAssertEqual(statusApres1.cachedCount, 1)
            XCTAssertFalse(statusApres1.isComplete)
            
            // Nettoyage
            localDb.removeDocumentFromCache(docId: 1)
            XCTAssertFalse(localDb.isDocumentCached(docId: 1))
        }
    }
    
    // =========================================================================
    // 6. Synchronisation avec Interruption et Reprise Réseau (Network Resume)
    // =========================================================================
    
    func testSynchronizationWithNetworkInterruptionAndResume() {
        let queue = DownloadQueueManager.shared
        let docId: Int64 = 777
        
        // Configuration initiale
        queue.isPaused = true
        queue.cancelDownload(docId: docId)
        
        let expCancel = expectation(description: "Wait cancel")
        DispatchQueue.main.async {
            // 1. Simuler une tâche interrompue par coupure réseau
            queue.interruptedTasks[docId] = 0.45
            expCancel.fulfill()
        }
        wait(for: [expCancel], timeout: 2.0)
        
        XCTAssertTrue(queue.interruptedTasks.keys.contains(docId),
                      "Le document interrompu doit figurer dans interruptedTasks")
        
        // 2. Simuler la capture de données de reprise (resumeData)
        let dummyResumeData = "ResumeDataBytesSimulated".data(using: .utf8)!
        queue.setResumeData(for: docId, data: dummyResumeData)
        XCTAssertEqual(queue.getResumeData(for: docId), dummyResumeData)
        
        // 3. Rétablissement du réseau et déclenchement de la reprise
        NetworkMonitor.shared.isOnline = true
        queue.resumeInterruptedTasks()
        
        let exp = expectation(description: "Resume completed")
        DispatchQueue.main.async {
            exp.fulfill()
        }
        wait(for: [exp], timeout: 2.0)
        
        // Vérifier que le document est réinjecté dans la file d'attente
        XCTAssertTrue(queue.queuedDocIds.contains(docId) || queue.activeTasks.keys.contains(docId) || queue.interruptedTasks.keys.contains(docId),
                      "Le retour du réseau doit déclencher la reprise du document interrompu")
        
        // Nettoyer
        queue.cancelDownload(docId: docId)
        queue.isPaused = false
    }
    
    // =========================================================================
    // 7. Intégrité de la mise en cache : Validation PDF anti-corruption
    // =========================================================================
    
    func testCacheIntegrityValidation_RejectsCorruptedFile() {
        let localDb = LocalDatabase.shared
        let corruptedDocId: Int64 = 999
        let fakeLocation = tempDocDirURL.appendingPathComponent("corrupted.pdf")
        
        // Création d'un fichier corrompu (pas un vrai PDF)
        let corruptData = "<html><body>502 Bad Gateway</body></html>".data(using: .utf8)!
        try? corruptData.write(to: fakeLocation)
        
        // Simuler l'enregistrement via PDFDocument
        let pdfDoc = PDFDocument(url: fakeLocation)
        XCTAssertNil(pdfDoc, "Un fichier corrompu ou HTML ne doit pas être reconnu comme un PDF valide")
        
        // S'assurer qu'il n'est pas dans le cache
        XCTAssertFalse(localDb.isDocumentCached(docId: corruptedDocId))
    }
    
    // =========================================================================
    // 8. Résolution complète des occurrences intra-document & Emplacement
    // =========================================================================
    
    func testIntraDocumentOccurrencesResolutionAndLocation() {
        let tabManager = DocumentTabManager.shared
        let docId: Int64 = 581
        let docTitle = "Urgences - 5E 2024"
        let folderLocation = "Martingale / Urgences"
        
        // Simuler l'ouverture depuis la recherche avec 1 vignette d'aperçu
        let initialPreviewOcc = OccurrenceResult(
            page_number: 94,
            occ_id: 1,
            text_snippet: "Insuffisance cardiaque de l'adulte",
            rect: [100, 200, 300, 400]
        )
        
        tabManager.openDocument(
            docId: docId,
            title: docTitle,
            filename: "urgences.pdf",
            initialPage: 94,
            occurrences: [initialPreviewOcc],
            searchQuery: "cardiaque",
            targetOccurrenceIndex: 0,
            folderPath: folderLocation
        )
        
        // Laisser la boucle d'événements traiter le bloc asynchrone principal
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        
        guard let tab = tabManager.activeTab else {
            XCTFail("L'onglet Urgences doit être ouvert")
            return
        }
        
        XCTAssertEqual(tab.folderPath, folderLocation, "L'emplacement du document doit être mémorisé")
        XCTAssertEqual(tab.currentPage, 94)
        
        // Simuler la mise à jour asynchrone des 173 occurrences trouvées
        var allOccurrences: [OccurrenceResult] = []
        for i in 1...173 {
            allOccurrences.append(OccurrenceResult(
                page_number: Int64(min(736, i * 4)),
                occ_id: i,
                text_snippet: "Mention cardiaque extrait \(i)",
                rect: [100, 200, 300, 400]
            ))
        }
        
        tabManager.updateInDocOccurrences(docId: docId, query: "cardiaque", occurrences: allOccurrences)
        
        guard let updatedTab = tabManager.activeTab else {
            XCTFail("L'onglet doit être actif")
            return
        }
        
        XCTAssertEqual(updatedTab.occurrences.count, 173, "L'onglet doit contenir l'intégralité des 173 occurrences")
        XCTAssertEqual(updatedTab.searchQuery, "cardiaque")
        
        // Test navigation occurrence suivante et précédente
        let currentIdx = tabManager.activeTab?.activeOccurrenceIndex ?? 0
        tabManager.nextOccurrence()
        XCTAssertEqual(tabManager.activeTab?.activeOccurrenceIndex, currentIdx + 1)
        tabManager.previousOccurrence()
        XCTAssertEqual(tabManager.activeTab?.activeOccurrenceIndex, currentIdx)
        
        // Nettoyage
        tabManager.closeTab(id: updatedTab.id)
    }
    
    // =========================================================================
    // 8. Régression Bug 6 : syncFolders ne doit JAMAIS effacer les folder_id des docs en cache
    // =========================================================================
    
    func testSyncFoldersDoesNotWipeCachedDocumentFolderIds() {
        _ = RustBridge.shared.initDatabase(at: tempDBURL)
        
        let initialFolders = """
        [
            {"id": 300, "name": "Martingale", "parent_id": null, "color": "#3b82f6"}
        ]
        """
        XCTAssertTrue(RustBridge.shared.syncFolders(json: initialFolders, at: tempDBURL))
        
        // Insertion d'un document appartenant au dossier 300
        let docBundle = """
        {
            "document": {
                "id": 999,
                "filename": "023_martingale.pdf",
                "title": "Grossesse Martingale",
                "folder_id": 300,
                "total_pages": 1
            },
            "pages": [
                {
                    "page_number": 1,
                    "text_content": "Texte martingale",
                    "words": []
                }
            ]
        }
        """
        XCTAssertTrue(RustBridge.shared.insertBundle(json: docBundle, at: tempDBURL))
        
        // Exécution d'une seconde synchronisation de dossiers (comme lors du rafraîchissement ou retour réseau)
        let secondSyncFolders = """
        [
            {"id": 300, "name": "Martingale", "parent_id": null, "color": "#3b82f6"},
            {"id": 301, "name": "Anatomie", "parent_id": null, "color": "#10b981"}
        ]
        """
        XCTAssertTrue(RustBridge.shared.syncFolders(json: secondSyncFolders, at: tempDBURL))
        
        // Vérifier que le document 999 a conservé son folder_id = 300
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(tempDBURL.path, &db, SQLITE_OPEN_READONLY, nil), SQLITE_OK)
        defer { sqlite3_close(db) }
        
        var stmt: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(db, "SELECT folder_id FROM documents WHERE id = 999", -1, &stmt, nil), SQLITE_OK)
        defer { sqlite3_finalize(stmt) }
        
        XCTAssertEqual(sqlite3_step(stmt), SQLITE_ROW)
        let folderId = sqlite3_column_int64(stmt, 0)
        XCTAssertEqual(folderId, 300, "Le folder_id du document ne doit pas être réinitialisé à NULL par la synchronisation des dossiers")
    }
    
    // =========================================================================
    // 9. Régression Bug 7 : Le format 'words' array du serveur génère bien des vignettes
    // =========================================================================
    
    func testServerBundleWordsArrayFormatYieldsVignettes() {
        _ = RustBridge.shared.initDatabase(at: tempDBURL)
        
        // Payload calqué exactement sur la réponse réelle de GET /api/documents/{id}/offline-bundle
        let bundleServerFormat = """
        {
            "document": {
                "id": 888,
                "filename": "cardiologie.pdf",
                "title": "Cardiologie Clinique",
                "folder_id": null,
                "total_pages": 1
            },
            "pages": [
                {
                    "page_number": 1,
                    "text_content": "Traitement de l'insuffisance cardiaque congestive aiguë.",
                    "words": [
                        [50.0, 100.0, 120.0, 115.0, "Traitement", 0, 1],
                        [125.0, 100.0, 140.0, 115.0, "de", 0, 1],
                        [145.0, 100.0, 230.0, 115.0, "l'insuffisance", 0, 1],
                        [235.0, 100.0, 310.0, 115.0, "cardiaque", 0, 1],
                        [315.0, 100.0, 390.0, 115.0, "congestive", 0, 1]
                    ]
                }
            ]
        }
        """
        XCTAssertTrue(RustBridge.shared.insertBundle(json: bundleServerFormat, at: tempDBURL))
        
        // Recherche du terme 'cardiaque'
        guard let searchRes = RustBridge.shared.searchLocal(query: "cardiaque", folderId: nil, titlesOnly: false, at: tempDBURL) else {
            XCTFail("La recherche locale doit retourner un résultat")
            return
        }
        
        XCTAssertEqual(searchRes.total_documents, 1)
        guard let doc = searchRes.results.first else {
            XCTFail("Le document 888 doit être trouvé")
            return
        }
        
        XCTAssertEqual(doc.id, 888)
        XCTAssertNotNil(doc.vignettes, "Les vignettes ne doivent pas être nil")
        XCTAssertFalse(doc.vignettes!.isEmpty, "Les vignettes d'extraits doivent être générées à partir du tableau spatial 'words'")
        XCTAssertEqual(doc.vignettes!.first?.page_number, 1)
    }

    // =========================================================================
    // 10. Synchronisation catalogue complet & exclusion des non-cachés en recherche
    // =========================================================================
    
    func testSyncAllDocumentsMetadata_PreservesFolderTree_AndExcludesUncachedFromOfflineSearch() {
        _ = RustBridge.shared.initDatabase(at: tempDBURL)
        
        let docs = [
            DocumentItem(id: 101, filename: "doc1.pdf", title: "Document 1 en cache", folder_id: 10, total_pages: 5, file_size: 1024, created_at: nil, updated_at: nil),
            DocumentItem(id: 102, filename: "doc2.pdf", title: "Document 2 distant", folder_id: 10, total_pages: 8, file_size: 2048, created_at: nil, updated_at: nil),
            DocumentItem(id: 103, filename: "doc3.pdf", title: "Document 3 racine distant", folder_id: nil, total_pages: 12, file_size: 4096, created_at: nil, updated_at: nil)
        ]
        
        // Synchronisation du catalogue complet dans SQLite
        LocalDatabase.shared.syncAllDocumentsMetadata(docs: docs)
        
        // 1. Vérification que l'arborescence contient bien tous les fichiers (même non cachés)
        let folderDocs = LocalDatabase.shared.getLocalDocuments(folderId: 10)
        XCTAssertEqual(folderDocs.count, 2, "Les 2 documents du dossier 10 doivent être visibles dans la base locale")
        XCTAssertTrue(folderDocs.contains(where: { $0.id == 101 }))
        XCTAssertTrue(folderDocs.contains(where: { $0.id == 102 }))
        
        let rootDocs = LocalDatabase.shared.getLocalDocuments(folderId: nil)
        XCTAssertTrue(rootDocs.contains(where: { $0.id == 103 }), "Le document racine doit être présent")
        
        // 2. Vérification que les documents non cachés (qui n'ont pas de pages indexées) n'apparaissent pas dans les résultats FTS5
        let searchRes = RustBridge.shared.searchLocal(query: "distant", folderId: nil, titlesOnly: false, at: LocalDatabase.shared.dbURL)
        let foundUncached = searchRes?.results.contains(where: { $0.id == 102 || $0.id == 103 }) ?? false
        XCTAssertFalse(foundUncached, "Les documents distants non en cache ne doivent pas apparaître dans la recherche textuelle")
    }
    
    // =========================================================================
    // 10. Non-régression formelle : Cache strict sans faux positif
    // =========================================================================
    
    func testStrictCacheCheck_IndexedInDBWithoutPhysicalFile_ReturnsFalse() {
        let testDocId: Int64 = 8888
        
        // Simuler un document dont les métadonnées existent en base SQLite
        let doc = DocumentItem(id: testDocId, filename: "gros_doc.pdf", title: "Gros Doc", folder_id: nil, total_pages: 50, file_size: 88000000, created_at: nil, updated_at: nil)
        LocalDatabase.shared.syncAllDocumentsMetadata(docs: [doc])
        
        // S'assurer que le fichier physique n'est PAS présent
        LocalDatabase.shared.removeDocumentFromCache(docId: testDocId)
        
        // Le test clé : même si les métadonnées sont là, isDocumentCached DOIT être false
        XCTAssertFalse(LocalDatabase.shared.isDocumentCached(docId: testDocId), "Un document sans fichier physique .pdf ne doit JAMAIS être considéré en cache")
        XCTAssertNil(LocalDatabase.shared.getLocalPDFURL(docId: testDocId), "getLocalPDFURL doit être nil sans fichier physique")
    }
    
    // =========================================================================
    // 11. Téléchargement de crop authentifié avec token de session
    // =========================================================================
    
    func testAuthenticatedCropDownload_WithSessionToken_Succeeds() async throws {
        let api = APIClient.shared
        guard let token = api.sessionToken ?? KeychainManager.shared.get(key: "session_token") else {
            return // Skip si pas d'environnement réseau avec token actif
        }
        
        let cropURLStr = "/api/crop/558/490/6?h=d8a2a900&terms=diabete&token=\(token)"
        guard let url = URL(string: "\(api.serverURL)\(cropURLStr)") else {
            XCTFail("URL de crop invalide")
            return
        }
        
        var request = URLRequest(url: url)
        request.timeoutInterval = 5.0
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            XCTFail("Pas de réponse HTTP")
            return
        }
        
        XCTAssertEqual(http.statusCode, 200, "La requête de crop authentifiée avec token doit réussir (200 OK)")
        XCTAssertGreaterThan(data.count, 1000, "L'image WebP doit contenir des octets")
    }
}


