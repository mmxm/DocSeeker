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
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var isTwoPageView: Bool = false
    @State private var isFitToWidth: Bool = false
    @State private var showSearchDrawer: Bool = false
    @State private var showShareSheet: Bool = false
    @State private var shareURL: URL? = nil
    @State private var inspectedTab: OpenDocumentTab? = nil
    /// Progression animée (interpolée) pour éviter le glitch du Circle trim
    @State private var animatedProgress: Double = 0.05
    
    public init() {}
    
    private var isRegularScreen: Bool {
        horizontalSizeClass == .regular
    }
    
    private var activeTab: OpenDocumentTab? {
        tabManager.activeTab
    }
    
    private var localPdfURL: URL? {
        guard let tab = activeTab else { return nil }
        return localDb.getLocalPDFURL(docId: tab.docId)
    }
    
    private var resolvedPdfURL: URL? {
        guard let tab = activeTab else { return nil }
        // 1. Si présent en cache local sur le disque : priorité absolue
        if let local = localDb.getLocalPDFURL(docId: tab.docId) {
            return local
        }
        // 2. Si connecté et serveur accessible : streaming Byte-Range partiel instantané
        if NetworkMonitor.shared.isConnected && APIClient.shared.isServerReachable {
            return APIClient.shared.streamingPDFURL(for: tab.docId)
        }
        return nil
    }
    
    private var isOffline: Bool {
        !NetworkMonitor.shared.isConnected || !APIClient.shared.isServerReachable
    }
    
    private var isDownloading: Bool {
        guard let tab = activeTab else { return false }
        return downloadQueue.activeTasks[tab.docId] != nil || downloadQueue.queuedDocIds.contains(tab.docId)
    }
    
    private var downloadProgress: Double {
        guard let tab = activeTab else { return 0.0 }
        return downloadQueue.activeTasks[tab.docId] ?? 0.0
    }
    
    public var body: some View {
        VStack(spacing: 0) {
            // 1. Barre d'onglets supérieure style Goodnotes (Screenshot 2)
            topTabBar
            
            // 2. Toolbar secondaire (Bouton volet latéral, partage)
            readerToolbar
            
            Divider()
            
            // 3. Zone principale avec volet latéral à gauche sur grand écran (iPad/macOS)
            HStack(spacing: 0) {
                // Volet latéral de recherche dans le document (iPad et macOS)
                if isRegularScreen && showSearchDrawer {
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
                            },
                            isSidebarMode: true,
                            onCloseSidebar: {
                                withAnimation(.easeInOut(duration: 0.25)) {
                                    showSearchDrawer = false
                                }
                            }
                        )
                        .frame(width: 360)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                        
                        Divider()
                    }
                }
                
                // Zone principale PDFKit avec streaming partiel instantané
                ZStack {
                    Color(.systemGroupedBackground)
                        .edgesIgnoringSafeArea(.all)
                    
                    if let url = resolvedPdfURL, let tab = activeTab {
                        let activeOcc = (tab.occurrences.indices.contains(tab.activeOccurrenceIndex)) ? tab.occurrences[tab.activeOccurrenceIndex] : nil
                        
                        PDFKitView(
                            documentURL: url,
                            currentPage: $currentPage,
                            targetPage: tab.currentPage,
                            targetRect: activeOcc?.rect,
                            isTwoPages: isTwoPageView,
                            isFitToWidth: isFitToWidth,
                            onManualZoom: {
                                if isFitToWidth {
                                    isFitToWidth = false
                                }
                            }
                        )
                        .edgesIgnoringSafeArea([.leading, .trailing, .bottom])
                        .onAppear {
                            // Lancer la mise en cache complète en tâche de fond après un court délai
                            // pour préserver 100% de la bande passante pour la première page en streaming
                            if localDb.getLocalPDFURL(docId: tab.docId) == nil && !isOffline {
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                                    downloadQueue.enqueue(docId: tab.docId)
                                }
                            }
                        }
                    } else if isOffline {
                        // Hors-ligne et document non présent en cache local
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
                    } else {
                        // En attente de connexion réseau
                        VStack(spacing: 16) {
                            Spacer()
                            ProgressView()
                                .scaleEffect(1.3)
                            Text("Chargement du document...")
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                            Spacer()
                        }
                        .padding()
                    }
                    
                    // 4. Bandeau flottant inférieur de navigation des occurrences
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
        }
        .background(Color(.systemBackground))
        // Modal sheet sur écran compact (iPhone) uniquement
        .sheet(isPresented: Binding(
            get: { !isRegularScreen && showSearchDrawer },
            set: { showSearchDrawer = $0 }
        )) {
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
        // Raccourcis clavier (Magic Keyboard iPad & macOS)
        .background(
            Group {
                Button("") {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        showSearchDrawer.toggle()
                    }
                }
                .keyboardShortcut("f", modifiers: .command)
                
                Button("") {
                    if let tab = activeTab {
                        tabManager.closeTab(id: tab.id)
                    }
                }
                .keyboardShortcut("w", modifiers: .command)
                
                Button("") {
                    tabManager.nextOccurrence()
                }
                .keyboardShortcut("]", modifiers: .command)
                
                Button("") {
                    tabManager.previousOccurrence()
                }
                .keyboardShortcut("[", modifiers: .command)
                
                Button("") {
                    if showSearchDrawer {
                        withAnimation(.easeInOut(duration: 0.25)) {
                            showSearchDrawer = false
                        }
                    }
                }
                .keyboardShortcut(.escape, modifiers: [])
                
                Button("") {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isFitToWidth.toggle()
                    }
                }
                .keyboardShortcut("9", modifiers: .command)
            }
            .opacity(0)
            .allowsHitTesting(false)
        )
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
            // Bouton volet latéral (bascule l'ouverture/fermeture avec animation fluide)
            Button(action: {
                withAnimation(.easeInOut(duration: 0.25)) {
                    showSearchDrawer.toggle()
                }
            }) {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(showSearchDrawer ? .white : .blue)
                    .frame(width: 28, height: 28)
                    .background(showSearchDrawer ? Color.blue : Color(.tertiarySystemFill))
                    .cornerRadius(6)
            }
            .accessibilityLabel("Afficher ou masquer les vignettes et la recherche interne")
            .accessibilityIdentifier("reader_open_drawer")
            
            Spacer()
            
            // Indicateur de téléchargement discret (cercle de progression animé sans glitch)
            if isDownloading {
                ZStack {
                    Circle()
                        .stroke(Color.secondary.opacity(0.2), lineWidth: 2.2)
                    Circle()
                        .trim(from: 0, to: CGFloat(animatedProgress))
                        .stroke(Color.blue, lineWidth: 2.2)
                        .rotationEffect(.degrees(-90))
                }
                .frame(width: 18, height: 18)
                .accessibilityIdentifier("reader_download_progress")
                .onChange(of: downloadProgress) { newVal in
                    // Interpolation animée pour éviter les sauts brusques
                    withAnimation(.easeInOut(duration: 0.35)) {
                        animatedProgress = max(0.05, newVal)
                    }
                }
                .onAppear {
                    animatedProgress = max(0.05, downloadProgress)
                }
            } else {
                // Placeholder de même taille pour stabiliser le layout (no Spacer jump)
                Color.clear.frame(width: 18, height: 18)
            }
            
            Spacer()
            
            // Bouton Pleine Largeur (ajuste le zoom à la largeur du viewer, juste à gauche du bouton partager)
            Button(action: {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isFitToWidth.toggle()
                }
            }) {
                Image(systemName: isFitToWidth ? "arrow.right.and.line.vertical.and.arrow.left" : "arrow.left.and.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(isFitToWidth ? .white : .blue)
                    .frame(width: 28, height: 28)
                    .background(isFitToWidth ? Color.blue : Color(.tertiarySystemFill))
                    .cornerRadius(6)
            }
            .accessibilityLabel(isFitToWidth ? "Désactiver le zoom pleine largeur" : "Ajuster à la largeur du lecteur")
            .accessibilityIdentifier("reader_fit_to_width")
            
            // Bouton Partage
            Button(action: {
                if let url = localPdfURL {
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
                // Option Double Page (iPad & macOS)
                Section {
                    Button {
                        withAnimation {
                            isTwoPageView.toggle()
                        }
                    } label: {
                        Label(
                            isTwoPageView ? "Affichage 1 page défilante" : "Affichage 2 pages (Double page)",
                            systemImage: isTwoPageView ? "doc" : "book"
                        )
                    }
                    .accessibilityIdentifier("reader_toggle_double_page")
                }
                
                Section {
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
                .accessibilityIdentifier("popover_close_button")
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
