// DocumentListView.swift
// Vue explorateur style Goodnotes mobile (Screenshot 1) :
// - Dossiers et fichiers strictement en LISTE (pas de grille d'icônes)
// - En-tête compact sans grand titre pour maximiser l'espace
// - Parcours complet de l'arborescence avec bouton retour en haut à gauche
// - Bouton de recherche flottant en haut à droite avec scope dossier courant
// - Synchronisation style iCloud avec possibilité d'arrêter la synchronisation immédiatement
// - Clic sur document ou résultat de recherche ouvre un nouvel onglet dans le lecteur Goodnotes

import SwiftUI

public struct DocumentListView: View {
    @ObservedObject private var api = APIClient.shared
    @ObservedObject private var localDb = LocalDatabase.shared
    @ObservedObject private var downloadQueue = DownloadQueueManager.shared
    @ObservedObject private var tabManager = DocumentTabManager.shared
    @ObservedObject private var network = NetworkMonitor.shared
    
    // Navigation dans l'arborescence
    @State private var folderStack: [Folder] = []
    @State private var allFolders: [Folder] = []
    @State private var currentDocuments: [DocumentItem] = []
    @State private var folderDocs: [Int64: [DocumentItem]] = [:]
    
    // États de chargement et synchronisation
    @State private var isLoading: Bool = false
    @State private var isSyncing: Bool = false
    @State private var errorMessage: String? = nil
    
    // Mode recherche
    @State private var isSearchActive: Bool = false
    @State private var searchQuery: String = ""
    @State private var searchResults: [DocumentSearchResult] = []
    @State private var totalOccurrences: Int = 0
    @State private var totalDocuments: Int = 0
    @State private var isSearching: Bool = false
    @State private var titlesOnly: Bool = false
    @State private var searchTask: Task<Void, Never>? = nil
    @State private var showOfflineAlert: Bool = false
    @State private var offlineAlertDocTitle: String = ""
    
    public init() {}
    
    private var currentFolderId: Int64? {
        folderStack.last?.id
    }
    
    private var currentTitle: String {
        if isSearchActive {
            return "Recherche"
        }
        return folderStack.last?.name ?? "Documents"
    }
    
    /// Dossiers enfants du dossier courant
    private var childFolders: [Folder] {
        allFolders.filter { $0.parent_id == currentFolderId }
    }
    
    private var isOfflineMode: Bool {
        !network.isConnected || !api.isServerReachable || api.serverURL.contains(":9999")
    }
    
    public var body: some View {
        VStack(spacing: 0) {
            // 1. En-tête compact moderne (Pas de grand titre!)
            compactHeader
            
            // 2. Barre de recherche contextuelle si mode recherche actif
            if isSearchActive {
                searchBarView
            }
            
            Divider()
            
            // 3. Corps principal (Liste ou Résultats de recherche)
            ZStack {
                Color(.systemGroupedBackground)
                    .edgesIgnoringSafeArea(.all)
                
                if isSearchActive {
                    searchResultsView
                } else {
                    fileExplorerListView
                }
            }
        }
        .alert("Document non disponible hors-ligne", isPresented: $showOfflineAlert) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("\"\(offlineAlertDocTitle)\" n'a pas encore été téléchargé sur cet appareil. Connectez-vous à Internet pour le consulter.")
        }
        .task {
            await refreshAll()
        }
    }
    
    // MARK: - En-tête Compact (Style Goodnotes)
    private var compactHeader: some View {
        HStack(spacing: 12) {
            // Bouton retour arborescence / quitter la recherche
            if isSearchActive || !folderStack.isEmpty {
                Button(action: {
                    if isSearchActive {
                        isSearchActive = false
                        searchQuery = ""
                        searchResults = []
                    } else if !folderStack.isEmpty {
                        folderStack.removeLast()
                        Task { await loadContentsForCurrentFolder() }
                    }
                }) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 16, weight: .bold))
                        if isSearchActive {
                            Text("Retour")
                                .font(.subheadline)
                        } else if let parentName = folderStack.dropLast().last?.name {
                            Text(parentName)
                                .font(.subheadline)
                                .lineLimit(1)
                        } else {
                            Text("Documents")
                                .font(.subheadline)
                        }
                    }
                    .foregroundColor(.accentColor)
                }
                .accessibilityLabel("Retour")
            } else {
                Button(action: {
                    Task {
                        _ = await api.probeServerReachability()
                        await refreshAll()
                    }
                }) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(isOfflineMode ? Color.orange : Color.green)
                            .frame(width: 8, height: 8)
                        Text(isOfflineMode ? "Hors-ligne" : "Connecté")
                            .font(.caption2.bold())
                            .foregroundColor(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("network_status_indicator")
            }
            
            Spacer()
            
            // Titre compact centré (jamais de grand titre encombrant)
            Text(currentTitle)
                .font(.headline)
                .foregroundColor(.primary)
                .lineLimit(1)
            
            Spacer()
            
            // Boutons d'actions à droite
            HStack(spacing: 12) {
                // Bouton de synchronisation globale / rafraîchissement
                Button(action: {
                    Task { await refreshAll() }
                }) {
                    Image(systemName: isSyncing ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.secondary)
                        .rotationEffect(.degrees(isSyncing ? 360 : 0))
                        .animation(isSyncing ? Animation.linear(duration: 1).repeatForever(autoreverses: false) : .default, value: isSyncing)
                }
                .accessibilityLabel("Synchroniser")
                
                // Bouton recherche flottant en haut
                Button(action: {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        isSearchActive.toggle()
                        if !isSearchActive {
                            searchQuery = ""
                            searchResults = []
                        }
                    }
                }) {
                    Image(systemName: isSearchActive ? "xmark" : "magnifyingglass")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(isSearchActive ? .primary : .accentColor)
                        .padding(8)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(Circle())
                }
                .accessibilityLabel("Rechercher dans le dossier")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(.systemBackground))
    }
    
    // MARK: - Barre de Recherche
    private var searchBarView: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundColor(.secondary)
                TextField(
                    currentFolderId == nil ? "Rechercher dans tous les documents..." : "Rechercher dans \"\(currentTitle)\"...",
                    text: $searchQuery
                )
                .textFieldStyle(.plain)
                .autocapitalization(.none)
                .disableAutocorrection(true)
                .onSubmit {
                    performSearch()
                }
                
                if !searchQuery.isEmpty {
                    Button(action: {
                        searchQuery = ""
                        searchResults = []
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
            
            Toggle("Titres", isOn: $titlesOnly)
                .toggleStyle(.button)
                .font(.caption2.bold())
                .controlSize(.small)
                .onChange(of: titlesOnly) {
                    performSearch()
                }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(.systemBackground))
    }
    
    // MARK: - Liste Unifiée de Fichiers et Dossiers (Sans délimitation ni mentions Dossiers/Documents)
    private var fileExplorerListView: some View {
        List {
            if isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .listRowBackground(Color.clear)
            } else if currentDocuments.isEmpty && childFolders.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "folder")
                        .font(.system(size: 40))
                        .foregroundColor(.secondary.opacity(0.4))
                    Text("Aucun document dans ce dossier")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
                .listRowBackground(Color.clear)
            } else {
                // Dossiers puis documents dans la même liste continue sans délimitation
                ForEach(childFolders) { folder in
                    folderRowView(folder: folder)
                }
                
                ForEach(currentDocuments) { doc in
                    documentRowView(doc: doc)
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await refreshAll()
        }
    }
    
    // MARK: - Ligne de Dossier
    private func folderRowView(folder: Folder) -> some View {
        let docsInFolder = folderDocs[folder.id] ?? []
        let docIds = docsInFolder.map { $0.id }
        let status = localDb.folderCacheStatus(docIdsInFolder: docIds)
        let syncProg = downloadQueue.folderSyncProgress(docIds: docIds)
        
        return HStack(spacing: 12) {
            Image(systemName: "folder.fill")
                .font(.title3)
                .foregroundColor(colorForFolder(folder))
            
            VStack(alignment: .leading, spacing: 2) {
                Text(folder.name)
                    .font(.body.weight(.medium))
                    .foregroundColor(.primary)
                
                Text("\(docsInFolder.count) document\(docsInFolder.count > 1 ? "s" : "")")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            Spacer()
            
            // Contrôle de synchronisation iCloud pour le dossier
            HStack(spacing: 8) {
                if syncProg.isSyncing {
                    // Synchronisation en cours avec bouton STOP
                    HStack(spacing: 6) {
                        ProgressView()
                            .scaleEffect(0.7)
                        
                        Button(action: {
                            downloadQueue.cancelFolderDownload(docIds: docIds)
                        }) {
                            Image(systemName: "stop.circle.fill")
                                .font(.system(size: 18))
                                .foregroundColor(.red)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Arrêter la synchronisation du dossier")
                    }
                } else if status.isComplete && !docIds.isEmpty {
                    // Entièrement en cache
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                        .font(.system(size: 18))
                } else if status.cachedCount > 0 {
                    // Partiellement en cache
                    Text("\(status.cachedCount)/\(status.totalCount)")
                        .font(.caption2.bold())
                        .foregroundColor(.blue)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.blue.opacity(0.12))
                        .cornerRadius(4)
                } else if !docIds.isEmpty {
                    // Non synchronisé : bouton télécharger
                    Button(action: {
                        downloadEntireFolder(folderId: folder.id, docs: docsInFolder)
                    }) {
                        Image(systemName: "arrow.down.circle")
                            .foregroundColor(.accentColor)
                            .font(.system(size: 18))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Synchroniser tout le dossier")
                }
                
                // Flèche indiquant la navigation
                Image(systemName: "chevron.right")
                    .font(.caption.bold())
                    .foregroundColor(.secondary.opacity(0.5))
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture {
            folderStack.append(folder)
            Task { await loadContentsForCurrentFolder() }
        }
        .accessibilityIdentifier("folder_row_\(folder.id)")
        .contextMenu {
            if syncProg.isSyncing {
                Button(role: .destructive) {
                    downloadQueue.cancelFolderDownload(docIds: docIds)
                } label: {
                    Label("Arrêter la synchronisation", systemImage: "stop.circle")
                }
            } else {
                Button {
                    downloadEntireFolder(folderId: folder.id, docs: docsInFolder)
                } label: {
                    Label("Synchroniser tout le dossier", systemImage: "arrow.down.circle")
                }
            }
            
            if status.cachedCount > 0 {
                Button(role: .destructive) {
                    localDb.removeFolderFromCache(docIdsInFolder: docIds)
                } label: {
                    Label("Supprimer le dossier du cache", systemImage: "trash")
                }
            }
        }
    }
    
    // MARK: - Ligne de Document
    private func documentRowView(doc: DocumentItem) -> some View {
        let isCached = localDb.isDocumentCached(docId: doc.id)
        let isDownloading = downloadQueue.isDownloading(docId: doc.id)
        let downloadProgress = downloadQueue.activeTasks[doc.id] ?? 0.05
        
        return HStack(spacing: 12) {
            Image(systemName: "doc.text.fill")
                .font(.title3)
                .foregroundColor(isCached ? .blue : .secondary.opacity(0.8))
            
            VStack(alignment: .leading, spacing: 2) {
                Text(doc.title.isEmpty ? doc.filename : doc.title)
                    .font(.body.weight(.medium))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                
                HStack(spacing: 6) {
                    Text("\(doc.total_pages) page\(doc.total_pages > 1 ? "s" : "")")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    
                    if let size = doc.file_size, size > 0 {
                        Text("•")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        Text(formatFileSize(size))
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
            }
            
            Spacer()
            
            // Contrôle de synchronisation du fichier individuel avec bouton STOP
            if isDownloading {
                HStack(spacing: 6) {
                    ZStack {
                        Circle()
                            .stroke(Color.secondary.opacity(0.2), lineWidth: 2.5)
                            .frame(width: 20, height: 20)
                        Circle()
                            .trim(from: 0, to: CGFloat(downloadProgress))
                            .stroke(Color.blue, lineWidth: 2.5)
                            .frame(width: 20, height: 20)
                            .rotationEffect(.degrees(-90))
                    }
                    
                    Button(action: {
                        downloadQueue.cancelDownload(docId: doc.id)
                    }) {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 18))
                            .foregroundColor(.red)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Arrêter le téléchargement")
                }
            } else if isCached {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.green)
                    .font(.system(size: 18))
                    .accessibilityLabel("Document en cache")
            } else {
                if isOfflineMode {
                    Image(systemName: "icloud.slash")
                        .foregroundColor(.secondary)
                        .font(.system(size: 18))
                        .accessibilityLabel("Non disponible hors-ligne")
                } else {
                    Button(action: {
                        downloadQueue.enqueue(docId: doc.id)
                    }) {
                        Image(systemName: "arrow.down.circle")
                            .foregroundColor(.accentColor)
                            .font(.system(size: 18))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Télécharger")
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture {
            if isOfflineMode && !isCached {
                offlineAlertDocTitle = doc.title.isEmpty ? doc.filename : doc.title
                showOfflineAlert = true
            } else {
                openDocument(doc)
            }
        }
        .accessibilityIdentifier("document_row_\(doc.id)")
        .contextMenu {
            if !isOfflineMode || isCached {
                Button {
                    openDocument(doc)
                } label: {
                    Label("Ouvrir dans le lecteur", systemImage: "book")
                }
            }
            
            if isDownloading {
                Button(role: .destructive) {
                    downloadQueue.cancelDownload(docId: doc.id)
                } label: {
                    Label("Arrêter la synchronisation", systemImage: "stop.circle")
                }
            } else if !isCached {
                Button {
                    downloadQueue.enqueue(docId: doc.id)
                } label: {
                    Label("Télécharger hors-ligne", systemImage: "arrow.down.circle")
                }
            }
            
            if isCached {
                Button(role: .destructive) {
                    localDb.removeDocumentFromCache(docId: doc.id)
                } label: {
                    Label("Supprimer du cache", systemImage: "trash")
                }
            }
        }
    }
    
    // MARK: - Vue des Résultats de Recherche
    private var searchResultsView: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                HStack {
                    if isSearching {
                        ProgressView()
                            .scaleEffect(0.8)
                        Text("Recherche en cours...")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    } else {
                        Text("\(totalDocuments) document\(totalDocuments > 1 ? "s" : "") (\(totalOccurrences) correspondance\(totalOccurrences > 1 ? "s" : ""))")
                            .font(.caption.bold())
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                }
                .padding(.horizontal)
                .padding(.top, 8)
                
                if !isSearching && searchResults.isEmpty && !searchQuery.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 40))
                            .foregroundColor(.secondary.opacity(0.4))
                        Text("Aucun résultat pour \"\(searchQuery)\"")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                } else {
                    ForEach(searchResults) { doc in
                        DocumentCardView(
                            document: doc,
                            onOpenDocument: { targetDoc, targetOcc in
                                let initialPage = targetOcc != nil ? Int(targetOcc!.page_number) : 1
                                let docFolder = folderForDoc(targetDoc.id) ?? (currentFolderId != nil ? currentTitle : "Racine")
                                let targetIdx = (targetDoc.vignettes ?? []).firstIndex(where: { $0.id == targetOcc?.id }) ?? 0
                                tabManager.openDocument(
                                    docId: targetDoc.id,
                                    title: targetDoc.title,
                                    filename: targetDoc.filename,
                                    initialPage: initialPage,
                                    occurrences: targetDoc.vignettes ?? [],
                                    searchQuery: searchQuery,
                                    targetOccurrenceIndex: targetIdx,
                                    folderPath: docFolder
                                )
                            }
                        )
                        .padding(.horizontal)
                    }
                }
            }
            .padding(.bottom, 24)
        }
    }
    
    // MARK: - Actions & Logique
    
    private func folderForDoc(_ docId: Int64) -> String? {
        for (fId, docs) in folderDocs {
            if docs.contains(where: { $0.id == docId }) {
                if let f = allFolders.first(where: { $0.id == fId }) {
                    return f.name
                }
            }
        }
        return nil
    }
    
    private func openDocument(_ doc: DocumentItem) {
        let folderName = currentFolderId != nil ? currentTitle : "Racine"
        tabManager.openDocument(
            docId: doc.id,
            title: doc.title,
            filename: doc.filename,
            initialPage: 1,
            occurrences: [],
            searchQuery: nil,
            folderPath: folderName
        )
    }
    
    private func performSearch() {
        let trimmed = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            searchResults = []
            totalOccurrences = 0
            totalDocuments = 0
            return
        }
        
        isSearching = true
        errorMessage = nil
        
        Task {
            if isOfflineMode {
                let response = RustBridge.shared.searchLocal(
                    query: trimmed,
                    folderId: currentFolderId,
                    titlesOnly: titlesOnly,
                    at: localDb.dbURL
                )
                await MainActor.run {
                    self.isSearching = false
                    if let res = response {
                        // RÈGLE CRITIQUE : Hors-ligne, seuls les documents en cache local apparaissent dans la recherche
                        let cachedDocs = res.results.filter { self.localDb.isDocumentCached(docId: $0.id) }
                        self.searchResults = cachedDocs
                        self.totalDocuments = cachedDocs.count
                        self.totalOccurrences = cachedDocs.reduce(0) { $0 + $1.total_occurrences }
                    } else {
                        self.errorMessage = "Erreur de recherche locale"
                    }
                }
            } else {
                do {
                    let res = try await api.searchOnline(
                        query: trimmed,
                        folderId: currentFolderId,
                        titlesOnly: titlesOnly
                    )
                    await MainActor.run {
                        self.isSearching = false
                        self.searchResults = res.results
                        self.totalDocuments = res.total_documents
                        self.totalOccurrences = res.total_occurrences
                    }
                } catch {
                    let localResponse = RustBridge.shared.searchLocal(
                        query: trimmed,
                        folderId: currentFolderId,
                        titlesOnly: titlesOnly,
                        at: localDb.dbURL
                    )
                    await MainActor.run {
                        self.isSearching = false
                        if let res = localResponse {
                            let cachedDocs = res.results.filter { self.localDb.isDocumentCached(docId: $0.id) }
                            self.searchResults = cachedDocs
                            self.totalDocuments = cachedDocs.count
                            self.totalOccurrences = cachedDocs.reduce(0) { $0 + $1.total_occurrences }
                        } else {
                            self.errorMessage = error.localizedDescription
                        }
                    }
                }
            }
        }
    }
    
    private func refreshAll() async {
        guard !isSyncing else { return }
        isSyncing = true
        errorMessage = nil
        
        // Si marqué hors-ligne mais avec interface réseau active, vérifier si le serveur répond
        if isOfflineMode && network.isConnected && !api.serverURL.contains(":9999") {
            _ = await api.probeServerReachability()
        }
        
        if isOfflineMode {
            loadLocalContents()
            return
        }
        
        do {
            let fetchedFolders = try await api.fetchFolders()
            if let data = try? JSONEncoder().encode(fetchedFolders),
               let json = String(data: data, encoding: .utf8) {
                _ = RustBridge.shared.syncFolders(json: json, at: localDb.dbURL)
            }
            
            // Récupération globale atomique de tous les documents pour fixer les folder_id dans SQLite
            let allDocs = try await api.fetchDocuments(all: true)
            var newFolderDocs: [Int64: [DocumentItem]] = [:]
            var mappings: [(docId: Int64, folderId: Int64?)] = []
            var rootDocs: [DocumentItem] = []
            
            for d in allDocs {
                mappings.append((docId: d.id, folderId: d.folder_id))
                if let fId = d.folder_id {
                    newFolderDocs[fId, default: []].append(d)
                } else {
                    rootDocs.append(d)
                }
            }
            localDb.updateDocumentFolderMappings(mappings: mappings)
            localDb.syncAllDocumentsMetadata(docs: allDocs)
            
            await MainActor.run {
                self.allFolders = fetchedFolders
                self.folderDocs = newFolderDocs
                self.currentDocuments = self.currentFolderId != nil ? (newFolderDocs[self.currentFolderId!] ?? []) : rootDocs
                self.isSyncing = false
                self.isLoading = false
            }
        } catch {
            // Repli transparent sur SQLite local en cas de panne ou de mode hors-ligne
            loadLocalContents()
        }
    }
    
    private func loadLocalContents() {
        let localFolders = localDb.getLocalFolders()
        var newFolderDocs: [Int64: [DocumentItem]] = [:]
        for f in localFolders {
            newFolderDocs[f.id] = localDb.getLocalDocuments(folderId: f.id)
        }
        let currentDocs = localDb.getLocalDocuments(folderId: currentFolderId)
        
        DispatchQueue.main.async {
            self.allFolders = localFolders
            self.folderDocs = newFolderDocs
            self.currentDocuments = currentDocs
            self.isSyncing = false
            self.isLoading = false
        }
    }
    
    private func loadContentsForCurrentFolder() async {
        isLoading = true
        if isOfflineMode {
            let docs = localDb.getLocalDocuments(folderId: currentFolderId)
            await MainActor.run {
                self.currentDocuments = docs
                self.isLoading = false
            }
            return
        }
        do {
            let docs = try await api.fetchDocuments(folderId: currentFolderId)
            await MainActor.run {
                self.currentDocuments = docs
                self.isLoading = false
            }
        } catch {
            let docs = localDb.getLocalDocuments(folderId: currentFolderId)
            await MainActor.run {
                self.currentDocuments = docs
                self.isLoading = false
            }
        }
    }
    
    private func downloadEntireFolder(folderId: Int64, docs: [DocumentItem]) {
        downloadQueue.enqueueFolder(docs: docs)
    }
    
    private func colorForFolder(_ folder: Folder) -> Color {
        if let hex = folder.color, !hex.isEmpty {
            return Color(hex: hex) ?? .blue
        }
        return .blue
    }
    
    private func formatFileSize(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }
}
