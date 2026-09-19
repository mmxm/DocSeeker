// InDocumentSearchDrawer.swift
// Volet latéral pleine largeur pour les vignettes d'occurrences et la recherche interne au document (Style Goodnotes)

import SwiftUI

public struct InDocumentSearchDrawer: View {
    public let documentId: Int64
    public let documentTitle: String
    public let filename: String
    public let currentOccurrences: [OccurrenceResult]
    public let initialQuery: String
    public let activeOccurrenceIndex: Int
    public let onSelectOccurrence: (OccurrenceResult, String) -> Void
    
    @Environment(\.dismiss) private var dismiss
    @State private var query: String = ""
    @State private var occurrences: [OccurrenceResult] = []
    @State private var isSearching: Bool = false
    @State private var errorMessage: String? = nil
    
    @ObservedObject private var localDb = LocalDatabase.shared
    
    public init(
        documentId: Int64,
        documentTitle: String,
        filename: String,
        currentOccurrences: [OccurrenceResult],
        initialQuery: String = "",
        activeOccurrenceIndex: Int = 0,
        onSelectOccurrence: @escaping (OccurrenceResult, String) -> Void
    ) {
        self.documentId = documentId
        self.documentTitle = documentTitle
        self.filename = filename
        self.currentOccurrences = currentOccurrences
        self.initialQuery = initialQuery
        self.activeOccurrenceIndex = activeOccurrenceIndex
        self._query = State(initialValue: initialQuery)
        self._occurrences = State(initialValue: currentOccurrences)
        self.onSelectOccurrence = onSelectOccurrence
    }
    
    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Barre de recherche interne au document
                HStack(spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(.secondary)
                        TextField("Rechercher dans ce document...", text: $query)
                            .textFieldStyle(.plain)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .onSubmit {
                                performInDocSearch()
                            }
                        if !query.isEmpty {
                            Button(action: {
                                query = ""
                                occurrences = currentOccurrences
                            }) {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .padding(8)
                    .background(Color(.tertiarySystemFill))
                    .cornerRadius(10)
                    
                    if !query.isEmpty {
                        Button("Chercher") {
                            performInDocSearch()
                        }
                        .font(.subheadline.bold())
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemGroupedBackground))
                
                Divider()
                
                // Liste des vignettes en pleine largeur avec auto-défilement
                if isSearching {
                    VStack(spacing: 12) {
                        Spacer()
                        ProgressView()
                        Text("Recherche dans le document...")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Spacer()
                    }
                } else if occurrences.isEmpty {
                    VStack(spacing: 12) {
                        Spacer()
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 40))
                            .foregroundColor(.secondary.opacity(0.4))
                        Text(query.isEmpty ? "Entrez des mots-clés pour rechercher dans ce document" : "Aucune occurrence trouvée pour \"\(query)\"")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                        Spacer()
                    }
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 14) {
                                HStack {
                                    Text("\(occurrences.count) extraits trouvés")
                                        .font(.caption.bold())
                                        .foregroundColor(.secondary)
                                        .accessibilityIdentifier("occurrences_count_label")
                                    Spacer()
                                }
                                .padding(.horizontal, 16)
                                .padding(.top, 10)
                                
                                ForEach(Array(occurrences.enumerated()), id: \.element.id) { index, occ in
                                    occurrenceItemView(index: index, occ: occ)
                                        .id(occ.id)
                                        .padding(.horizontal, 16)
                                }
                            }
                            .padding(.bottom, 24)
                        }
                        .onAppear {
                            if occurrences.indices.contains(activeOccurrenceIndex) {
                                proxy.scrollTo(occurrences[activeOccurrenceIndex].id, anchor: .center)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Extraits du document")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer") {
                        dismiss()
                    }
                    .accessibilityIdentifier("drawer_close")
                }
            }
        }
    }
    
    private func performInDocSearch() {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            occurrences = currentOccurrences
            return
        }
        
        isSearching = true
        errorMessage = nil
        
        Task {
            var results: [OccurrenceResult] = []
            
            // 1. Recherche ciblée dans ce document via le moteur local Rust
            if let localRes = RustBridge.shared.docSearchLocal(docId: documentId, query: trimmed, at: localDb.dbURL),
               !localRes.occurrences.isEmpty {
                results = localRes.occurrences
            }
            
            // 2. Si non présent ou vide en local et qu'on est en ligne, recherche via l'API serveur
            if results.isEmpty && !localDb.isDocumentCached(docId: documentId) && NetworkMonitor.shared.isConnected {
                if let apiRes = try? await APIClient.shared.docSearch(docId: documentId, query: trimmed),
                   !apiRes.occurrences.isEmpty {
                    results = apiRes.occurrences
                }
            }
            
            // 3. Fallback recherche générale
            if results.isEmpty {
                let searchRes = RustBridge.shared.searchLocal(query: trimmed, folderId: nil, titlesOnly: false, at: localDb.dbURL)
                results = searchRes?.results.first(where: { $0.id == documentId })?.vignettes ?? []
            }
            
            await MainActor.run {
                self.occurrences = results
                self.isSearching = false
            }
        }
    }
    
    @ViewBuilder
    private func occurrenceItemView(index: Int, occ: OccurrenceResult) -> some View {
        let isCurrent = (index == activeOccurrenceIndex)
        Button(action: {
            onSelectOccurrence(occ, query.isEmpty ? initialQuery : query)
            dismiss()
        }) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Page \(occ.page_number)", systemImage: "doc.plaintext")
                        .font(.caption.bold())
                        .foregroundColor(isCurrent ? .blue : .primary)
                    
                    if isCurrent {
                        Text("Actif")
                            .font(.caption2.bold())
                            .foregroundColor(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.blue)
                            .cornerRadius(4)
                    }
                    
                    Spacer()
                    Text("#\(index + 1)")
                        .font(.caption2.monospacedDigit())
                        .foregroundColor(.secondary)
                }
                
                OccurrenceCropImageView(
                    documentId: documentId,
                    filename: filename,
                    occurrence: occ
                )
                .frame(height: 110)
                .frame(maxWidth: .infinity)
                .background(Color.white)
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(isCurrent ? Color.blue : Color.black.opacity(0.08), lineWidth: isCurrent ? 2 : 1)
                )
                
                if let text = occ.text_snippet, !text.isEmpty {
                    Text(text)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground))
            .cornerRadius(12)
            .shadow(color: isCurrent ? Color.blue.opacity(0.12) : Color.black.opacity(0.03), radius: 3, x: 0, y: 1)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("drawer_occurrence_\(index)")
    }
}
