// OccurrenceNavigationBottomBar.swift
// Bandeau flottant de navigation des correspondances en bas d'écran (Style Goodnotes - Screenshot 2)

import SwiftUI

public struct OccurrenceNavigationBottomBar: View {
    public let searchQuery: String
    public let currentIndex: Int
    public let totalCount: Int
    public let onPrevious: () -> Void
    public let onNext: () -> Void
    public let onClose: () -> Void
    
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
        HStack(spacing: 12) {
            // Bouton Fermer à gauche
            Button(action: onClose) {
                Text("Fermer")
                    .font(.subheadline.bold())
                    .foregroundColor(.blue)
            }
            .accessibilityIdentifier("occurrence_bottom_bar_close")
            
            // Jeton du mot recherché
            Text(searchQuery)
                .font(.subheadline.monospaced())
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color(.secondarySystemFill))
                .cornerRadius(6)
                .lineLimit(1)
            
            // Compteur de correspondances
            if totalCount > 0 {
                Text("\(currentIndex + 1) sur \(totalCount) correspondances")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            } else {
                Text("Aucune correspondance")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            Spacer()
            
            // Boutons de navigation Précédente / Suivante
            HStack(spacing: 6) {
                Button(action: onPrevious) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(totalCount > 1 ? .blue : .secondary.opacity(0.4))
                        .frame(width: 32, height: 32)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(Circle())
                }
                .disabled(totalCount <= 1)
                .accessibilityIdentifier("occurrence_prev")
                
                Button(action: onNext) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(totalCount > 1 ? .blue : .secondary.opacity(0.4))
                        .frame(width: 32, height: 32)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(Circle())
                }
                .disabled(totalCount <= 1)
                .accessibilityIdentifier("occurrence_next")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(.ultraThinMaterial)
                .shadow(color: Color.black.opacity(0.12), radius: 10, x: 0, y: 4)
        )
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }
}
