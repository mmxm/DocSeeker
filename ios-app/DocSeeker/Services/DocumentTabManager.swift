// DocumentTabManager.swift
// Gestionnaire d'onglets multiples de documents PDF style Goodnotes

import Foundation
import SwiftUI
import Combine

public final class DocumentTabManager: ObservableObject {
    public static let shared = DocumentTabManager()
    
    @Published public var openTabs: [OpenDocumentTab] = []
    @Published public var activeTabId: UUID? = nil
    @Published public var isViewingReader: Bool = false
    @Published public var isPreparingDocument: Bool = false
    @Published public var preparationProgress: Double = 0.0
    
    private init() {}
    
    public var activeTab: OpenDocumentTab? {
        guard let id = activeTabId else { return nil }
        return openTabs.first(where: { $0.id == id })
    }
    
    /// Ouvre un document dans un onglet existant ou en crée un nouveau
    public func openDocument(
        docId: Int64,
        title: String,
        filename: String,
        initialPage: Int = 1,
        occurrences: [OccurrenceResult] = [],
        searchQuery: String? = nil,
        targetOccurrenceIndex: Int = 0,
        folderPath: String? = nil
    ) {
        // Si le document est déjà ouvert dans un onglet, on l'active
        if let existing = openTabs.first(where: { $0.docId == docId }) {
            self.activeTabId = existing.id
            if let idx = openTabs.firstIndex(where: { $0.id == existing.id }) {
                openTabs[idx].currentPage = initialPage
                openTabs[idx].activeOccurrenceIndex = targetOccurrenceIndex
                if !occurrences.isEmpty {
                    openTabs[idx].occurrences = occurrences
                }
                if let q = searchQuery {
                    openTabs[idx].searchQuery = q
                }
                if let path = folderPath {
                    openTabs[idx].folderPath = path
                }
            }
            self.isViewingReader = true
            ensureLocalCache(docId: docId)
            if let q = searchQuery, !q.isEmpty {
                loadFullInDocOccurrences(docId: docId, query: q)
            }
            return
        }
        
        // Nouvel onglet
        let newTab = OpenDocumentTab(
            docId: docId,
            title: title,
            filename: filename,
            currentPage: initialPage,
            activeOccurrenceIndex: targetOccurrenceIndex,
            occurrences: occurrences,
            searchQuery: searchQuery,
            folderPath: folderPath
        )
        
        let applyNewTab = {
            self.openTabs.append(newTab)
            self.activeTabId = newTab.id
            self.isViewingReader = true
            self.ensureLocalCache(docId: docId)
            if let q = searchQuery, !q.isEmpty {
                self.loadFullInDocOccurrences(docId: docId, query: q)
            }
        }
        
        if Thread.isMainThread {
            applyNewTab()
        } else {
            DispatchQueue.main.async(execute: applyNewTab)
        }
    }
    
    public func selectTab(id: UUID) {
        self.activeTabId = id
        self.isViewingReader = true
    }
    
    public func closeTab(id: UUID) {
        guard let index = openTabs.firstIndex(where: { $0.id == id }) else { return }
        openTabs.remove(at: index)
        if activeTabId == id {
            if let next = openTabs.last {
                activeTabId = next.id
            } else {
                activeTabId = nil
                isViewingReader = false
            }
        }
    }
    
    public func returnToHome() {
        self.isViewingReader = false
    }
    
    public func nextOccurrence() {
        guard let active = activeTab, let idx = openTabs.firstIndex(where: { $0.id == active.id }) else { return }
        let total = active.occurrences.count
        guard total > 0 else { return }
        let nextIdx = (active.activeOccurrenceIndex + 1) % total
        openTabs[idx].activeOccurrenceIndex = nextIdx
        let occ = active.occurrences[nextIdx]
        openTabs[idx].currentPage = Int(occ.page_number)
    }
    
    public func previousOccurrence() {
        guard let active = activeTab, let idx = openTabs.firstIndex(where: { $0.id == active.id }) else { return }
        let total = active.occurrences.count
        guard total > 0 else { return }
        let prevIdx = (active.activeOccurrenceIndex - 1 + total) % total
        openTabs[idx].activeOccurrenceIndex = prevIdx
        let occ = active.occurrences[prevIdx]
        openTabs[idx].currentPage = Int(occ.page_number)
    }
    
    public func selectOccurrence(docId: Int64, occurrence: OccurrenceResult) {
        guard let idx = openTabs.firstIndex(where: { $0.docId == docId }) else { return }
        openTabs[idx].currentPage = Int(occurrence.page_number)
        if let matchIdx = openTabs[idx].occurrences.firstIndex(where: { $0.id == occurrence.id }) {
            openTabs[idx].activeOccurrenceIndex = matchIdx
        } else {
            openTabs[idx].occurrences.append(occurrence)
            openTabs[idx].activeOccurrenceIndex = openTabs[idx].occurrences.count - 1
        }
    }
    
    public func updateInDocOccurrences(docId: Int64, query: String, occurrences: [OccurrenceResult]) {
        guard let idx = openTabs.firstIndex(where: { $0.docId == docId }) else { return }
        openTabs[idx].occurrences = occurrences
        openTabs[idx].searchQuery = query
        if openTabs[idx].activeOccurrenceIndex >= occurrences.count {
            openTabs[idx].activeOccurrenceIndex = 0
        }
        let currPage = openTabs[idx].currentPage
        if let matchIdx = occurrences.firstIndex(where: { Int($0.page_number) == currPage }) {
            openTabs[idx].activeOccurrenceIndex = matchIdx
        }
    }
    
    /// Charge l'intégralité des occurrences du document pour une recherche donnée
    public func loadFullInDocOccurrences(docId: Int64, query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        
        Task {
            var fullOccurrences: [OccurrenceResult] = []
            let isCached = LocalDatabase.shared.isDocumentCached(docId: docId)
            
            // 1. Moteur local Rust FFI prioritaire (obligatoire et exclusif si le document est en cache)
            if let local = RustBridge.shared.docSearchLocal(docId: docId, query: trimmed, at: LocalDatabase.shared.dbURL),
               !local.occurrences.isEmpty {
                fullOccurrences = local.occurrences
            }
            
            // 2. Si pas en base locale et qu'on est en ligne, essayer l'API serveur
            if fullOccurrences.isEmpty && !isCached && NetworkMonitor.shared.isConnected {
                if let apiRes = try? await APIClient.shared.docSearch(docId: docId, query: trimmed),
                   !apiRes.occurrences.isEmpty {
                    fullOccurrences = apiRes.occurrences
                }
            }
            
            // 3. Mise à jour de l'onglet actif avec toutes les correspondances
            if !fullOccurrences.isEmpty {
                await MainActor.run {
                    self.updateInDocOccurrences(docId: docId, query: trimmed, occurrences: fullOccurrences)
                }
            }
        }
    }
    
    /// Télécharge et met en cache local immédiatement le document s'il n'est pas présent
    private func ensureLocalCache(docId: Int64) {
        let db = LocalDatabase.shared
        guard !db.isDocumentCached(docId: docId) else { return }
        
        DownloadQueueManager.shared.enqueue(docId: docId)
    }
}
