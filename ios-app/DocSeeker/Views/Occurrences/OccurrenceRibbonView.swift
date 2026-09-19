// OccurrenceRibbonView.swift
// Ruban horizontal d'extraits d'occurrences pour une carte document

import SwiftUI

public struct OccurrenceRibbonView: View {
    public let document: DocumentSearchResult
    public let onSelectOccurrence: (OccurrenceResult) -> Void
    public let onOpenDrawer: () -> Void
    
    public init(
        document: DocumentSearchResult,
        onSelectOccurrence: @escaping (OccurrenceResult) -> Void,
        onOpenDrawer: @escaping () -> Void
    ) {
        self.document = document
        self.onSelectOccurrence = onSelectOccurrence
        self.onOpenDrawer = onOpenDrawer
    }
    
    private var occurrences: [OccurrenceResult] {
        document.vignettes ?? []
    }
    
    public var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 12) {
                ForEach(occurrences) { occ in
                    Button(action: {
                        onSelectOccurrence(occ)
                    }) {
                        VStack(alignment: .leading, spacing: 4) {
                            ZStack(alignment: .topTrailing) {
                                OccurrenceCropImageView(
                                    documentId: document.id,
                                    filename: document.filename,
                                    occurrence: occ
                                )
                                .frame(width: 170, height: 100)
                                
                                Text("p. \(occ.page_number)")
                                    .font(.caption2.bold())
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(.ultraThinMaterial)
                                    .cornerRadius(4)
                                    .padding(4)
                            }
                            
                            if let snippet = occ.text_snippet, !snippet.isEmpty {
                                Text(snippet)
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                                    .lineLimit(2)
                                    .frame(width: 170, alignment: .leading)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
                
                if document.total_occurrences > occurrences.count {
                    Button(action: onOpenDrawer) {
                        VStack(spacing: 8) {
                            Image(systemName: "rectangle.stack.badge.play")
                                .font(.title2)
                                .foregroundColor(.accentColor)
                            Text("Voir les \(document.total_occurrences)\nextraits")
                                .font(.caption.bold())
                                .multilineTextAlignment(.center)
                                .foregroundColor(.accentColor)
                        }
                        .frame(width: 110, height: 100)
                        .background(Color(.secondarySystemBackground))
                        .cornerRadius(6)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(Color.accentColor.opacity(0.3), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
        }
    }
}
