// FolderTreeView.swift
// Arborescence des dossiers avec contrôles de synchronisation, badges de statut de cache et téléchargement groupé

import SwiftUI

public struct FolderTreeView: View {
    @Binding public var selectedFolderId: Int64?
    
    @ObservedObject private var api = APIClient.shared
    @ObservedObject private var localDb = LocalDatabase.shared
    @ObservedObject private var downloadQueue = DownloadQueueManager.shared
    
    @State private var folders: [Folder] = []
    @State private var folderDocs: [Int64: [DocumentItem]] = [:]
    @State private var isLoading: Bool = false
    @State private var isSyncing: Bool = false
    @State private var errorMessage: String? = nil
    
    public init(selectedFolderId: Binding<Int64?>) {
        self._selectedFolderId = selectedFolderId
    }
    
    public var body: some View {
        List {
            Section {
                Button(action: { selectedFolderId = nil }) {
                    HStack {
                        Image(systemName: "tray.full")
                            .foregroundColor(.accentColor)
                        Text("Tous les documents")
                            .foregroundColor(.primary)
                        Spacer()
                        if selectedFolderId == nil {
                            Image(systemName: "checkmark")
                                .foregroundColor(.accentColor)
                        }
                    }
                }
            }
            
            Section(header: HStack {
                Text("Dossiers")
                Spacer()
                Button(action: { Task { await synchronizeAll() } }) {
                    HStack(spacing: 4) {
                        Image(systemName: isSyncing ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
                            .rotationEffect(.degrees(isSyncing ? 360 : 0))
                            .animation(isSyncing ? Animation.linear(duration: 1).repeatForever(autoreverses: false) : .default, value: isSyncing)
                        Text("Synchroniser")
                            .font(.caption)
                    }
                }
                .accessibilityLabel("Synchroniser les dossiers")
            }) {
                if isLoading {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                } else if folders.isEmpty {
                    Text("Aucun dossier trouvé")
                        .foregroundColor(.secondary)
                } else {
                    ForEach(folders) { folder in
                        let docsInFolder = folderDocs[folder.id] ?? []
                        let docIds = docsInFolder.map { $0.id }
                        let status = localDb.folderCacheStatus(docIdsInFolder: docIds)
                        
                        HStack {
                            Button(action: {
                                if selectedFolderId == folder.id {
                                    selectedFolderId = nil
                                } else {
                                    selectedFolderId = folder.id
                                }
                            }) {
                                HStack {
                                    Image(systemName: "folder.fill")
                                        .foregroundColor(colorForFolder(folder))
                                    Text(folder.name)
                                        .foregroundColor(.primary)
                                    Spacer()
                                    
                                    // Badge d'état de cache du dossier (ex: ✓ En cache ou 2/3)
                                    if !docIds.isEmpty {
                                        if status.isComplete {
                                            HStack(spacing: 2) {
                                                Image(systemName: "checkmark.circle.fill")
                                                    .foregroundColor(.green)
                                                Text("En cache")
                                                    .font(.caption2)
                                                    .foregroundColor(.green)
                                            }
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(Color.green.opacity(0.12))
                                            .cornerRadius(4)
                                            .accessibilityLabel("Dossier en cache complet")
                                        } else if status.cachedCount > 0 {
                                            Text("\(status.cachedCount)/\(status.totalCount)")
                                                .font(.caption2)
                                                .foregroundColor(.blue)
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(Color.blue.opacity(0.12))
                                                .cornerRadius(4)
                                        }
                                    }
                                    
                                    if selectedFolderId == folder.id {
                                        Image(systemName: "checkmark")
                                            .foregroundColor(.accentColor)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            
                            // Menu d'actions par lot (Télécharger tout / Supprimer du cache)
                            Menu {
                                Button {
                                    cacheEntireFolder(folderId: folder.id)
                                } label: {
                                    Label("Télécharger tout le dossier", systemImage: "arrow.down.circle")
                                }
                                
                                if status.cachedCount > 0 {
                                    Button(role: .destructive) {
                                        uncacheEntireFolder(docIds: docIds)
                                    } label: {
                                        Label("Supprimer le dossier du cache", systemImage: "trash")
                                    }
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                                    .foregroundColor(.secondary)
                            }
                            .accessibilityLabel("Actions dossier \(folder.name)")
                        }
                    }
                }
            }
        }
        .refreshable {
            await synchronizeAll()
        }
        .task {
            await synchronizeAll()
        }
    }
    
    private func colorForFolder(_ folder: Folder) -> Color {
        if let hex = folder.color, !hex.isEmpty {
            return Color(hex: hex) ?? .blue
        }
        return .blue
    }
    
    private func synchronizeAll() async {
        guard !isSyncing else { return }
        isSyncing = true
        isLoading = folders.isEmpty
        errorMessage = nil
        do {
            let fetched = try await api.fetchFolders()
            // Synchroniser les dossiers avec la base SQLite locale
            if let data = try? JSONEncoder().encode(fetched),
               let json = String(data: data, encoding: .utf8) {
                _ = RustBridge.shared.syncFolders(json: json, at: localDb.dbURL)
            }
            
            // Récupérer les métadonnées des documents par dossier pour les statuts de cache
            var newFolderDocs: [Int64: [DocumentItem]] = [:]
            for f in fetched {
                if let docs = try? await api.fetchDocuments(folderId: f.id) {
                    newFolderDocs[f.id] = docs
                }
            }
            
            await MainActor.run {
                self.folders = fetched
                self.folderDocs = newFolderDocs
                self.isLoading = false
                self.isSyncing = false
            }
        } catch {
            await MainActor.run {
                self.errorMessage = error.localizedDescription
                self.isLoading = false
                self.isSyncing = false
            }
        }
    }
    
    private func cacheEntireFolder(folderId: Int64) {
        Task {
            do {
                let docs = try await api.fetchDocuments(folderId: folderId)
                downloadQueue.enqueueFolder(docs: docs)
            } catch {
                print("[FolderTree] Erreur chargement docs du dossier: \(error)")
            }
        }
    }
    
    private func uncacheEntireFolder(docIds: [Int64]) {
        localDb.removeFolderFromCache(docIdsInFolder: docIds)
    }
}

extension Color {
    init?(hex: String) {
        var cleanHex = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanHex.hasPrefix("#") { cleanHex.removeFirst() }
        guard let intVal = UInt64(cleanHex, radix: 16) else { return nil }
        let r, g, b: Double
        if cleanHex.count == 6 {
            r = Double((intVal >> 16) & 0xFF) / 255.0
            g = Double((intVal >> 8) & 0xFF) / 255.0
            b = Double(intVal & 0xFF) / 255.0
            self.init(red: r, green: g, blue: b)
        } else {
            return nil
        }
    }
}
