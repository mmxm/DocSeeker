// PDFKitView.swift
// Lecteur PDF natif accéléré matériellement (Apple PDFKit / Metal 120Hz)

import SwiftUI
import PDFKit

public struct PDFKitView: UIViewRepresentable {
    public let documentURL: URL
    @Binding public var currentPage: Int
    public var targetPage: Int?
    public var targetRect: [Double]?
    
    public init(
        documentURL: URL,
        currentPage: Binding<Int>,
        targetPage: Int? = nil,
        targetRect: [Double]? = nil
    ) {
        self.documentURL = documentURL
        self._currentPage = currentPage
        self.targetPage = targetPage
        self.targetRect = targetRect
    }
    
    public func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    public func makeUIView(context: Context) -> PDFView {
        let pdfView = PDFView()
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.displaysPageBreaks = true
        pdfView.usePageViewController(false)
        pdfView.backgroundColor = .systemGroupedBackground
        
        if let doc = PDFDocument(url: documentURL) {
            pdfView.document = doc
        }
        
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.pageChanged(_:)),
            name: .PDFViewPageChanged,
            object: pdfView
        )
        
        context.coordinator.pdfView = pdfView
        return pdfView
    }
    
    public func updateUIView(_ uiView: PDFView, context: Context) {
        if uiView.document?.documentURL != documentURL {
            if let doc = PDFDocument(url: documentURL) {
                uiView.document = doc
            }
        }
        
        // Navigation ciblée vers une occurrence
        let shouldNavigate = (context.coordinator.lastNavigatedPage != targetPage || context.coordinator.lastNavigatedRect != targetRect)
        if shouldNavigate,
           let targetPage = targetPage,
           let doc = uiView.document,
           let page = doc.page(at: max(0, targetPage - 1)) {
            
            context.coordinator.lastNavigatedPage = targetPage
            context.coordinator.lastNavigatedRect = targetRect
            
            // Nettoyer anciennes annotations temporaires
            context.coordinator.clearHighlights()
            
            if let rect = targetRect, rect.count == 4 {
                let box = page.bounds(for: .mediaBox)
                // Conversion coordonnées DocSeeker (top-left) vers PDFKit (bottom-left)
                let x = CGFloat(rect[0])
                let y = box.height - CGFloat(rect[3])
                let width = max(4, CGFloat(rect[2] - rect[0]))
                let height = max(4, CGFloat(rect[3] - rect[1]))
                let highlightRect = CGRect(x: x, y: y, width: width, height: height)
                
                let annotation = PDFAnnotation(
                    bounds: highlightRect,
                    forType: .highlight,
                    withProperties: nil
                )
                annotation.color = UIColor(red: 1.0, green: 0.85, blue: 0.0, alpha: 0.45)
                page.addAnnotation(annotation)
                context.coordinator.activeHighlight = (page, annotation)
                
                DispatchQueue.main.async {
                    let paddedRect = highlightRect.insetBy(dx: -40, dy: -40)
                    uiView.go(to: paddedRect, on: page)
                }
            } else {
                DispatchQueue.main.async {
                    uiView.go(to: page)
                }
            }
        }
    }
    
    public class Coordinator: NSObject {
        var parent: PDFKitView
        weak var pdfView: PDFView?
        var activeHighlight: (PDFPage, PDFAnnotation)?
        var lastNavigatedPage: Int?
        var lastNavigatedRect: [Double]?
        
        init(_ parent: PDFKitView) {
            self.parent = parent
        }
        
        deinit {
            NotificationCenter.default.removeObserver(self)
            clearHighlights()
        }
        
        func clearHighlights() {
            if let (page, annotation) = activeHighlight {
                page.removeAnnotation(annotation)
                activeHighlight = nil
            }
        }
        
        @objc func pageChanged(_ notification: Notification) {
            guard let pdfView = pdfView,
                  let current = pdfView.currentPage,
                  let doc = pdfView.document else { return }
            let index = doc.index(for: current)
            DispatchQueue.main.async {
                self.parent.currentPage = index + 1
            }
        }
    }
}
