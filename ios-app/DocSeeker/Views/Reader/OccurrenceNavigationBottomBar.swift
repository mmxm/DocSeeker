// OccurrenceNavigationBottomBar.swift
// Bandeau flottant de navigation des correspondances en bas d'écran (Style Goodnotes - Screenshot 2)
// Transparent et discret : auto-fade à 45% d'opacité après 2s d'inactivité

import SwiftUI

public struct OccurrenceNavigationBottomBar: View {
    public let searchQuery: String
    public let currentIndex: Int
    public let totalCount: Int
    public let onPrevious: () -> Void
    public let onNext: () -> Void
    public let onClose: () -> Void
    
    // Auto-fade : 100% visible au début, réduit à 45% après 2s sans interaction
    @State private var isIdling: Bool = false
    @State private var idleTimer: Timer? = nil
    
    private var barOpacity: Double { isIdling ? 0.45 : 1.0 }
    
    public init(
        searchQuery: String,
        currentIndex: Int,
        totalCount: Int,
        onPrevious: @escaping () -> Void,
        onNext: @escaping () -> Void,
        onClose: @escaping () -> Void
    ) {
        self.searchQuery = searchQuery
        self.currentIndex = currentIndex
        self.totalCount = totalCount
        self.onPrevious = onPrevious
        self.onNext = onNext
        self.onClose = onClose
    }
    
    public var body: some View {
        HStack(spacing: 10) {
            // Bouton Fermer
            Button(action: {
                wakeUp()
                onClose()
            }) {
                Text("Fermer")
                    .font(.subheadline.bold())
                    .foregroundColor(.blue)
            }
            .accessibilityIdentifier("occurrence_bottom_bar_close")
            
            // Jeton du mot recherché
            Text(searchQuery)
                .font(.caption.monospaced())
                .lineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Color(.secondarySystemFill).opacity(0.7))
                .cornerRadius(5)
            
            // Compteur compact
            if totalCount > 0 {
                Text("\(currentIndex + 1)/\(totalCount)")
                    .font(.caption2.monospacedDigit())
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .accessibilityIdentifier("occurrence_counter")
            }
            
            Spacer(minLength: 6)
            
            // Boutons précédent / suivant
            HStack(spacing: 4) {
                Button(action: {
                    wakeUp()
                    onPrevious()
                }) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(totalCount > 1 ? .blue : .secondary.opacity(0.4))
                        .frame(width: 30, height: 30)
                        .background(Color(.tertiarySystemFill).opacity(0.6))
                        .clipShape(Circle())
                }
                .disabled(totalCount <= 1)
                .accessibilityIdentifier("occurrence_prev")
                
                Button(action: {
                    wakeUp()
                    onNext()
                }) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundColor(totalCount > 1 ? .blue : .secondary.opacity(0.4))
                        .frame(width: 30, height: 30)
                        .background(Color(.tertiarySystemFill).opacity(0.6))
                        .clipShape(Circle())
                }
                .disabled(totalCount <= 1)
                .accessibilityIdentifier("occurrence_next")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(
            Capsule()
                .fill(.ultraThinMaterial)
                // Fond supplémentaire très léger pour renforcer la lisibilité du texte sans opacifier
                .overlay(
                    Capsule().fill(Color(.systemBackground).opacity(0.15))
                )
                .shadow(color: Color.black.opacity(0.10), radius: 8, x: 0, y: 2)
        )
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .opacity(barOpacity)
        .animation(.easeInOut(duration: 0.5), value: isIdling)
        .onAppear { scheduleIdle() }
        .onDisappear { idleTimer?.invalidate() }
        // Tap quelque part sur le bandeau réveille l'opacité
        .onTapGesture { wakeUp() }
    }
    
    // MARK: - Auto-fade logic
    
    private func scheduleIdle() {
        idleTimer?.invalidate()
        isIdling = false
        idleTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { _ in
            withAnimation { isIdling = true }
        }
    }
    
    private func wakeUp() {
        scheduleIdle() // redémarre le compteur et remet opacité à 100%
    }
}
