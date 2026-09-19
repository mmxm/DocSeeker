// DocSeekerApp.swift
// Point d'entrée de l'application iOS / iPadOS native DocSeeker

import SwiftUI

@main
struct DocSeekerApp: App {
    @AppStorage("appTheme") private var appTheme: String = "light"
    
    init() {
        // Initialisation anticipée de la base locale et du cycle de vie réseau
        _ = LocalDatabase.shared
        _ = NetworkMonitor.shared
        _ = APIClient.shared
    }
    
    private var activeColorScheme: ColorScheme? {
        switch appTheme {
        case "dark":
            return .dark
        case "system":
            return nil
        default:
            return .light // Thème clair par défaut
        }
    }
    
    var body: some Scene {
        WindowGroup {
            MainView()
                .preferredColorScheme(activeColorScheme)
        }
    }
}
