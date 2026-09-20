// PDFKitView.swift
// Lecteur PDF natif accéléré matériellement (Apple PDFKit / Metal 120Hz)
// Support robuste du streaming asynchrone sans écran blanc avec indicateur d'activité natif

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
        
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .systemBlue
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        pdfView.addSubview(spinner)
        
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: pdfView.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: pdfView.centerYAnchor)
        ])
        
        context.coordinator.pdfView = pdfView
        context.coordinator.spinner = spinner
        
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.pageChanged(_:)),
            name: .PDFViewPageChanged,
            object: pdfView
        )
        
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.documentChanged(_:)),
            name: .PDFViewDocumentChanged,
            object: pdfView
        )
        
        context.coordinator.loadDocument(url: documentURL, targetPage: targetPage ?? currentPage)
        
        return pdfView
    }
    
    public func updateUIView(_ uiView: PDFView, context: Context) {
        context.coordinator.parent = self
        
        if uiView.document?.documentURL != documentURL {
            context.coordinator.loadDocument(url: documentURL, targetPage: targetPage ?? currentPage)
            return
        }
        
        // Navigation ciblée vers une occurrence
        let shouldNavigate = (context.coordinator.lastNavigatedPage != targetPage || context.coordinator.lastNavigatedRect != targetRect)
        if shouldNavigate,
           let targetPage = targetPage,
           let doc = uiView.document,
           doc.pageCount >= targetPage,
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
        weak var spinner: UIActivityIndicatorView?
        var activeHighlight: (PDFPage, PDFAnnotation)?
        var lastNavigatedPage: Int?
        var lastNavigatedRect: [Double]?
        var checkTimer: Timer?
        var checkRetries: Int = 0
        
        init(_ parent: PDFKitView) {
            self.parent = parent
        }
        
        deinit {
            NotificationCenter.default.removeObserver(self)
            checkTimer?.invalidate()
            clearHighlights()
        }
        
        func loadDocument(url: URL, targetPage: Int) {
            guard let pdfView = pdfView else { return }
            
            checkTimer?.invalidate()
            checkRetries = 0
            spinner?.startAnimating()
            
            if let doc = PDFDocument(url: url) {
                pdfView.document = doc
                if doc.pageCount > 0 {
                    spinner?.stopAnimating()
                    let targetIdx = max(0, targetPage - 1)
                    if let page = doc.page(at: min(targetIdx, doc.pageCount - 1)) {
                        pdfView.go(to: page)
                    }
                    return
                }
            }
            
            // Si chargement asynchrone (URL distante ou gros fichier), scruter l'arrivée des pages
            checkTimer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] timer in
                guard let self = self, let pdfView = self.pdfView else {
                    timer.invalidate()
                    return
                }
                self.checkRetries += 1
                
                if let doc = pdfView.document, doc.pageCount > 0 {
                    self.spinner?.stopAnimating()
                    timer.invalidate()
                    self.checkTimer = nil
                    let targetIdx = max(0, targetPage - 1)
                    if let page = doc.page(at: min(targetIdx, doc.pageCount - 1)) {
                        pdfView.go(to: page)
                    }
                } else if self.checkRetries > 40 {
                    // Au bout de 6 secondes sans page, tenter une réinstanciation ou stopper le spinner
                    self.spinner?.stopAnimating()
                    timer.invalidate()
                    self.checkTimer = nil
                }
            }
        }
        
        func clearHighlights() {
            if let (page, annotation) = activeHighlight {
                page.removeAnnotation(annotation)
                activeHighlight = nil
            }
        }
        
        @objc func documentChanged(_ notification: Notification) {
            guard let pdfView = pdfView, let doc = pdfView.document, doc.pageCount > 0 else { return }
            spinner?.stopAnimating()
            checkTimer?.invalidate()
            checkTimer = nil
            let targetIdx = max(0, (parent.targetPage ?? parent.currentPage) - 1)
            if let page = doc.page(at: min(targetIdx, doc.pageCount - 1)) {
                pdfView.go(to: page)
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
