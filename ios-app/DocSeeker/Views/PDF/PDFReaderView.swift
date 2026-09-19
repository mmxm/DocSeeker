// PDFReaderView.swift
// Lecteur PDF natif complet avec téléchargement dynamique en arrière-plan et navigation rapide

import SwiftUI
import PDFKit

public struct PDFReaderView: View {
    public let documentId: Int64
    public let documentTitle: String
    public let filename: String
    public let initialPage: Int?
    public let initialRect: [Double]?
    public let occurrences: [OccurrenceResult]
    
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var localDb = LocalDatabase.shared
    @ObservedObject private var downloadQueue = DownloadQueueManager.shared
    
    @State private var currentPage: Int = 1
    @State private var targetPage: Int? = nil
    @State private var targetRect: [Double]? = nil
    @State private var showDrawer: Bool = false
    @State private var showSearchSheet: Bool = false
    @State private var inDocQuery: String = ""
    @State private var inDocOccurrences: [OccurrenceResult] = []
    
    public init(
        documentId: Int64,
        documentTitle: String,
        filename: String,
        initialPage: Int? = nil,
        initialRect: [Double]? = nil,
        occurrences: [OccurrenceResult] = []
    ) {
        self.documentId = documentId
        self.documentTitle = documentTitle
        self.filename = filename
        self.initialPage = initialPage
        self.initialRect = initialRect
        self.occurrences = occurrences
    }
    
    private var pdfURL: URL? {
        if localDb.isDocumentCached(docId: documentId) {
            return localDb.localPdfURL(for: documentId)
        }
        // Streaming partiel instantané authentifié avec token de session
        return APIClient.shared.streamingPDFURL(for: documentId)
    }
    
    public var body: some View {
        NavigationStack {
            ZStack {
                if let url = pdfURL {
                    PDFKitView(
                        documentURL: url,
                        currentPage: $currentPage,
                        targetPage: targetPage ?? initialPage,
                        targetRect: targetRect ?? initialRect
                    )
                    .edgesIgnoringSafeArea([.leading, .trailing, .bottom])
                } else {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Chargement du document...")
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle(documentTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fermer") {
                        dismiss()
                    }
                }
                
                ToolbarItemGroup(placement: .primaryAction) {
                    // Indicateur de page
                    Text("p. \(currentPage)")
                        .font(.caption.monospacedDigit())
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 4)
                    
                    // Statut de mise en cache dynamique
                    if localDb.isDocumentCached(docId: documentId) {
                        Image(systemName: "checkmark.icloud.fill")
                            .foregroundColor(.green)
                    } else if let progress = downloadQueue.activeTasks[documentId] {
                        ProgressView(value: progress)
                            .progressViewStyle(.circular)
                            .frame(width: 16, height: 16)
                    }
                    
                    // Bouton liste des occurrences
                    if !occurrences.isEmpty {
                        Button(action: { showDrawer = true }) {
                            Image(systemName: "list.bullet.rectangle")
                        }
                    }
                }
            }
            .sheet(isPresented: $showDrawer) {
                OccurrenceDrawerView(
                    documentTitle: documentTitle,
                    documentId: documentId,
                    filename: filename,
                    occurrences: occurrences,
                    onSelectOccurrence: { occ in
                        self.targetPage = Int(occ.page_number)
                        self.targetRect = occ.rect
                    }
                )
            }
            .onAppear {
                // Spécification : A l'ouverture d'un pdf, téléchargement dynamique en arrière-plan pour hors-ligne
                if !localDb.isDocumentCached(docId: documentId) {
                    downloadQueue.enqueue(docId: documentId)
                }
                if let page = initialPage {
                    self.targetPage = page
                    self.targetRect = initialRect
                }
            }
        }
    }
}
