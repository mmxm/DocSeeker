// SettingsView.swift
// Écran des paramètres de connexion, gestion du stockage local illimité et diagnostics

import SwiftUI

public struct SettingsView: View {
    @ObservedObject private var api = APIClient.shared
    @ObservedObject private var network = NetworkMonitor.shared
    @ObservedObject private var localDb = LocalDatabase.shared
    
    @AppStorage("appTheme") private var appTheme: String = "light"
    @State private var serverURLInput: String = ""
    @State private var passwordInput: String = ""
    @State private var loginMessage: String? = nil
    @State private var isLoggingIn: Bool = false
    @State private var showClearCacheConfirm: Bool = false
    @State private var storageBytes: Int64 = 0
    
    public init() {}
    
    public var body: some View {
        NavigationStack {
            Form {
                
                Section("Serveur NAS") {
                    HStack {
                        Image(systemName: "server.rack")
                            .foregroundColor(.accentColor)
                        TextField("http://192.168.1.50:8080", text: $serverURLInput)
                            .accessibilityIdentifier("server_url_input")
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .keyboardType(.URL)
                    }
                    
                    SecureField("Mot de passe administrateur", text: $passwordInput)
                        .accessibilityIdentifier("server_password_input")
                    
                    Button(action: performLogin) {
                        HStack {
                            Spacer()
                            if isLoggingIn {
                                ProgressView()
                            } else {
                                Text(api.isAuthenticated ? "Reconnecté avec succès" : "Se connecter")
                                    .bold()
                            }
                            Spacer()
                        }
                    }
                    .accessibilityIdentifier("server_connect_button")
                    .disabled(isLoggingIn)
                    
                    if let msg = loginMessage {
                        Text(msg)
                            .font(.caption)
                            .foregroundColor(api.isAuthenticated ? .green : .red)
                    }
                }
                
                Section("Réseau & Synchronisation") {
                    HStack {
                        Label("Statut réseau", systemImage: (network.isConnected && api.isServerReachable) ? "wifi" : "wifi.slash")
                        Spacer()
                        Text((network.isConnected && api.isServerReachable) ? "En ligne" : "Hors-ligne")
                            .foregroundColor((network.isConnected && api.isServerReachable) ? .green : .orange)
                    }
                }
                
                Section("Thème & Affichage") {
                    Picker("Thème", selection: $appTheme) {
                        Text("Clair").tag("light")
                        Text("Sombre").tag("dark")
                        Text("Système").tag("system")
                    }
                    .pickerStyle(.segmented)
                }
                
                Section("Stockage local (Illimité)") {
                    HStack {
                        Label("Documents synchronisés", systemImage: "doc.on.doc")
                        Spacer()
                        Text("\(localDb.cachedDocIds.count)")
                            .foregroundColor(.secondary)
                    }
                    
                    HStack {
                        Label("Espace disque utilisé", systemImage: "internaldrive")
                        Spacer()
                        Text(formatBytes(storageBytes))
                            .foregroundColor(.secondary)
                    }
                    
                    Button(role: .destructive, action: {
                        showClearCacheConfirm = true
                    }) {
                        HStack {
                            Image(systemName: "trash")
                            Text("Vider le cache hors-ligne")
                        }
                    }
                }
                
                Section("Moteur de recherche embarqué") {
                    HStack {
                        Label("Moteur local", systemImage: "cpu")
                        Spacer()
                        Text("Rust (search-core C-ABI)")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Label("Accélération graphique", systemImage: "sparkles")
                        Spacer()
                        Text("Apple Metal / CoreGraphics")
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Réglages")
            .onAppear {
                serverURLInput = api.serverURL
                passwordInput = KeychainManager.shared.get(key: "admin_password") ?? ""
                calculateStorage()
            }
            .confirmationDialog(
                "Supprimer tous les documents hors-ligne ?",
                isPresented: $showClearCacheConfirm,
                titleVisibility: .visible
            ) {
                Button("Tout effacer", role: .destructive) {
                    clearAllCache()
                }
                Button("Annuler", role: .cancel) {}
            }
        }
    }
    
    private func performLogin() {
        isLoggingIn = true
        loginMessage = nil
        api.setServerURL(serverURLInput)
        
        Task {
            do {
                _ = try await api.login(password: passwordInput)
                await MainActor.run {
                    self.isLoggingIn = false
                    self.loginMessage = "Authentification réussie"
                }
            } catch {
                await MainActor.run {
                    self.isLoggingIn = false
                    self.loginMessage = error.localizedDescription
                }
            }
        }
    }
    
    private func calculateStorage() {
        var total: Int64 = 0
        let fm = FileManager.default
        if let attrs = try? fm.attributesOfItem(atPath: localDb.dbURL.path),
           let size = attrs[.size] as? Int64 {
            total += size
        }
        if let files = try? fm.contentsOfDirectory(at: localDb.pdfDirectoryURL, includingPropertiesForKeys: [.fileSizeKey]) {
            for f in files {
                if let vals = try? f.resourceValues(forKeys: [.fileSizeKey]),
                   let s = vals.fileSize {
                    total += Int64(s)
                }
            }
        }
        self.storageBytes = total
    }
    
    private func clearAllCache() {
        let fm = FileManager.default
        try? fm.removeItem(at: localDb.pdfDirectoryURL)
        try? fm.createDirectory(at: localDb.pdfDirectoryURL, withIntermediateDirectories: true)
        try? fm.removeItem(at: localDb.dbURL)
        _ = RustBridge.shared.initDatabase(at: localDb.dbURL)
        localDb.refreshCachedDocs()
        calculateStorage()
    }
    
    private func formatBytes(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: bytes)
    }
}
