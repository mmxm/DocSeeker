// DocumentCardView.swift
// Carte de document épurée style Goodnotes : tap direct pour ouvrir dans un onglet PDF,
// ruban d'extraits, indicateurs de synchronisation et suppression des boutons superflus

import SwiftUI

public struct DocumentCardView: View {
    public let document: DocumentSearchResult
    public let onOpenDocument: (DocumentSearchResult, OccurrenceResult?) -> Void
    
    @ObservedObject private var localDb = LocalDatabase.shared
    @ObservedObject private var downloadQueue = DownloadQueueManager.shared
    @ObservedObject private var network = NetworkMonitor.shared
    @ObservedObject private var api = APIClient.shared
    
    @State private var showDeleteConfirm: Bool = false
    @State private var showOfflineAlert: Bool = false
    
    public init(
        document: DocumentSearchResult,
        onOpenDocument: @escaping (DocumentSearchResult, OccurrenceResult?) -> Void
    ) {
        self.document = document
        self.onOpenDocument = onOpenDocument
    }
    
    private var isCached: Bool {
        localDb.cachedDocIds.contains(document.id)
    }
    
    private var isOffline: Bool {
        !network.isConnected || !api.isServerReachable || api.serverURL.contains(":9999")
    }
    
    private var downloadProgress: Double? {
        downloadQueue.activeTasks[document.id]
    }
    
    private var isQueued: Bool {
        downloadQueue.queuedDocIds.contains(document.id)
    }
    
    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Ligne supérieure : infos document + contrôle de cache autonome
            HStack(alignment: .top, spacing: 10) {
                // Clic sur le titre et infos ouvre le document
                Button(action: {
                    if isOffline && !isCached {
                        showOfflineAlert = true
                    } else {
                        onOpenDocument(document, document.vignettes?.first)
                    }
                }) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "doc.text.fill")
                            .font(.title2)
                            .foregroundColor(.blue.opacity(0.85))
                        
                        VStack(alignment: .leading, spacing: 4) {
                            Text(document.title)
                                .font(.headline)
                                .foregroundColor(.primary)
                                .multilineTextAlignment(.leading)
                                .lineLimit(2)
                            
                            HStack(spacing: 8) {
                                Text("\(document.total_pages) pages")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                
                                if document.total_occurrences > 0 {
                                    Text("\(document.total_occurrences) extraits")
                                        .font(.caption2.bold())
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Color.blue.opacity(0.1))
                                        .foregroundColor(.blue)
                                        .cornerRadius(4)
                                }
                            }
                        }
                        
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("doc_card_button_\(document.id)")
                
                // Contrôle de synchronisation autonome (strictement séparé de la zone de tap document)
                cacheControlButton
                    .buttonStyle(.borderless)
            }
            
            // Ruban d'extraits horizontaux (un clic sur un extrait ouvre directement la page correspondante)
            if let vignettes = document.vignettes, !vignettes.isEmpty {
                OccurrenceRibbonView(
                    document: document,
                    onSelectOccurrence: { occ in
                        if isOffline && !isCached {
                            showOfflineAlert = true
                        } else {
                            onOpenDocument(document, occ)
                        }
                    },
                    onOpenDrawer: {
                        if isOffline && !isCached {
                            showOfflineAlert = true
                        } else {
                            onOpenDocument(document, vignettes.first)
                        }
                    }
                )
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground))
        .cornerRadius(12)
        .shadow(color: Color.black.opacity(0.03), radius: 3, x: 0, y: 1)
        .alert("Document non disponible hors-ligne", isPresented: $showOfflineAlert) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("\"\(document.title)\" n'a pas encore été téléchargé sur cet appareil. Connectez-vous à Internet pour le consulter.")
        }
        .confirmationDialog(
            "Retirer \"\(document.title)\" du cache local hors-ligne ?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Retirer du cache", role: .destructive) {
                localDb.removeDocumentFromCache(docId: document.id)
            }
            Button("Annuler", role: .cancel) {}
        }
    }
    
    @ViewBuilder
    private var cacheControlButton: some View {
        if isCached {
            Button(action: {
                showDeleteConfirm = true
            }) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.body)
                    .foregroundColor(.green)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Disponible hors-ligne")
            .accessibilityIdentifier("cache_status_\(document.id)")
        } else if let progress = downloadProgress {
            // Bouton STOP de synchronisation en cours
            Button(action: {
                downloadQueue.cancelDownload(docId: document.id)
            }) {
                ZStack {
                    Circle()
                        .stroke(Color.secondary.opacity(0.25), lineWidth: 2)
                        .frame(width: 22, height: 22)
                    Circle()
                        .trim(from: 0, to: CGFloat(progress))
                        .stroke(Color.blue, lineWidth: 2)
                        .frame(width: 22, height: 22)
                        .rotationEffect(.degrees(-90))
                    Image(systemName: "stop.fill")
                        .font(.system(size: 7))
                        .foregroundColor(.blue)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Arrêter la synchronisation")
        } else if isQueued {
            // En file d'attente avec arrêt possible
            Button(action: {
                downloadQueue.cancelDownload(docId: document.id)
            }) {
                ZStack {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.body)
                        .foregroundColor(.orange)
                    Image(systemName: "xmark")
                        .font(.system(size: 6).bold())
                        .foregroundColor(.orange)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Annuler l'attente")
        } else {
            // À synchroniser style iCloud
            Button(action: {
                downloadQueue.enqueue(docId: document.id)
            }) {
                Image(systemName: "icloud.and.arrow.down")
                    .font(.body)
                    .foregroundColor(.blue)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Télécharger")
        }
    }
}
