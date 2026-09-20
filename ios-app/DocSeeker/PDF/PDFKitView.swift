// PDFKitView.swift
// Lecteur PDF natif accéléré matériellement (Apple PDFKit / Metal 120Hz)
// Support robuste du streaming asynchrone sans écran blanc avec indicateur d'activité natif

import SwiftUI
import PDFKit
import GameController
import Darwin

public class DocSeekerPDFView: PDFView {
    public var isFitToWidth: Bool = false {
        didSet {
            if isFitToWidth != oldValue {
                applyFitToWidth()
            }
        }
    }
    public var isTwoPagesMode: Bool = false {
        didSet {
            if isTwoPagesMode != oldValue {
                applyFitToWidth()
            }
        }
    }
    public var onManualZoom: (() -> Void)?
    private var lastBoundsWidth: CGFloat = 0
    private var mouseWheelZoomGesture: UIPanGestureRecognizer?
    private var isCommandKeyPressed: Bool = false
    private var didAttachScrollRequirements = false
    
    private static let cgEventSourceFlagsStateFn: (@convention(c) (Int32) -> UInt64)? = {
        if let handle = dlsym(dlopen(nil, RTLD_NOW), "CGEventSourceFlagsState") {
            return unsafeBitCast(handle, to: (@convention(c) (Int32) -> UInt64).self)
        }
        return nil
    }()
    
    public override init(frame: CGRect) {
        super.init(frame: frame)
        setupMouseWheelZoom()
    }
    
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupMouseWheelZoom()
    }
    
    private func setupMouseWheelZoom() {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleMouseWheelZoom(_:)))
        pan.allowedScrollTypesMask = [.discrete, .continuous]
        pan.cancelsTouchesInView = false
        pan.delegate = self
        addGestureRecognizer(pan)
        self.mouseWheelZoomGesture = pan
    }
    
    public var isCommandPressed: Bool {
        // 1. Accès direct matériel aux drapeaux CoreGraphics (macOS / Designed for iPad - instantané et sans délai)
        if let fn = Self.cgEventSourceFlagsStateFn {
            let flagsCombined = fn(0) // kCGEventSourceStateCombinedSessionState
            let flagsHID = fn(1)      // kCGEventSourceStateHIDSystemState
            let kCGEventFlagMaskCommand: UInt64 = 0x00100000
            if (flagsCombined & kCGEventFlagMaskCommand) != 0 || (flagsHID & kCGEventFlagMaskCommand) != 0 {
                return true
            }
        }
        
        // 2. Détection GameController (iPad physique avec Magic Keyboard / clavier externe)
        if let kb = GCKeyboard.coalesced?.keyboardInput {
            let leftCmd = kb.button(forKeyCode: .leftGUI)?.isPressed ?? false
            let rightCmd = kb.button(forKeyCode: .rightGUI)?.isPressed ?? false
            if leftCmd || rightCmd { return true }
        }
        
        // 3. Fallback UIResponder
        return isCommandKeyPressed
    }
    
    public override var canBecomeFirstResponder: Bool {
        return true
    }
    
    public override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for press in presses {
            if press.key?.modifierFlags.contains(.command) == true {
                isCommandKeyPressed = true
            }
        }
        super.pressesBegan(presses, with: event)
    }
    
    public override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        for press in presses {
            if press.key?.modifierFlags.contains(.command) == true {
                isCommandKeyPressed = false
            }
        }
        super.pressesEnded(presses, with: event)
    }
    
    public override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        isCommandKeyPressed = false
        super.pressesCancelled(presses, with: event)
    }
    
    @objc private func handleMouseWheelZoom(_ gesture: UIPanGestureRecognizer) {
        guard isCommandPressed else { return }
        
        let translation = gesture.translation(in: self)
        let delta = -translation.y
        
        if abs(delta) > 0.05 {
            autoScales = false
            if isFitToWidth {
                isFitToWidth = false
            }
            onManualZoom?()
            
            // Zoom progressif fluide à la molette
            let sensitivity: CGFloat = 0.006
            let factor = 1.0 + (delta * sensitivity)
            let clampedFactor = max(0.80, min(1.20, factor))
            
            let minScale = min(minScaleFactor, 0.20)
            let maxScale = max(maxScaleFactor, 10.0)
            
            let newScale = max(minScale, min(maxScale, scaleFactor * clampedFactor))
            scaleFactor = newScale
            
            gesture.setTranslation(.zero, in: self)
        }
    }
    
    // MARK: - UIGestureRecognizerDelegate
    public override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === mouseWheelZoomGesture {
            return isCommandPressed
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
    
    public override func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        if gestureRecognizer === mouseWheelZoomGesture {
            return false
        }
        return true
    }
    
    public override func didMoveToWindow() {
        super.didMoveToWindow()
        attachScrollRequirements()
    }
    
    private func attachScrollRequirements() {
        guard let pan = mouseWheelZoomGesture else { return }
        let scrollViews = findAllScrollViews(in: self)
        for sv in scrollViews {
            sv.panGestureRecognizer.require(toFail: pan)
            for g in sv.gestureRecognizers ?? [] {
                if g !== pan {
                    g.require(toFail: pan)
                }
            }
        }
        if !scrollViews.isEmpty {
            didAttachScrollRequirements = true
        }
    }
    
    private func findAllScrollViews(in view: UIView) -> [UIScrollView] {
        var result: [UIScrollView] = []
        for sub in view.subviews {
            if let sv = sub as? UIScrollView {
                result.append(sv)
            }
            result.append(contentsOf: findAllScrollViews(in: sub))
        }
        return result
    }
    
    public override func layoutSubviews() {
        super.layoutSubviews()
        if !didAttachScrollRequirements {
            attachScrollRequirements()
        }
        if isFitToWidth && bounds.width > 0 && abs(bounds.width - lastBoundsWidth) > 1 {
            lastBoundsWidth = bounds.width
            applyFitToWidth()
        }
    }
    
    public func applyFitToWidth() {
        if isFitToWidth {
            guard let page = currentPage ?? document?.page(at: 0) else { return }
            let pageRect = page.bounds(for: displayBox)
            guard pageRect.width > 0, bounds.width > 0 else { return }
            let totalWidth = isTwoPagesMode ? (pageRect.width * 2.0) : pageRect.width
            let targetScale = bounds.width / totalWidth
            autoScales = false
            minScaleFactor = min(minScaleFactor, targetScale * 0.5)
            maxScaleFactor = max(maxScaleFactor, targetScale * 3.0)
            scaleFactor = targetScale
        } else {
            autoScales = true
            lastBoundsWidth = bounds.width
        }
    }
}

public struct PDFKitView: UIViewRepresentable {
    public let documentURL: URL
    @Binding public var currentPage: Int
    public var targetPage: Int?
    public var targetRect: [Double]?
    public var isTwoPages: Bool
    public var isFitToWidth: Bool
    public var onManualZoom: (() -> Void)?
    
    public init(
        documentURL: URL,
        currentPage: Binding<Int>,
        targetPage: Int? = nil,
        targetRect: [Double]? = nil,
        isTwoPages: Bool = false,
        isFitToWidth: Bool = false,
        onManualZoom: (() -> Void)? = nil
    ) {
        self.documentURL = documentURL
        self._currentPage = currentPage
        self.targetPage = targetPage
        self.targetRect = targetRect
        self.isTwoPages = isTwoPages
        self.isFitToWidth = isFitToWidth
        self.onManualZoom = onManualZoom
    }
    
    public func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    public func makeUIView(context: Context) -> DocSeekerPDFView {
        let pdfView = DocSeekerPDFView()
        pdfView.isFitToWidth = isFitToWidth
        pdfView.isTwoPagesMode = isTwoPages
        pdfView.onManualZoom = onManualZoom
        pdfView.autoScales = !isFitToWidth
        pdfView.displayMode = isTwoPages ? .twoUpContinuous : .singlePageContinuous
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
    
    public func updateUIView(_ uiView: DocSeekerPDFView, context: Context) {
        context.coordinator.parent = self
        
        let desiredDisplayMode: PDFDisplayMode = isTwoPages ? .twoUpContinuous : .singlePageContinuous
        if uiView.displayMode != desiredDisplayMode {
            uiView.displayMode = desiredDisplayMode
        }
        
        uiView.isTwoPagesMode = isTwoPages
        uiView.onManualZoom = onManualZoom
        if uiView.isFitToWidth != isFitToWidth {
            uiView.isFitToWidth = isFitToWidth
        }
        
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
        weak var pdfView: DocSeekerPDFView?
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
            checkTimer = nil
            checkRetries = 0
            spinner?.startAnimating()
            
            if url.isFileURL {
                // 1. Document local sur disque : ouverture synchrone immédiate (quasi 0 ms)
                if let doc = PDFDocument(url: url) {
                    pdfView.document = doc
                    if doc.pageCount > 0 {
                        spinner?.stopAnimating()
                        let targetIdx = max(0, targetPage - 1)
                        if let page = doc.page(at: min(targetIdx, doc.pageCount - 1)) {
                            pdfView.go(to: page)
                        }
                        if pdfView.isFitToWidth {
                            DispatchQueue.main.async {
                                pdfView.applyFitToWidth()
                            }
                        }
                        return
                    }
                }
            } else {
                // 2. URL HTTP distante (streaming Byte-Range partiel) :
                // Initialisation ASYNCHRONE sur thread d'arrière-plan pour éviter de bloquer le Main Thread
                // pendant la négociation réseau des tables xref et headers PDFKit.
                DispatchQueue.global(qos: .userInitiated).async { [weak self, weak pdfView] in
                    let doc = PDFDocument(url: url)
                    
                    DispatchQueue.main.async {
                        guard let self = self, let pdfView = pdfView else { return }
                        if let doc = doc {
                            pdfView.document = doc
                            if doc.pageCount > 0 {
                                self.spinner?.stopAnimating()
                                let targetIdx = max(0, targetPage - 1)
                                if let page = doc.page(at: min(targetIdx, doc.pageCount - 1)) {
                                    pdfView.go(to: page)
                                }
                                if pdfView.isFitToWidth {
                                    pdfView.applyFitToWidth()
                                }
                                return
                            }
                        }
                        // Si le flux nécessite d'attendre l'arrivée progressive des pages
                        self.startIncrementalCheckTimer(targetPage: targetPage)
                    }
                }
                return
            }
            
            startIncrementalCheckTimer(targetPage: targetPage)
        }
        
        private func startIncrementalCheckTimer(targetPage: Int) {
            checkTimer?.invalidate()
            checkRetries = 0
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
                    if pdfView.isFitToWidth {
                        pdfView.applyFitToWidth()
                    }
                } else if self.checkRetries > 40 {
                    // Au bout de 6 secondes sans page, stopper le spinner
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
            if pdfView.isFitToWidth {
                DispatchQueue.main.async {
                    pdfView.applyFitToWidth()
                }
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
