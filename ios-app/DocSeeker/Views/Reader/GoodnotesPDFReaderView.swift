// GoodnotesPDFReaderView.swift
// Lecteur PDF style Goodnotes mobile (Screenshot 2) : Onglets multiples, barre d'outils,
// volet d'occurrences latéral et bandeau flottant de navigation des correspondances

import SwiftUI
import PDFKit

public struct GoodnotesPDFReaderView: View {
    @ObservedObject private var tabManager = DocumentTabManager.shared
    @ObservedObject private var localDb = LocalDatabase.shared
    @ObservedObject private var downloadQueue = DownloadQueueManager.shared
    
    @State private var currentPage: Int = 1
    @State private var showSearchDrawer: Bool = false
    @State private var shareURL: URL? = nil
    @State private var showShareSheet: Bool = false
    @State private var inspectedTab: OpenDocumentTab? = nil
    
    public init() {}
    
    private var activeTab: OpenDocumentTab? {
        tabManager.activeTab
    }
    
    private var effectivePdfURL: URL? {
        guard let tab = activeTab else { return nil }
        if let localURL = localDb.getLocalPDFURL(docId: tab.docId) {
            return localURL
        }
        // Consultation immédiate sans avoir à attendre le téléchargement complet si connecté au serveur !
        if NetworkMonitor.shared.isConnected {
            return URL(string: "\(APIClient.shared.serverURL)/api/pdf/\(tab.docId)")
        }
        return nil
    }
    
    private var localPdfURL: URL? {
        guard let tab = activeTab else { return nil }
        if localDb.isDocumentCached(docId: tab.docId) {
            return localDb.localPdfURL(for: tab.docId)
        }
        return nil
    }
    
    private var isDownloading: Bool {
        guard let tab = activeTab else { return false }
        return downloadQueue.activeTasks[tab.docId] != nil || downloadQueue.queuedDocIds.contains(tab.docId)
    }
    
    private var downloadProgress: Double {
        guard let tab = activeTab else { return 0.0 }
        return downloadQueue.activeTasks[tab.docId] ?? 0.05
    }
    
    public var body: some View {
        VStack(spacing: 0) {
            // 1. Barre d'onglets supérieure style Goodnotes (Screenshot 2)
            topTabBar
            
            // 2. Toolbar secondaire (Bouton volet latéral, partage)
            readerToolbar
            
            Divider()
            
            // 3. Zone principale PDFKit avec chargement sécurisé anti-écran blanc
            ZStack {
                Color(.systemGroupedBackground)
                    .edgesIgnoringSafeArea(.all)
                
                if let url = effectivePdfURL, let tab = activeTab {
                    let activeOcc = (tab.occurrences.indices.contains(tab.activeOccurrenceIndex)) ? tab.occurrences[tab.activeOccurrenceIndex] : nil
                    
                    PDFKitView(
                        documentURL: url,
                        currentPage: $currentPage,
                        targetPage: tab.currentPage,
                        targetRect: activeOcc?.rect
                    )
                    .edgesIgnoringSafeArea([.leading, .trailing, .bottom])
                } else if isDownloading {
                    // Téléchargement dynamique en cours avec jauge et bouton d'arrêt
                    VStack(spacing: 16) {
                        Spacer()
                        ZStack {
                            Circle()
                                .stroke(Color.secondary.opacity(0.2), lineWidth: 4)
                                .frame(width: 50, height: 50)
                            Circle()
                                .trim(from: 0, to: CGFloat(downloadProgress))
                                .stroke(Color.blue, lineWidth: 4)
                                .frame(width: 50, height: 50)
                                .rotationEffect(.degrees(-90))
                            Text("\(Int(downloadProgress * 100))%")
                                .font(.caption2.bold())
                                .foregroundColor(.blue)
                        }
                        
                        Text("Téléchargement du document...")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        
                        if let tab = activeTab {
                            Button("Annuler le téléchargement") {
                                downloadQueue.cancelDownload(docId: tab.docId)
                            }
                            .font(.caption.bold())
                            .foregroundColor(.red)
                        }
                        Spacer()
                    }
                    .padding()
                } else {
                    // Hors-ligne et document non présent en cache
                    VStack(spacing: 16) {
                        Spacer()
                        Image(systemName: "wifi.slash")
                            .font(.system(size: 44))
                            .foregroundColor(.secondary.opacity(0.6))
                        Text("Document non disponible hors-ligne")
                            .font(.headline)
                            .foregroundColor(.primary)
                        Text("Ce document n'a pas encore été téléchargé sur cet appareil. Connectez-vous à votre serveur pour le consulter ou le synchroniser.")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                        
                        Button("Retour aux documents") {
                            tabManager.returnToHome()
                        }
                        .buttonStyle(.borderedProminent)
                        .padding(.top, 8)
                        Spacer()
                    }
                    .padding()
                }
                
                // 4. Bandeau flottant inférieur de navigation des occurrences (Screenshot 2 en bas)
                if let tab = activeTab, let query = tab.searchQuery, !query.isEmpty, !tab.occurrences.isEmpty {
                    VStack {
                        Spacer()
                        OccurrenceNavigationBottomBar(
                            searchQuery: query,
                            currentIndex: tab.activeOccurrenceIndex,
                            totalCount: tab.occurrences.count,
                            onPrevious: {
                                tabManager.previousOccurrence()
                            },
                            onNext: {
                                tabManager.nextOccurrence()
                            },
                            onClose: {
                                if let idx = tabManager.openTabs.firstIndex(where: { $0.id == tab.id }) {
                                    tabManager.openTabs[idx].searchQuery = nil
                                }
                            }
                        )
                    }
                }
            }
        }
        .background(Color(.systemBackground))
        .sheet(isPresented: $showSearchDrawer) {
            if let tab = activeTab {
                InDocumentSearchDrawer(
                    documentId: tab.docId,
                    documentTitle: tab.title,
                    filename: tab.filename,
                    currentOccurrences: tab.occurrences,
                    initialQuery: tab.searchQuery ?? "",
                    activeOccurrenceIndex: tab.activeOccurrenceIndex,
                    onSelectOccurrence: { occ, query in
                        if !query.isEmpty && query != tab.searchQuery && query != "Extrait" {
                            tabManager.loadFullInDocOccurrences(docId: tab.docId, query: query)
                        }
                        tabManager.selectOccurrence(docId: tab.docId, occurrence: occ)
                    }
                )
            }
        }
        .sheet(isPresented: $showShareSheet) {
            if let url = shareURL {
                ActivityView(activityItems: [url])
            }
        }
        .popover(item: $inspectedTab) { tab in
            DocumentInfoFloatingCard(tab: tab)
        }
    }
    
    // MARK: - Barre d'onglets supérieure Compacte
    
    private var topTabBar: some View {
        HStack(spacing: 8) {
            // Bouton retour à l'accueil / arborescence
            Button(action: {
                tabManager.returnToHome()
            }) {
                Image(systemName: "house")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(.blue)
                    .frame(width: 30, height: 30)
                    .background(Color(.tertiarySystemFill))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Retour à l'accueil")
            
            // Liste déroulante des onglets compactés style Goodnotes
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 5) {
                    ForEach(tabManager.openTabs) { tab in
                        let isActive = tab.id == tabManager.activeTabId
                        
                        HStack(spacing: 3) {
                            // Clic pour activer l'onglet
                            Button(action: {
                                tabManager.selectTab(id: tab.id)
                            }) {
                                Text(tab.title)
                                    .font(.caption)
                                    .fontWeight(isActive ? .semibold : .regular)
                                    .foregroundColor(isActive ? .primary : .secondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                    .frame(maxWidth: 80)
                            }
                            .buttonStyle(.plain)
                            
                            // Petite flèche pour ouvrir la popover d'information complète
                            Button(action: {
                                inspectedTab = tab
                            }) {
                                Image(systemName: "chevron.down")
                                    .font(.system(size: 8, weight: .bold))
                                    .foregroundColor(.secondary)
                                    .padding(2)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Détails du document \(tab.title)")
                            .accessibilityIdentifier("tab_chevron_\(tab.docId)")
                            
                            // Bouton fermer l'onglet
                            Button(action: {
                                tabManager.closeTab(id: tab.id)
                            }) {
                                Image(systemName: "xmark")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundColor(.secondary)
                                    .frame(width: 16, height: 16)
                                    .background(Color.secondary.opacity(0.15))
                                    .clipShape(Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Fermer l'onglet \(tab.title)")
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(isActive ? Color(.secondarySystemGroupedBackground) : Color(.tertiarySystemFill))
                        .cornerRadius(6)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(isActive ? Color.blue.opacity(0.4) : Color.clear, lineWidth: 1)
                        )
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 4)
        .background(Color(.systemBackground))
    }
    
    // MARK: - Toolbar Goodnotes Compacte
    
    private var readerToolbar: some View {
        HStack(spacing: 10) {
            // Bouton volet latéral pleine largeur
            Button(action: {
                showSearchDrawer = true
            }) {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(.blue)
                    .frame(width: 28, height: 28)
                    .background(Color(.tertiarySystemFill))
                    .cornerRadius(6)
            }
            .accessibilityLabel("Afficher les vignettes et la recherche interne")
            .accessibilityIdentifier("reader_open_drawer")
            
            Spacer()
            
            // Bouton Partage
            Button(action: {
                if let url = effectivePdfURL {
                    self.shareURL = url
                    self.showShareSheet = true
                }
            }) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14))
                    .foregroundColor(.blue)
                    .frame(width: 28, height: 28)
                    .background(Color(.tertiarySystemFill))
                    .cornerRadius(6)
            }
            .accessibilityLabel("Partager le document")
            
            // Menu d'options
            Menu {
                if let tab = activeTab {
                    if localDb.isDocumentCached(docId: tab.docId) {
                        Button(role: .destructive) {
                            localDb.removeDocumentFromCache(docId: tab.docId)
                        } label: {
                            Label("Supprimer du cache hors-ligne", systemImage: "trash")
                        }
                    } else {
                        Button {
                            downloadQueue.enqueue(docId: tab.docId)
                        } label: {
                            Label("Télécharger hors-ligne", systemImage: "arrow.down.circle")
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 14))
                    .foregroundColor(.blue)
                    .frame(width: 28, height: 28)
                    .background(Color(.tertiarySystemFill))
                    .cornerRadius(6)
            }
            .accessibilityLabel("Options du document")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 3)
        .background(Color(.systemBackground))
    }
}

// MARK: - Carte Flottante d'Information Complète du Document (Popover Flèche)
struct DocumentInfoFloatingCard: View {
    let tab: OpenDocumentTab
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "doc.richtext.fill")
                    .font(.title2)
                    .foregroundColor(.blue)
                
                VStack(alignment: .leading, spacing: 4) {
                    Text(tab.title)
                        .font(.headline)
                        .foregroundColor(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    
                    Text(tab.filename)
                        .font(.caption.monospaced())
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                
                Spacer()
                
                Button(action: { dismiss() }) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
            }
            
            Divider()
            
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Label("Emplacement :", systemImage: "folder")
                        .font(.subheadline.bold())
                        .foregroundColor(.secondary)
                    Text(tab.folderPath ?? "Racine / Documents")
                        .font(.subheadline)
                        .foregroundColor(.primary)
                        .lineLimit(2)
                }
                
                HStack(spacing: 8) {
                    Label("Page courante :", systemImage: "book")
                        .font(.subheadline.bold())
                        .foregroundColor(.secondary)
                    Text("Page \(tab.currentPage)")
                        .font(.subheadline)
                        .foregroundColor(.primary)
                }
                
                if !tab.occurrences.isEmpty {
                    HStack(spacing: 8) {
                        Label("Correspondances :", systemImage: "text.magnifyingglass")
                            .font(.subheadline.bold())
                            .foregroundColor(.secondary)
                        Text("\(tab.occurrences.count) extraits trouvés")
                            .font(.subheadline)
                            .foregroundColor(.blue)
                    }
                }
            }
        }
        .padding(18)
        .frame(minWidth: 280, maxWidth: 340)
        .background(Color(.secondarySystemGroupedBackground))
    }
}

// Helper pour UIActivityViewController (Partage)
struct ActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]
    let applicationActivities: [UIActivity]? = nil

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: applicationActivities)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
