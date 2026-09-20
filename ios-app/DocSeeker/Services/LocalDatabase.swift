// LocalDatabase.swift
// Gestionnaire du cycle de vie de la base SQLite locale et des fichiers PDF sur disque

import Foundation
import SQLite3

public final class LocalDatabase: ObservableObject {
    public static let shared = LocalDatabase()

    public let dbURL: URL
    public let pdfDirectoryURL: URL

    @Published public var cachedDocIds: Set<Int64> = []

    private init() {
        let fileManager = FileManager.default
        let docsURL = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        self.dbURL = docsURL.appendingPathComponent("docseeker_local.sqlite")
        self.pdfDirectoryURL = docsURL.appendingPathComponent("pdfs", isDirectory: true)

        try? fileManager.createDirectory(at: pdfDirectoryURL, withIntermediateDirectories: true)

        // Initialiser la base avec le schéma Rust officiel
        _ = RustBridge.shared.initDatabase(at: dbURL)
        refreshCachedDocs()
        repairCorruptedCachedDocuments()
    }

    public func refreshCachedDocs() {
        let fileManager = FileManager.default
        var result = Set<Int64>()

        if let contents = try? fileManager.contentsOfDirectory(at: pdfDirectoryURL, includingPropertiesForKeys: nil) {
            for file in contents where file.pathExtension.lowercased() == "pdf" {
                let name = file.deletingPathExtension().lastPathComponent
                if let id = Int64(name) {
                    let target = self.localPdfURL(for: id)
                    if let size = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int64), size > 0 {
                        result.insert(id)
                    }
                }
            }
        }
        if Thread.isMainThread {
            self.cachedDocIds = result
        } else {
            DispatchQueue.main.async {
                self.cachedDocIds = result
            }
        }
    }

    /// Vérifie si le document est indexé avec du texte et des mots dans SQLite local
    public func isDocumentIndexedLocally(docId: Int64) -> Bool {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbURL.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            return false
        }
        defer { sqlite3_close(db) }

        var stmt: OpaquePointer?
        let sql = "SELECT count(*) FROM pages WHERE doc_id = ? AND words_json IS NOT NULL AND words_json != '[]'"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            return false
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int64(stmt, 1, docId)
        if sqlite3_step(stmt) == SQLITE_ROW {
            return sqlite3_column_int64(stmt, 0) > 0
        }
        return false
    }

    public func isDocumentCached(docId: Int64) -> Bool {
        if cachedDocIds.contains(docId) { return true }
        let target = pdfDirectoryURL.appendingPathComponent("\(docId).pdf")
        if FileManager.default.fileExists(atPath: target.path),
           let size = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int64), size > 0 {
            return true
        }
        return false
    }

    public func localPdfURL(for docId: Int64) -> URL {
        return pdfDirectoryURL.appendingPathComponent("\(docId).pdf")
    }

    public func getLocalPDFURL(docId: Int64) -> URL? {
        let target = localPdfURL(for: docId)
        if FileManager.default.fileExists(atPath: target.path),
           let size = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int64), size > 0 {
            return target
        }
        return nil
    }

    public func removeDocumentFromCache(docId: Int64) {
        let target = pdfDirectoryURL.appendingPathComponent("\(docId).pdf")
        try? FileManager.default.removeItem(at: target)
        _ = RustBridge.shared.deleteDocument(id: docId, at: dbURL)
        refreshCachedDocs()
    }

    public func folderCacheStatus(docIdsInFolder: [Int64]) -> (cachedCount: Int, totalCount: Int, isComplete: Bool) {
        guard !docIdsInFolder.isEmpty else { return (0, 0, false) }
        let cachedCount = docIdsInFolder.filter { isDocumentCached(docId: $0) }.count
        return (cachedCount, docIdsInFolder.count, cachedCount == docIdsInFolder.count)
    }

    public func removeFolderFromCache(docIdsInFolder: [Int64]) {
        for docId in docIdsInFolder {
            removeDocumentFromCache(docId: docId)
        }
    }

    public func seedDocument(docId: Int64, from sourceURL: URL, bundleJson: String? = nil) {
        let target = localPdfURL(for: docId)
        try? FileManager.default.removeItem(at: target)
        try? FileManager.default.copyItem(at: sourceURL, to: target)
        if let bundle = bundleJson {
            _ = RustBridge.shared.insertBundle(json: bundle, at: dbURL)
        }
        refreshCachedDocs()
    }

    /// CR-3 : Analyse et répare en tâche de fond tout document PDF présent sur disque mais manquant d'index FTS.
    /// Entièrement exécuté hors du thread principal pour ne pas bloquer l'UI au démarrage.
    public func repairCorruptedCachedDocuments() {
        Task(priority: .utility) {
            let fileManager = FileManager.default
            guard let contents = try? fileManager.contentsOfDirectory(at: self.pdfDirectoryURL, includingPropertiesForKeys: nil) else { return }
            
            var unindexedIds: [Int64] = []
            for file in contents where file.pathExtension.lowercased() == "pdf" {
                let name = file.deletingPathExtension().lastPathComponent
                // isDocumentIndexedLocally est une I/O SQLite — s'exécute maintenant sur le thread utility
                if let id = Int64(name), !self.isDocumentIndexedLocally(docId: id) {
                    unindexedIds.append(id)
                }
            }
            
            guard !unindexedIds.isEmpty, NetworkMonitor.shared.isConnected else { return }
            
            for docId in unindexedIds {
                do {
                    let bundleJson = try await APIClient.shared.fetchSyncBundle(docId: docId)
                    _ = RustBridge.shared.insertBundle(json: bundleJson, at: self.dbURL)
                    print("[LocalDatabase] Auto-réparation réussie pour l'index du document \(docId)")
                } catch {
                    print("[LocalDatabase] Impossible de réparer le bundle pour \(docId): \(error)")
                }
            }
            self.refreshCachedDocs()
        }
    }

    // MARK: - Requêtes SQLite Locales (Offline)

    public func getLocalFolders() -> [Folder] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbURL.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_close(db) }

        var stmt: OpaquePointer?
        let sql = "SELECT id, name, parent_id, color FROM folders ORDER BY name ASC"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_finalize(stmt) }

        var folders: [Folder] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = sqlite3_column_int64(stmt, 0)
            let name = String(cString: sqlite3_column_text(stmt, 1))
            let parentId = sqlite3_column_type(stmt, 2) != SQLITE_NULL ? sqlite3_column_int64(stmt, 2) : nil
            let color = sqlite3_column_type(stmt, 3) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 3)) : nil
            folders.append(Folder(id: id, name: name, parent_id: parentId, color: color))
        }
        return folders
    }

    public func getLocalDocuments(folderId: Int64?) -> [DocumentItem] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbURL.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_close(db) }

        var stmt: OpaquePointer?
        let sql: String
        if let fId = folderId {
            sql = "SELECT id, filename, title, folder_id, total_pages, file_size, created_at, updated_at FROM documents WHERE folder_id = ? ORDER BY title ASC"
        } else {
            sql = "SELECT id, filename, title, folder_id, total_pages, file_size, created_at, updated_at FROM documents WHERE folder_id IS NULL ORDER BY title ASC"
        }

        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_finalize(stmt) }

        if let fId = folderId {
            sqlite3_bind_int64(stmt, 1, fId)
        }

        var docs: [DocumentItem] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = sqlite3_column_int64(stmt, 0)
            let filename = String(cString: sqlite3_column_text(stmt, 1))
            let title = sqlite3_column_type(stmt, 2) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 2)) : filename
            let fId = sqlite3_column_type(stmt, 3) != SQLITE_NULL ? sqlite3_column_int64(stmt, 3) : nil
            let totalPages = sqlite3_column_int64(stmt, 4)
            let fileSize = sqlite3_column_type(stmt, 5) != SQLITE_NULL ? sqlite3_column_int64(stmt, 5) : nil
            let createdAt = sqlite3_column_type(stmt, 6) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 6)) : nil
            let updatedAt = sqlite3_column_type(stmt, 7) != SQLITE_NULL ? String(cString: sqlite3_column_text(stmt, 7)) : nil

            docs.append(DocumentItem(
                id: id,
                filename: filename,
                title: title,
                folder_id: fId,
                total_pages: totalPages,
                file_size: fileSize,
                created_at: createdAt,
                updated_at: updatedAt
            ))
        }
        return docs
    }

    /// Met à jour les associations document -> dossier dans SQLite local de façon atomique
    public func updateDocumentFolderMappings(mappings: [(docId: Int64, folderId: Int64?)]) {
        guard !mappings.isEmpty else { return }
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbURL.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else { return }
        defer { sqlite3_close(db) }

        sqlite3_exec(db, "PRAGMA foreign_keys = OFF;", nil, nil, nil)
        sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil)
        var stmt: OpaquePointer?
        let sql = "UPDATE documents SET folder_id = ? WHERE id = ?"
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            for item in mappings {
                if let fId = item.folderId {
                    sqlite3_bind_int64(stmt, 1, fId)
                } else {
                    sqlite3_bind_null(stmt, 1)
                }
                sqlite3_bind_int64(stmt, 2, item.docId)
                sqlite3_step(stmt)
                sqlite3_reset(stmt)
            }
            sqlite3_finalize(stmt)
        }
        sqlite3_exec(db, "COMMIT;", nil, nil, nil)
    }

    /// Synchronise l'intégralité du catalogue des métadonnées de documents dans SQLite local
    public func syncAllDocumentsMetadata(docs: [DocumentItem]) {
        guard !docs.isEmpty else { return }
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbURL.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else { return }
        defer { sqlite3_close(db) }

        sqlite3_exec(db, "PRAGMA foreign_keys = OFF;", nil, nil, nil)
        sqlite3_exec(db, "BEGIN TRANSACTION;", nil, nil, nil)
        var stmt: OpaquePointer?
        let sql = """
        INSERT INTO documents (id, filename, title, folder_id, total_pages, file_size, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(id) DO UPDATE SET
            filename = excluded.filename,
            title = excluded.title,
            folder_id = excluded.folder_id,
            total_pages = excluded.total_pages,
            file_size = excluded.file_size;
        """
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            for doc in docs {
                sqlite3_bind_int64(stmt, 1, doc.id)
                sqlite3_bind_text(stmt, 2, (doc.filename as NSString).utf8String, -1, nil)
                sqlite3_bind_text(stmt, 3, (doc.title as NSString).utf8String, -1, nil)
                if let fId = doc.folder_id {
                    sqlite3_bind_int64(stmt, 4, fId)
                } else {
                    sqlite3_bind_null(stmt, 4)
                }
                sqlite3_bind_int64(stmt, 5, doc.total_pages)
                if let size = doc.file_size {
                    sqlite3_bind_int64(stmt, 6, size)
                } else {
                    sqlite3_bind_null(stmt, 6)
                }
                sqlite3_step(stmt)
                sqlite3_reset(stmt)
            }
            sqlite3_finalize(stmt)
        }
        sqlite3_exec(db, "COMMIT;", nil, nil, nil)
    }
}

