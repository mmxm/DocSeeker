// SearchView.swift
// Écran principal de recherche hybride (En ligne via API REST / Hors-ligne via Rust C-ABI)

import SwiftUI

public struct SearchView: View {
    @State private var query: String = ""
    @State private var titlesOnly: Bool = false
    @State private var selectedFolderId: Int64? = nil
    @State private var results: [DocumentSearchResult] = []
    @State private var totalOccurrences: Int = 0
    @State private var totalDocuments: Int = 0
    @State private var isSearching: Bool = false
    @State private var errorMessage: String? = nil
    
    // Lecteur PDF actif
    @State private var activeDocument: DocumentSearchResult? = nil
    @State private var activeOccurrence: OccurrenceResult? = nil
    @State private var showReader: Bool = false
    
    @ObservedObject private var network = NetworkMonitor.shared
    @ObservedObject private var api = APIClient.shared
    @ObservedObject private var localDb = LocalDatabase.shared
    
    public init() {}
    
    public var body: some View {
        VStack(spacing: 0) {
            // En-tête compact moderne sans titre pour maximiser la zone utile
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(.secondary)
                        TextField("Rechercher dans les documents...", text: $query)
                            .textFieldStyle(.plain)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .onChange(of: query) {
                                debounceSearch()
                            }
                            .onSubmit {
                                performSearch()
                            }
                        if !query.isEmpty {
                            Button(action: {
                                query = ""
                                results = []
                                totalOccurrences = 0
                                totalDocuments = 0
                            }) {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundColor(.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(8)
                    .background(Color(.tertiarySystemFill))
                    .cornerRadius(10)
                    
                    // Badge Réseau / Mode
                    HStack(spacing: 4) {
                        Circle()
                            .fill(isOfflineMode ? Color.orange : Color.green)
                            .frame(width: 8, height: 8)
                        Text(isOfflineMode ? "Hors-ligne" : "En ligne")
                            .font(.caption2.bold())
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 7)
                    .background(Color(.tertiarySystemFill))
                    .cornerRadius(8)
                    
                    Toggle("Titres", isOn: $titlesOnly)
                        .toggleStyle(.button)
                        .font(.caption2.bold())
                        .controlSize(.small)
                        .onChange(of: titlesOnly) {
                            performSearch()
                        }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 6)
            
            Divider()
            
            // Corps de l'écran
            ZStack {
                Color(.systemGroupedBackground)
                    .edgesIgnoringSafeArea(.all)
                
                if isSearching {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Recherche en cours...")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                } else if let error = errorMessage {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.largeTitle)
                            .foregroundColor(.orange)
                        Text(error)
                            .font(.subheadline)
                            .multilineTextAlignment(.center)
                            .foregroundColor(.secondary)
                    }
                    .padding()
                } else if results.isEmpty {
                    emptyStateView
                } else {
                    resultsListView
                }
            }
        }
        .fullScreenCover(isPresented: $showReader) {
            if let doc = activeDocument {
                PDFReaderView(
                    documentId: doc.id,
                    documentTitle: doc.title,
                    filename: doc.filename,
                    initialPage: activeOccurrence != nil ? Int(activeOccurrence!.page_number) : nil,
                    initialRect: activeOccurrence?.rect,
                    occurrences: doc.vignettes ?? []
                )
            }
        }
    }
    
    private var isOfflineMode: Bool {
        !network.isConnected
    }
    
    private var emptyStateView: some View {
        VStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 48))
                .foregroundColor(.secondary.opacity(0.5))
            
            if query.isEmpty {
                Text("Entrez des mots-clés pour explorer vos documents")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            } else {
                Text("Aucun résultat pour \"\(query)\"")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
        }
        .padding()
    }
    
    private var resultsListView: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                HStack {
                    Text("\(totalDocuments) documents (\(totalOccurrences) extraits)")
                        .font(.caption.bold())
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, 8)
                
                ForEach(results) { doc in
                    DocumentCardView(
                        document: doc,
                        onOpenDocument: { targetDoc, targetOcc in
                            self.activeDocument = targetDoc
                            self.activeOccurrence = targetOcc
                            self.showReader = true
                        }
                    )
                    .padding(.horizontal)
                }
            }
            .padding(.bottom, 20)
        }
    }
    
    @State private var searchTask: Task<Void, Never>? = nil
    
    private func debounceSearch() {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 350_000_000) // 350ms debounce
            guard !Task.isCancelled else { return }
            performSearch()
        }
    }
    
    private func performSearch() {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            results = []
            totalOccurrences = 0
            totalDocuments = 0
            return
        }
        
        isSearching = true
        errorMessage = nil
        
        Task {
            if isOfflineMode {
                // Recherche locale hors-ligne via Rust C-ABI
                let response = RustBridge.shared.searchLocal(
                    query: trimmed,
                    folderId: selectedFolderId,
                    titlesOnly: titlesOnly,
                    at: localDb.dbURL
                )
                await MainActor.run {
                    self.isSearching = false
                    if let res = response {
                        self.results = res.results
                        self.totalDocuments = res.total_documents
                        self.totalOccurrences = res.total_occurrences
                    } else {
                        self.errorMessage = "Échec de la recherche locale Rust"
                    }
                }
            } else {
                // Recherche en ligne via NAS
                do {
                    let res = try await api.searchOnline(
                        query: trimmed,
                        folderId: selectedFolderId,
                        titlesOnly: titlesOnly
                    )
                    await MainActor.run {
                        self.isSearching = false
                        self.results = res.results
                        self.totalDocuments = res.total_documents
                        self.totalOccurrences = res.total_occurrences
                    }
                } catch {
                    await MainActor.run {
                        self.isSearching = false
                        self.errorMessage = error.localizedDescription
                    }
                }
            }
        }
    }
}
