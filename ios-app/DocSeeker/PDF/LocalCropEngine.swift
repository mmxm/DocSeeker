// LocalCropEngine.swift
// Découpe matérielle native d'extraits PDF via CoreGraphics et coordonnées Rust
// Prise en charge robuste des cropBox et décalages d'impression des éditeurs médicaux

import UIKit
import PDFKit

public final class LocalCropEngine {
    public static let shared = LocalCropEngine()

    private let cache = NSCache<NSString, UIImage>()
    private let cropScale: CGFloat = 1.5 // Optimisé pour netteté mobile sans surconsommation Retina 3x

    private init() {
        cache.countLimit = 150
        cache.totalCostLimit = 60 * 1024 * 1024 // 60 Mo de cache RAM max
    }

    public func cropOccurrence(
        pdfURL: URL,
        pageNumber: Int64,
        rect: [Double],
        highlightRects: [[Double]]? = nil,
        cacheKey: String
    ) -> UIImage? {
        if let cached = cache.object(forKey: cacheKey as NSString) {
            return cached
        }

        guard let pdfDoc = CGPDFDocument(pdfURL as CFURL),
              let page = pdfDoc.page(at: Int(pageNumber)) else {
            return nil
        }

        let cropBox = page.getBoxRect(.cropBox)
        let mediaBox = page.getBoxRect(.mediaBox)
        let effectiveBox = (cropBox.width > 0 && cropBox.height > 0) ? cropBox : mediaBox
        
        let pw = Double(effectiveBox.width)
        let ph = Double(effectiveBox.height)

        let bounds = RustBridge.shared.calculateCropBounds(rect: rect, pageWidth: pw, pageHeight: ph)

        let targetWidth = CGFloat(bounds.width) * cropScale
        let targetHeight = CGFloat(bounds.height) * cropScale
        let size = CGSize(width: max(1, targetWidth), height: max(1, targetHeight))

        // IMP-5 : UIGraphicsImageRenderer est thread-safe (contrairement à UIGraphicsBeginImageContextWithOptions)
        // Essentiel pour le chargement parallèle des vignettes dans le tiroir d'occurrences
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { ctx in
            let cgContext = ctx.cgContext
            
            // Fond blanc
            cgContext.setFillColor(UIColor.white.cgColor)
            cgContext.fill(CGRect(origin: .zero, size: size))

            // Transformer pour cadrer la zone découpée
            cgContext.saveGState()
            cgContext.translateBy(x: -CGFloat(bounds.x0) * cropScale, y: -CGFloat(bounds.y0) * cropScale)
            cgContext.scaleBy(x: cropScale, y: cropScale)

            // CoreGraphics a l'origine en bas à gauche pour le rendu de page PDF
            cgContext.saveGState()
            cgContext.translateBy(x: -effectiveBox.origin.x, y: CGFloat(ph) + effectiveBox.origin.y)
            cgContext.scaleBy(x: 1.0, y: -1.0)
            cgContext.drawPDFPage(page)
            cgContext.restoreGState()

            // Surlignage jaune Goodnotes translucide
            let yellowColor = UIColor(red: 1.0, green: 0.92, blue: 0.23, alpha: 0.40).cgColor
            cgContext.setFillColor(yellowColor)

            let rectsToHighlight = (highlightRects != nil && !highlightRects!.isEmpty) ? highlightRects! : [rect]
            for hl in rectsToHighlight where hl.count == 4 {
                let hx = CGFloat(hl[0])
                let hy = CGFloat(hl[1])
                let hw = CGFloat(hl[2] - hl[0])
                let hh = CGFloat(hl[3] - hl[1])
                cgContext.fill(CGRect(x: hx, y: hy, width: hw, height: hh))
            }

            cgContext.restoreGState()
        }

        if image.size.width > 0 {
            cache.setObject(image, forKey: cacheKey as NSString)
        }
        return image
    }
}
