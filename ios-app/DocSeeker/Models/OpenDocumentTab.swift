// OpenDocumentTab.swift
// Modèle de données représentant un onglet de document PDF ouvert (Style Goodnotes)

import Foundation

public struct OpenDocumentTab: Identifiable, Equatable {
    public let id: UUID
    public let docId: Int64
    public var title: String
    public var filename: String
    public var currentPage: Int
    public var activeOccurrenceIndex: Int
    public var occurrences: [OccurrenceResult]
    public var searchQuery: String?
    public var folderPath: String?
    
    public init(
        id: UUID = UUID(),
        docId: Int64,
        title: String,
        filename: String,
        currentPage: Int = 1,
        activeOccurrenceIndex: Int = 0,
        occurrences: [OccurrenceResult] = [],
        searchQuery: String? = nil,
        folderPath: String? = nil
    ) {
        self.id = id
        self.docId = docId
        self.title = title
        self.filename = filename
        self.currentPage = currentPage
        self.activeOccurrenceIndex = activeOccurrenceIndex
        self.occurrences = occurrences
        self.searchQuery = searchQuery
        self.folderPath = folderPath
    }
    
    public static func == (lhs: OpenDocumentTab, rhs: OpenDocumentTab) -> Bool {
        lhs.id == rhs.id
    }
}
