import SwiftUI
import UIKit

/// Configurateur de scène de fenêtre pour macOS (Designed for iPad) et iPadOS
/// Déverrouille explicitement le redimensionnement libre à la souris et active le mode plein écran
struct WindowSceneConfigurator: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController {
        let vc = UIViewController()
        vc.view.backgroundColor = .clear
        return vc
    }
    
    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {
        DispatchQueue.main.async {
            guard let windowScene = uiViewController.view.window?.windowScene else { return }
            if let restrictions = windowScene.sizeRestrictions {
                restrictions.minimumSize = CGSize(width: 500, height: 400)
                restrictions.maximumSize = CGSize(width: 4000, height: 3000)
                restrictions.allowsFullScreen = true
            }
        }
    }
}

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
                .background(WindowSceneConfigurator())
        }
    }
}
