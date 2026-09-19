// DownloadQueueView.swift
// Gestionnaire de la file d'attente de téléchargement et d'espace disque

import SwiftUI

public struct DownloadQueueView: View {
    @ObservedObject private var queue = DownloadQueueManager.shared
    @ObservedObject private var localDb = LocalDatabase.shared
    
    public init() {}
    
    private var totalActiveCount: Int {
        queue.activeTasks.count + queue.queuedDocIds.count
    }
    
    public var body: some View {
        List {
                Section("Statut de la file") {
                    HStack {
                        Label("En cours / En attente", systemImage: "arrow.down.circle")
                        Spacer()
                        Text("\(totalActiveCount) documents")
                            .foregroundColor(.secondary)
                    }
                    
                    HStack {
                        Label("Documents hors-ligne", systemImage: "internaldrive")
                        Spacer()
                        Text("\(localDb.cachedDocIds.count) documents")
                            .foregroundColor(.secondary)
                    }
                    
                    if totalActiveCount > 0 {
                        Button(action: {
                            queue.isPaused.toggle()
                        }) {
                            HStack {
                                Spacer()
                                Label(
                                    queue.isPaused ? "Reprendre les téléchargements" : "Suspendre les téléchargements",
                                    systemImage: queue.isPaused ? "play.circle.fill" : "pause.circle.fill"
                                )
                                .font(.subheadline.bold())
                                .foregroundColor(queue.isPaused ? .green : .orange)
                                Spacer()
                            }
                        }
                    }
                }
                
                if !queue.activeTasks.isEmpty {
                    Section("Téléchargements en cours") {
                        ForEach(Array(queue.activeTasks.keys), id: \.self) { docId in
                            let progress = queue.activeTasks[docId] ?? 0.0
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text("Document #\(docId)")
                                        .font(.subheadline.bold())
                                    Spacer()
                                    Text("\(Int(progress * 100))%")
                                        .font(.caption.monospacedDigit())
                                        .foregroundColor(.secondary)
                                    
                                    Button(action: {
                                        queue.pauseDownload(docId: docId)
                                    }) {
                                        Image(systemName: "pause.circle")
                                            .foregroundColor(.orange)
                                    }
                                    .buttonStyle(.plain)
                                    
                                    Button(action: {
                                        queue.cancelDownload(docId: docId)
                                    }) {
                                        Image(systemName: "xmark.circle")
                                            .foregroundColor(.red)
                                    }
                                    .buttonStyle(.plain)
                                }
                                ProgressView(value: progress)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
                
                if !queue.queuedDocIds.isEmpty {
                    Section("En attente (\(queue.queuedDocIds.count))") {
                        ForEach(queue.queuedDocIds, id: \.self) { docId in
                            HStack {
                                Image(systemName: "clock")
                                    .foregroundColor(.secondary)
                                Text("Document #\(docId)")
                                    .font(.subheadline)
                                Spacer()
                                Button(action: {
                                    queue.cancelDownload(docId: docId)
                                }) {
                                    Image(systemName: "xmark.circle")
                                        .foregroundColor(.secondary)
                                }
                                .buttonStyle(.plain)
                            }
                    }
                }
            }
        }
    }
}
