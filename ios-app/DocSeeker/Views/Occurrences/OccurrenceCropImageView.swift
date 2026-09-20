// OccurrenceCropImageView.swift
// Affichage hybride d'un extrait de page : CoreGraphics local si PDF hors ligne, ou API distante authentifiée si en ligne

import SwiftUI

public struct OccurrenceCropImageView: View {
    public let documentId: Int64
    public let filename: String
    public let occurrence: OccurrenceResult
    
    @State private var image: UIImage? = nil
    @State private var isLoading: Bool = true
    
    public init(documentId: Int64, filename: String, occurrence: OccurrenceResult) {
        self.documentId = documentId
        self.filename = filename
        self.occurrence = occurrence
    }
    
    public var body: some View {
        ZStack {
            if let img = image {
                Image(uiImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else if isLoading {
                ZStack {
                    Color(.secondarySystemBackground)
                    ProgressView()
                        .scaleEffect(0.8)
                }
            } else {
                ZStack {
                    Color(.secondarySystemBackground)
                    VStack(spacing: 4) {
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 20))
                            .foregroundColor(.secondary)
                        Text("Page \(occurrence.page_number)")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
            }
        }
        .aspectRatio(2.5, contentMode: .fit)
        .clipped()
        .cornerRadius(6)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color(.separator), lineWidth: 0.5)
        )
        .task(id: occurrence.id) {
            await loadCrop()
        }
    }
    
    private func loadCrop() async {
        isLoading = true
        defer { isLoading = false }
        
        let cacheKey = "crop_\(documentId)_\(occurrence.page_number)_\(occurrence.occ_id)"
        
        // 1. Si le PDF est présent localement sur le disque de l'appareil -> rendu CoreGraphics direct
        if let localPDFURL = LocalDatabase.shared.getLocalPDFURL(docId: documentId) {
            let pageNum = occurrence.page_number
            let r = occurrence.rect
            let hl = occurrence.highlight_rects
            let cropped = await Task.detached(priority: .userInitiated) {
                LocalCropEngine.shared.cropOccurrence(
                    pdfURL: localPDFURL,
                    pageNumber: pageNum,
                    rect: r,
                    highlightRects: hl,
                    cacheKey: cacheKey
                )
            }.value
            
            if let cropped = cropped {
                await MainActor.run {
                    self.image = cropped
                }
                return
            }
        }
        
        // 2. Si non présent localement et qu'on a une URL distante -> téléchargement NAS avec token de session
        if let cropURLStr = occurrence.crop_url {
            var fullUrlStr = "\(APIClient.shared.serverURL)\(cropURLStr)"
            if let token = APIClient.shared.sessionToken ?? KeychainManager.shared.get(key: "session_token") {
                let sep = fullUrlStr.contains("?") ? "&" : "?"
                fullUrlStr += "\(sep)token=\(token)"
            }
            
            if let url = URL(string: fullUrlStr) {
                do {
                    var request = URLRequest(url: url)
                    request.timeoutInterval = 10.0
                    let (data, response) = try await URLSession.shared.data(for: request)
                    if let http = response as? HTTPURLResponse, http.statusCode == 200,
                       let img = UIImage(data: data) {
                        await MainActor.run {
                            self.image = img
                        }
                        return
                    }
                } catch {
                    // Erreur réseau ou timeout
                }
            }
        }
    }
}
