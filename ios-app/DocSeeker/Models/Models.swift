// Models.swift
// Modèles de données Swift décodés depuis le serveur NAS ou le moteur Rust local

import Foundation

public struct Folder: Codable, Identifiable, Hashable {
    public let id: Int64
    public let name: String
    public let parent_id: Int64?
    public let color: String?
}

public struct DocumentItem: Codable, Identifiable, Hashable {
    public let id: Int64
    public let filename: String
    public let title: String
    public let folder_id: Int64?
    public let total_pages: Int64
    public let file_size: Int64?
    public let created_at: String?
    public let updated_at: String?
}

public struct OccurrenceResult: Codable, Identifiable, Hashable {
    public var id: String { "\(page_number)_\(occ_id)" }
    public let page_number: Int64
    public let occ_id: Int
    public let crop_url: String?
    public let text_snippet: String?
    public let distinct_terms_count: Int?
    public let matched_terms: [String]?
    public let y_ratio: Double?
    public let y_pos: Double?
    public let rect: [Double]
    public let highlight_rects: [[Double]]?
    public let bm25_score: Double?
    public let font_size: Double?
    
    public init(
        page_number: Int64,
        occ_id: Int = 1,
        crop_url: String? = nil,
        text_snippet: String? = nil,
        distinct_terms_count: Int? = nil,
        matched_terms: [String]? = nil,
        y_ratio: Double? = nil,
        y_pos: Double? = nil,
        rect: [Double] = [0, 0, 100, 100],
        highlight_rects: [[Double]]? = nil,
        bm25_score: Double? = nil,
        font_size: Double? = nil
    ) {
        self.page_number = page_number
        self.occ_id = occ_id
        self.crop_url = crop_url
        self.text_snippet = text_snippet
        self.distinct_terms_count = distinct_terms_count
        self.matched_terms = matched_terms
        self.y_ratio = y_ratio
        self.y_pos = y_pos
        self.rect = rect
        self.highlight_rects = highlight_rects
        self.bm25_score = bm25_score
        self.font_size = font_size
    }
}

public struct DocumentSearchResult: Codable, Identifiable, Hashable {
    public let id: Int64
    public let filename: String
    public let title: String
    public let folder_id: Int64?
    public let total_pages: Int64
    public let created_at: String?
    public let updated_at: String?
    public let cover_url: String?
    public let vignettes: [OccurrenceResult]?
    public let occurrences_by_page: [OccurrenceResult]?
    public let total_occurrences: Int
    public let relevance_score: Double
    public let matched_all_terms: Bool?
}

public struct SearchResponse: Codable {
    public let query: String
    public let query_hash: String
    public let total_documents: Int
    public let total_occurrences: Int
    public let results: [DocumentSearchResult]
    public let page: Int
    public let limit: Int
    public let total_pages: Int
    public let has_more: Bool
}

public struct DocSearchResponse: Codable {
    public let doc_id: Int64
    public let query: String
    public let total_occurrences: Int
    public let occurrences: [OccurrenceResult]
}
