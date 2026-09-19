// RustBridge.swift
// Pont natif Swift vers le cœur algorithmique DocSeekerCore en Rust

import Foundation

public struct CropBoundsResult {
    public let x0: Double
    public let y0: Double
    public let width: Double
    public let height: Double
}

public final class RustBridge {
    public static let shared = RustBridge()
    private init() {}

    /// Initialise la base SQLite locale avec schéma et FTS5
    public func initDatabase(at dbURL: URL) -> Bool {
        let path = dbURL.path
        return docseeker_init_db(path) == 0
    }

    /// Insère atomiquement un bundle de document dans la base locale
    public func insertBundle(json: String, at dbURL: URL) -> Bool {
        let path = dbURL.path
        return docseeker_insert_bundle(path, json) == 0
    }

    /// Synchronise l'ensemble de l'arborescence des dossiers
    public func syncFolders(json: String, at dbURL: URL) -> Bool {
        let path = dbURL.path
        return docseeker_sync_folders(path, json) == 0
    }

    /// Supprime un document de la base locale
    public func deleteDocument(id: Int64, at dbURL: URL) -> Bool {
        let path = dbURL.path
        return docseeker_delete_doc(path, id) == 0
    }

    /// Exécute une recherche locale FTS5 + BM25 avec scoring Goodnotes
    public func searchLocal(query: String, folderId: Int64?, titlesOnly: Bool = false, limit: Int = 15, offset: Int = 0, at dbURL: URL) -> SearchResponse? {
        let path = dbURL.path
        let hasFolder: Int32 = (folderId != nil) ? 1 : 0
        let fId: Int64 = folderId ?? 0

        guard let cStr = docseeker_search_local(path, query, fId, hasFolder, limit, offset) else {
            return nil
        }
        defer { docseeker_free_string(cStr) }

        let jsonString = String(cString: cStr)
        guard let data = jsonString.data(using: .utf8) else { return nil }

        guard var resp = try? JSONDecoder().decode(SearchResponse.self, from: data) else { return nil }
        if titlesOnly {
            let filteredDocs = resp.results.filter { $0.title.localizedCaseInsensitiveContains(query) }
            resp = SearchResponse(
                query: resp.query,
                query_hash: resp.query_hash,
                total_documents: filteredDocs.count,
                total_occurrences: filteredDocs.reduce(0) { $0 + $1.total_occurrences },
                results: filteredDocs,
                page: resp.page,
                limit: resp.limit,
                total_pages: resp.total_pages,
                has_more: resp.has_more
            )
        }
        return resp
    }

    /// Recherche au sein d'un document unique pour le tiroir d'occurrences
    public func docSearchLocal(docId: Int64, query: String, at dbURL: URL) -> DocSearchResponse? {
        let path = dbURL.path
        guard let cStr = docseeker_doc_search_local(path, docId, query) else {
            return nil
        }
        defer { docseeker_free_string(cStr) }

        let jsonString = String(cString: cStr)
        guard let data = jsonString.data(using: .utf8) else { return nil }

        if let direct = try? JSONDecoder().decode(DocSearchResponse.self, from: data) {
            if direct.total_occurrences > 0 {
                return direct
            }
        }
        
        // Support du format tuple Rust (total, [occurrences])
        struct TupleResponse: Decodable {
            let total: Int
            let occurrences: [OccurrenceResult]
            init(from decoder: Decoder) throws {
                var container = try decoder.unkeyedContainer()
                self.total = try container.decode(Int.self)
                self.occurrences = try container.decode([OccurrenceResult].self)
            }
        }
        if let tuple = try? JSONDecoder().decode(TupleResponse.self, from: data) {
            if tuple.total > 0 {
                return DocSearchResponse(
                    doc_id: docId,
                    query: query,
                    total_occurrences: tuple.total,
                    occurrences: tuple.occurrences
                )
            }
        }

        // Fallback direct via le moteur searchLocal
        if let searchRes = searchLocal(query: query, folderId: nil, titlesOnly: false, at: dbURL),
           let matchingDoc = searchRes.results.first(where: { $0.id == docId }) {
            let occs = matchingDoc.vignettes ?? []
            return DocSearchResponse(
                doc_id: docId,
                query: query,
                total_occurrences: occs.count,
                occurrences: occs
            )
        }

        return DocSearchResponse(
            doc_id: docId,
            query: query,
            total_occurrences: 0,
            occurrences: []
        )
    }

    /// Calcule le cadrage d'une occurrence
    public func calculateCropBounds(rect: [Double], pageWidth: Double, pageHeight: Double) -> CropBoundsResult {
        guard rect.count == 4 else {
            return CropBoundsResult(x0: 0, y0: 0, width: pageWidth, height: pageHeight)
        }
        var x0: Double = 0
        var y0: Double = 0
        var w: Double = 0
        var h: Double = 0

        docseeker_calculate_crop_bounds(rect[0], rect[1], rect[2], rect[3], pageWidth, pageHeight, &x0, &y0, &w, &h)
        return CropBoundsResult(x0: x0, y0: y0, width: w, height: h)
    }
}
