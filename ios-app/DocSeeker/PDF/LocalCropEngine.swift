// LocalCropEngine.swift
// Découpe matérielle native d'extraits PDF via CoreGraphics et coordonnées Rust

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

        let pageBox = page.getBoxRect(.mediaBox)
        let pw = Double(pageBox.width)
        let ph = Double(pageBox.height)

        let bounds = RustBridge.shared.calculateCropBounds(rect: rect, pageWidth: pw, pageHeight: ph)

        let targetWidth = CGFloat(bounds.width) * cropScale
        let targetHeight = CGFloat(bounds.height) * cropScale
        let size = CGSize(width: max(1, targetWidth), height: max(1, targetHeight))

        UIGraphicsBeginImageContextWithOptions(size, true, 1.0)
        guard let ctx = UIGraphicsGetCurrentContext() else {
            UIGraphicsEndImageContext()
            return nil
        }

        // Fond blanc
        ctx.setFillColor(UIColor.white.cgColor)
        ctx.fill(CGRect(origin: .zero, size: size))

        // Transformer pour cadrer la zone découpée
        ctx.saveGState()
        ctx.translateBy(x: -CGFloat(bounds.x0) * cropScale, y: -CGFloat(bounds.y0) * cropScale)
        ctx.scaleBy(x: cropScale, y: cropScale)

        // CoreGraphics a l'origine en bas à gauche pour le rendu de page PDF
        ctx.saveGState()
        ctx.translateBy(x: 0, y: CGFloat(ph))
        ctx.scaleBy(x: 1.0, y: -1.0)
        ctx.drawPDFPage(page)
        ctx.restoreGState()

        // Surlignage jaune Goodnotes translucide
        let yellowColor = UIColor(red: 1.0, green: 0.92, blue: 0.23, alpha: 0.40).cgColor
        ctx.setFillColor(yellowColor)

        let rectsToHighlight = (highlightRects != nil && !highlightRects!.isEmpty) ? highlightRects! : [rect]
        for hl in rectsToHighlight where hl.count == 4 {
            let hx = CGFloat(hl[0])
            let hy = CGFloat(hl[1])
            let hw = CGFloat(hl[2] - hl[0])
            let hh = CGFloat(hl[3] - hl[1])
            ctx.fill(CGRect(x: hx, y: hy, width: hw, height: hh))
        }

        ctx.restoreGState()

        let image = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()

        if let img = image {
            cache.setObject(img, forKey: cacheKey as NSString)
        }
        return image
    }
}
