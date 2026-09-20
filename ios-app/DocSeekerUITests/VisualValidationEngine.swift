// VisualValidationEngine.swift
// Moteur d'analyses visuelles automatiques multi-niveaux (Niveau 1, Niveau 2, Niveau 3)
// Conforme au Cahier des Charges de Tests Exhaustifs et aux règles de non-régression visuelle

import Foundation
import XCTest
import UIKit
import Vision
import PDFKit

public final class VisualValidationEngine {
    
    public struct VisualTestResult {
        public let level1Passed: Bool
        public let blankPixelPercentage: Double
        public let luminanceVariance: Double
        
        public let level2Passed: Bool
        public let pixelMatchPercentage: Double
        public let diffImage: UIImage?
        
        public let level3Passed: Bool
        public let recognizedWords: [String]
        public let matchedKeywords: [String]
    }
    
    // MARK: - Niveau 1 : Détecteur d'écran blanc (Blank Screen Detector)
    
    /// Valide qu'une image capturée à l'écran contient du contenu visuel réel et n'est pas un canvas blanc/vide
    @discardableResult
    public static func assertNonBlankScreen(
        image: UIImage,
        maxBlankPercentage: Double = 99.0,
        minVariance: Double = 0.001,
        testCase: XCTestCase? = nil,
        context: String = "Écran capturé"
    ) -> (passed: Bool, blankPercent: Double, variance: Double) {
        guard let cgImage = image.cgImage else {
            XCTFail("[\(context)] Impossible d'obtenir le CGImage pour l'analyse visuelle Niveau 1")
            return (false, 100.0, 0.0)
        }
        
        let width = cgImage.width
        let height = cgImage.height
        guard width > 0 && height > 0 else {
            XCTFail("[\(context)] Dimensions d'image nulles (\(width)x\(height))")
            return (false, 100.0, 0.0)
        }
        
        guard let dataProvider = cgImage.dataProvider,
              let data = dataProvider.data,
              let ptr = CFDataGetBytePtr(data) else {
            XCTFail("[\(context)] Impossible d'accéder aux octets bruts de l'image")
            return (false, 100.0, 0.0)
        }
        
        let bytesPerPixel = cgImage.bitsPerPixel / 8
        let bytesPerRow = cgImage.bytesPerRow
        let totalPixels = width * height
        
        var whitePixelsCount = 0
        var luminanceSum = 0.0
        var luminanceSqSum = 0.0
        
        for y in 0..<height {
            let rowOffset = y * bytesPerRow
            for x in 0..<width {
                let pixelOffset = rowOffset + (x * bytesPerPixel)
                let r = Double(ptr[pixelOffset])
                let g = Double(ptr[pixelOffset + 1])
                let b = Double(ptr[pixelOffset + 2])
                
                // Calcul de la luminance perceptuelle normalisée [0.0, 1.0]
                let lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
                luminanceSum += lum
                luminanceSqSum += (lum * lum)
                
                // Pixel blanc si R, G, B > 248
                if r > 248 && g > 248 && b > 248 {
                    whitePixelsCount += 1
                }
            }
        }
        
        let blankPercent = (Double(whitePixelsCount) / Double(totalPixels)) * 100.0
        let meanLum = luminanceSum / Double(totalPixels)
        let variance = (luminanceSqSum / Double(totalPixels)) - (meanLum * meanLum)
        
        let isNotBlank = blankPercent <= maxBlankPercentage && variance >= minVariance
        
        if !isNotBlank {
            if let tc = testCase {
                let attachment = XCTAttachment(image: image)
                attachment.name = "ECHEC_NIVEAU_1_ECRAN_BLANC_\(context)"
                attachment.lifetime = .keepAlways
                tc.add(attachment)
            }
            XCTFail("❌ [Niveau 1 Échoué - \(context)] Écran blanc détecté ! Blanc: \(String(format: "%.2f", blankPercent))% (max: \(maxBlankPercentage)%), Variance: \(String(format: "%.5f", variance)) (min: \(minVariance))")
        }
        
        return (isNotBlank, blankPercent, variance)
    }
    
    // MARK: - Niveau 2 : Ground Truth Pixel Matching & Diff Mask
    
    /// Compare pixel à pixel l'image affichée avec la page PDF de référence originale rendue en mémoire
    @discardableResult
    public static func assertPixelMatchAgainstPDF(
        capturedImage: UIImage,
        pdfURL: URL,
        pageNumber: Int,
        minMatchPercentage: Double = 88.0,
        testCase: XCTestCase? = nil,
        context: String = "Page PDF"
    ) -> (passed: Bool, score: Double, diffImage: UIImage?) {
        guard let doc = CGPDFDocument(pdfURL as CFURL),
              let page = doc.page(at: pageNumber) else {
            XCTFail("[\(context)] Impossible d'ouvrir le document PDF de référence à l'URL: \(pdfURL)")
            return (false, 0.0, nil)
        }
        
        guard let capturedCG = capturedImage.cgImage else {
            XCTFail("[\(context)] Image capturée invalide")
            return (false, 0.0, nil)
        }
        
        let w = capturedCG.width
        let h = capturedCG.height
        
        // Rendu de la référence PDF à la dimension exacte de l'élément capturé
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
        guard let refContext = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: colorSpace, bitmapInfo: bitmapInfo.rawValue) else {
            XCTFail("[\(context)] Échec création contexte de référence CoreGraphics")
            return (false, 0.0, nil)
        }
        
        // Fond blanc de référence
        refContext.setFillColor(UIColor.white.cgColor)
        refContext.fill(CGRect(x: 0, y: 0, width: w, height: h))
        
        // Mise à l'échelle pour correspondre au ratio d'affichage
        let pageRect = page.getBoxRect(.mediaBox)
        let scale = min(CGFloat(w) / pageRect.width, CGFloat(h) / pageRect.height)
        let offsetX = (CGFloat(w) - pageRect.width * scale) / 2.0
        let offsetY = (CGFloat(h) - pageRect.height * scale) / 2.0
        
        refContext.saveGState()
        refContext.translateBy(x: offsetX, y: offsetY)
        refContext.scaleBy(x: scale, y: scale)
        refContext.drawPDFPage(page)
        refContext.restoreGState()
        
        guard let refCG = refContext.makeImage() else {
            XCTFail("[\(context)] Échec génération image de référence")
            return (false, 0.0, nil)
        }
        
        // Comparaison des deux tampons RGBA
        guard let capData = capturedCG.dataProvider?.data,
              let capPtr = CFDataGetBytePtr(capData),
              let refData = refCG.dataProvider?.data,
              let refPtr = CFDataGetBytePtr(refData) else {
            XCTFail("[\(context)] Impossible d'extraire les octets de comparaison")
            return (false, 0.0, nil)
        }
        
        let capBPP = capturedCG.bitsPerPixel / 8
        let capBPR = capturedCG.bytesPerRow
        let refBPP = refCG.bitsPerPixel / 8
        let refBPR = refCG.bytesPerRow
        
        // Contexte pour le masque de diff
        guard let diffContext = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: colorSpace, bitmapInfo: bitmapInfo.rawValue) else {
            return (false, 0.0, nil)
        }
        diffContext.setFillColor(UIColor.white.cgColor)
        diffContext.fill(CGRect(x: 0, y: 0, width: w, height: h))
        
        var matchingPixels = 0
        let totalPixels = w * h
        
        for y in 0..<h {
            let capRow = y * capBPR
            let refRow = y * refBPR
            for x in 0..<w {
                let capIdx = capRow + (x * capBPP)
                let refIdx = refRow + (x * refBPP)
                
                let cr = Double(capPtr[capIdx])
                let cg = Double(capPtr[capIdx + 1])
                let cb = Double(capPtr[capIdx + 2])
                
                let rr = Double(refPtr[refIdx])
                let rg = Double(refPtr[refIdx + 1])
                let rb = Double(refPtr[refIdx + 2])
                
                // Distance colorimétrique normalisée
                let delta = (abs(cr - rr) + abs(cg - rg) + abs(cb - rb)) / (3.0 * 255.0)
                
                if delta <= 0.15 { // Tolérance de 15% pour antialiasing et compression GPU
                    matchingPixels += 1
                } else {
                    // Marquer le pixel divergent en Magenta vif (#FF00FF)
                    diffContext.setFillColor(UIColor(red: 1.0, green: 0.0, blue: 1.0, alpha: 1.0).cgColor)
                    diffContext.fill(CGRect(x: x, y: y, width: 1, height: 1))
                }
            }
        }
        
        let matchScore = (Double(matchingPixels) / Double(totalPixels)) * 100.0
        let passed = matchScore >= minMatchPercentage
        
        var diffUIImage: UIImage? = nil
        if let diffCG = diffContext.makeImage() {
            diffUIImage = UIImage(cgImage: diffCG)
        }
        
        if !passed {
            if let tc = testCase, let diffImg = diffUIImage {
                let attachment = XCTAttachment(image: diffImg)
                attachment.name = "DIFF_MASK_NIVEAU_2_\(context)"
                attachment.lifetime = .keepAlways
                tc.add(attachment)
            }
            XCTFail("❌ [Niveau 2 Échoué - \(context)] Score de similarité pixel insuffisant: \(String(format: "%.2f", matchScore))% (minimum requis: \(minMatchPercentage)%)")
        }
        
        return (passed, matchScore, diffUIImage)
    }
    
    // MARK: - Niveau 3 : Reconnaissance Optique Neuronale Apple Vision
    
    /// Valide par OCR neuronal (Apple Vision) que le texte attendu est bien visible à l'écran
    @discardableResult
    public static func assertVisibleTextContains(
        image: UIImage,
        expectedKeywords: [String],
        testCase: XCTestCase? = nil,
        context: String = "Texte à l'écran"
    ) -> (passed: Bool, recognizedText: String, matchedWords: [String]) {
        guard let cgImage = image.cgImage else {
            XCTFail("[\(context)] Image OCR invalide")
            return (false, "", [])
        }
        
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["fr-FR", "en-US"]
        
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            XCTFail("[\(context)] Erreur exécution Apple Vision OCR: \(error)")
            return (false, "", [])
        }
        
        let observations = request.results ?? []
        let recognizedStrings = observations.compactMap { $0.topCandidates(1).first?.string }
        let fullRecognizedText = recognizedStrings.joined(separator: " ")
        
        var matched: [String] = []
        for keyword in expectedKeywords {
            if fullRecognizedText.localizedCaseInsensitiveContains(keyword) {
                matched.append(keyword)
            }
        }
        
        let passed = !matched.isEmpty
        
        if !passed {
            if let tc = testCase {
                let attachment = XCTAttachment(image: image)
                attachment.name = "ECHEC_OCR_NIVEAU_3_\(context)"
                attachment.lifetime = .keepAlways
                tc.add(attachment)
            }
            XCTFail("❌ [Niveau 3 Échoué - \(context)] Aucun des mots-clés attendus \(expectedKeywords) n'a été reconnu. Texte OCR détecté: '\(fullRecognizedText)'")
        }
        
        return (passed, fullRecognizedText, matched)
    }
}
