// OccurrenceDrawerView.swift
// Tiroir vertical virtualisé de toutes les occurrences d'un document

import SwiftUI

public enum OccurrenceSortOrder: String, CaseIterable, Identifiable {
    case relevance = "Pertinence"
    case page = "Ordre de page"
    
    public var id: String { rawValue }
}

public struct OccurrenceDrawerView: View {
    public let documentTitle: String
    public let documentId: Int64
    public let filename: String
    public let occurrences: [OccurrenceResult]
    public let onSelectOccurrence: (OccurrenceResult) -> Void
    
    @Environment(\.dismiss) private var dismiss
    @State private var sortOrder: OccurrenceSortOrder = .relevance
    @State private var filterQuery: String = ""
    
    public init(
        documentTitle: String,
        documentId: Int64,
        filename: String,
        occurrences: [OccurrenceResult],
        onSelectOccurrence: @escaping (OccurrenceResult) -> Void
    ) {
        self.documentTitle = documentTitle
        self.documentId = documentId
        self.filename = filename
        self.occurrences = occurrences
        self.onSelectOccurrence = onSelectOccurrence
    }
    
    private var sortedAndFilteredOccurrences: [OccurrenceResult] {
        var list = occurrences
        if !filterQuery.isEmpty {
            list = list.filter { occ in
                let snippetMatches = occ.text_snippet?.localizedCaseInsensitiveContains(filterQuery) ?? false
                let pageMatches = String(occ.page_number).contains(filterQuery)
                return snippetMatches || pageMatches
            }
        }
        switch sortOrder {
        case .relevance:
            return list.sorted { ($0.bm25_score ?? 0) > ($1.bm25_score ?? 0) }
        case .page:
            return list.sorted {
                if $0.page_number == $1.page_number {
                    return ($0.y_pos ?? 0) < ($1.y_pos ?? 0)
                }
                return $0.page_number < $1.page_number
            }
        }
    }
    
    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Barre de contrôle : Tri & Recherche locale
                VStack(spacing: 8) {
                    Picker("Tri", selection: $sortOrder) {
                        ForEach(OccurrenceSortOrder.allCases) { order in
                            Text(order.rawValue).tag(order)
                        }
                    }
                    .pickerStyle(.segmented)
                    
                    HStack {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(.secondary)
                        TextField("Filtrer les extraits (mots, page...)", text: $filterQuery)
                            .textFieldStyle(.plain)
                        if !filterQuery.isEmpty {
                            Button(action: { filterQuery = "" }) {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .padding(8)
                    .background(Color(.tertiarySystemFill))
                    .cornerRadius(8)
                }
                .padding(.horizontal)
                .padding(.top, 8)
                .padding(.bottom, 8)
                
                Divider()
                
                // Liste virtualisée avec LazyVStack
                ScrollView {
                    LazyVStack(spacing: 16) {
                        ForEach(sortedAndFilteredOccurrences) { occ in
                            Button(action: {
                                onSelectOccurrence(occ)
                                dismiss()
                            }) {
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack {
                                        Label("Page \(occ.page_number)", systemImage: "doc.text")
                                            .font(.subheadline.bold())
                                            .foregroundColor(.primary)
                                        
                                        Spacer()
                                        
                                        if let score = occ.bm25_score {
                                            Text(String(format: "Score: %.1f", score))
                                                .font(.caption2)
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(Color.accentColor.opacity(0.15))
                                                .foregroundColor(.accentColor)
                                                .cornerRadius(4)
                                        }
                                    }
                                    
                                    OccurrenceCropImageView(
                                        documentId: documentId,
                                        filename: filename,
                                        occurrence: occ
                                    )
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 140)
                                    
                                    if let snippet = occ.text_snippet, !snippet.isEmpty {
                                        Text(snippet)
                                            .font(.footnote)
                                            .foregroundColor(.secondary)
                                            .lineLimit(3)
                                    }
                                }
                                .padding(12)
                                .background(Color(.secondarySystemGroupedBackground))
                                .cornerRadius(10)
                                .shadow(color: Color.black.opacity(0.04), radius: 3, x: 0, y: 1)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding()
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("\(sortedAndFilteredOccurrences.count) Extraits")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer") {
                        dismiss()
                    }
                }
            }
        }
    }
}
