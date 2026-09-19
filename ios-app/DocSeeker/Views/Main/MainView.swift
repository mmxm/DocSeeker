// MainView.swift
// Interface principale style Goodnotes mobile :
// - Liste de documents et dossiers avec navigation arborescente (Screenshot 1)
// - Bandeau de navigation transparent flottant en bas (Documents / Réglages)
// - Transition fluide vers le lecteur multi-onglets Goodnotes (Screenshot 2)
// - Aucun grand titre encombrant

import SwiftUI

public enum MainBottomTab: Hashable {
    case documents
    case downloads
    case settings
}

public struct MainView: View {
    @AppStorage("appTheme") private var appTheme: String = "light"
    @ObservedObject private var tabManager = DocumentTabManager.shared
    @ObservedObject private var downloadQueue = DownloadQueueManager.shared
    @State private var activeTab: MainBottomTab = .documents
    
    public init() {}
    
    private var activeColorScheme: ColorScheme? {
        switch appTheme {
        case "dark":
            return .dark
        case "light":
            return .light
        default:
            return nil
        }
    }
    
    public var body: some View {
        ZStack {
            // Vue principale de navigation (Documents, Transferts, Réglages)
            // Conservée en mémoire en continu pour préserver l'arborescence et la recherche
            VStack(spacing: 0) {
                ZStack(alignment: .bottom) {
                    Group {
                        switch activeTab {
                        case .documents:
                            DocumentListView()
                        case .downloads:
                            DownloadQueueView()
                        case .settings:
                            SettingsView()
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    
                    floatingBottomBar
                }
            }
            .opacity(tabManager.isViewingReader && tabManager.activeTab != nil ? 0 : 1)
            .allowsHitTesting(!tabManager.isViewingReader || tabManager.activeTab == nil)
            
            // Lecteur PDF Goodnotes superposé
            if tabManager.isViewingReader && tabManager.activeTab != nil {
                GoodnotesPDFReaderView()
                    .transition(.opacity)
            }
        }
        .preferredColorScheme(activeColorScheme)
        .animation(.easeInOut(duration: 0.2), value: tabManager.isViewingReader)
    }
    
    // MARK: - Bandeau de Navigation Flottant Translucide (Screenshot 1)
    private var floatingBottomBar: some View {
        HStack(spacing: 36) {
            // Onglet Documents (Arborescence)
            Button(action: {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    activeTab = .documents
                }
            }) {
                VStack(spacing: 3) {
                    Image(systemName: activeTab == .documents ? "folder.fill" : "folder")
                        .font(.system(size: 20))
                    Text("Documents")
                        .font(.caption2.weight(activeTab == .documents ? .semibold : .regular))
                }
                .foregroundColor(activeTab == .documents ? .accentColor : .secondary)
            }
            .accessibilityLabel("Onglet Documents")
            
            // Onglet Téléchargements (avec badge dynamique)
            Button(action: {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    activeTab = .downloads
                }
            }) {
                VStack(spacing: 3) {
                    ZStack(alignment: .topTrailing) {
                        Image(systemName: activeTab == .downloads ? "arrow.down.circle.fill" : "arrow.down.circle")
                            .font(.system(size: 20))
                        
                        let count = downloadQueue.activeTasks.count + downloadQueue.queuedDocIds.count
                        if count > 0 {
                            Circle()
                                .fill(Color.blue)
                                .frame(width: 8, height: 8)
                                .offset(x: 6, y: -2)
                        }
                    }
                    Text("Transferts")
                        .font(.caption2.weight(activeTab == .downloads ? .semibold : .regular))
                }
                .foregroundColor(activeTab == .downloads ? .accentColor : .secondary)
            }
            .accessibilityLabel("Onglet Transferts")
            
            // Onglet Réglages
            Button(action: {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    activeTab = .settings
                }
            }) {
                VStack(spacing: 3) {
                    Image(systemName: activeTab == .settings ? "gearshape.fill" : "gearshape")
                        .font(.system(size: 20))
                    Text("Réglages")
                        .font(.caption2.weight(activeTab == .settings ? .semibold : .regular))
                }
                .foregroundColor(activeTab == .settings ? .accentColor : .secondary)
            }
            .accessibilityLabel("Onglet Réglages")
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 10)
        .background(
            Capsule()
                .fill(.ultraThinMaterial)
                .shadow(color: Color.black.opacity(0.1), radius: 10, x: 0, y: 4)
                .overlay(
                    Capsule()
                        .stroke(Color.white.opacity(0.4), lineWidth: 0.5)
                )
        )
        .padding(.bottom, 12)
    }
}
