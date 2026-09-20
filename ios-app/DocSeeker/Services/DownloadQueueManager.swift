// DownloadQueueManager.swift
// File d'attente native pour le téléchargement et la synchronisation hors-ligne avec gestion de reprise réseau

import Foundation
import Combine
import PDFKit

public struct DownloadTaskState {
    public let docId: Int64
    public var progress: Double
    public var isPaused: Bool
    public var task: URLSessionDownloadTask?
    public var resumeData: Data?
}

public final class DownloadQueueManager: NSObject, ObservableObject, URLSessionDownloadDelegate {
    public static let shared = DownloadQueueManager()

    @Published public var activeTasks: [Int64: Double] = [:] // docId -> progress 0.0...1.0
    @Published public var interruptedTasks: [Int64: Double] = [:] // docId -> last known progress
    @Published public var queuedDocIds: [Int64] = []
    @Published public var isPaused: Bool = false

    private var session: URLSession!
    private var taskMap: [Int: Int64] = [:] // taskIdentifier -> docId
    private var resumeDataMap: [Int64: Data] = [:]
    private let mapLock = NSLock() // CR-2 : protection des accès concurrents à taskMap et resumeDataMap
    private var lastProgressUpdate: [Int64: (time: CFAbsoluteTime, pct: Double)] = [:]
    private let maxConcurrent = 2
    private var runningCount = 0
    private var cancellables = Set<AnyCancellable>()

    private override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60.0
        config.httpCookieStorage = HTTPCookieStorage.shared
        self.session = URLSession(configuration: config, delegate: self, delegateQueue: nil)

        // Surveillance automatique de la restauration réseau pour reprise transparente
        NetworkMonitor.shared.$isOnline
            .sink { [weak self] isOnline in
                if isOnline {
                    self?.resumeInterruptedTasks()
                } else {
                    self?.pauseAllForNetworkInterruption()
                }
            }
            .store(in: &cancellables)
    }

    public func enqueue(docId: Int64) {
        guard !LocalDatabase.shared.isDocumentCached(docId: docId) else { return }
        guard !activeTasks.keys.contains(docId) && !queuedDocIds.contains(docId) else { return }

        DispatchQueue.main.async {
            self.queuedDocIds.append(docId)
            self.processQueue()
        }
    }

    public func enqueueFolder(docs: [DocumentItem]) {
        for doc in docs {
            enqueue(docId: doc.id)
        }
    }

    public func pauseDownload(docId: Int64) {
        for (taskId, id) in taskMap where id == docId {
            session.getAllTasks { tasks in
                if let t = tasks.first(where: { $0.taskIdentifier == taskId }) as? URLSessionDownloadTask {
                    t.cancel { [weak self] data in
                        if let d = data {
                            self?.resumeDataMap[docId] = d
                        }
                    }
                }
            }
        }
        DispatchQueue.main.async {
            let prog = self.activeTasks.removeValue(forKey: docId) ?? 0.0
            self.interruptedTasks[docId] = prog
            self.runningCount = max(0, self.runningCount - 1)
            self.processQueue()
        }
    }

    public func resumeDownload(docId: Int64) {
        DispatchQueue.main.async {
            self.interruptedTasks.removeValue(forKey: docId)
            if !self.queuedDocIds.contains(docId) && !self.activeTasks.keys.contains(docId) {
                self.queuedDocIds.insert(docId, at: 0)
                self.processQueue()
            }
        }
    }

    public func cancelDownload(docId: Int64) {
        pauseDownload(docId: docId)
        resumeDataMap.removeValue(forKey: docId)
        DispatchQueue.main.async {
            self.queuedDocIds.removeAll(where: { $0 == docId })
            self.interruptedTasks.removeValue(forKey: docId)
        }
    }

    /// Annule et stoppe immédiatement la synchronisation de tous les documents d'un dossier
    public func cancelFolderDownload(docIds: [Int64]) {
        for docId in docIds {
            cancelDownload(docId: docId)
        }
    }

    /// Annule l'ensemble des téléchargements et vide toutes les files d'attente (changement de serveur ou purge cache)
    public func cancelAll() {
        session.getAllTasks { [weak self] tasks in
            guard let self = self else { return }
            for task in tasks {
                task.cancel()
            }
            self.mapLock.lock()
            self.taskMap.removeAll()
            self.resumeDataMap.removeAll()
            self.mapLock.unlock()
            DispatchQueue.main.async {
                self.activeTasks.removeAll()
                self.queuedDocIds.removeAll()
                self.interruptedTasks.removeAll()
                self.runningCount = 0
            }
        }
    }

    public func isDownloading(docId: Int64) -> Bool {
        activeTasks.keys.contains(docId) || queuedDocIds.contains(docId)
    }

    public func folderSyncProgress(docIds: [Int64]) -> (isSyncing: Bool, activeCount: Int) {
        let active = docIds.filter { isDownloading(docId: $0) }
        return (!active.isEmpty, active.count)
    }

    /// Mise en pause de secours lors d'une coupure réseau avec capture des données de reprise
    public func pauseAllForNetworkInterruption() {
        session.getAllTasks { [weak self] tasks in
            guard let self = self else { return }
            for task in tasks {
                guard let downloadTask = task as? URLSessionDownloadTask,
                      let docId = self.taskMap[downloadTask.taskIdentifier] else { continue }
                downloadTask.cancel { [weak self] data in
                    if let d = data {
                        self?.resumeDataMap[docId] = d
                    }
                }
            }
        }
        DispatchQueue.main.async {
            for (id, prog) in self.activeTasks {
                self.interruptedTasks[id] = prog
            }
            self.activeTasks.removeAll()
            self.runningCount = 0
        }
    }

    /// Reprise automatique de tous les téléchargements interrompus dès le retour du réseau
    public func resumeInterruptedTasks() {
        DispatchQueue.main.async {
            guard !self.interruptedTasks.isEmpty else { return }
            for (docId, _) in self.interruptedTasks {
                if !self.queuedDocIds.contains(docId) && !self.activeTasks.keys.contains(docId) {
                    self.queuedDocIds.append(docId)
                }
            }
            self.interruptedTasks.removeAll()
            self.processQueue()
        }
    }

    public func getResumeData(for docId: Int64) -> Data? {
        return resumeDataMap[docId]
    }

    public func setResumeData(for docId: Int64, data: Data) {
        resumeDataMap[docId] = data
    }

    private func processQueue() {
        guard !isPaused && NetworkMonitor.shared.isConnected else { return }
        while runningCount < maxConcurrent && !queuedDocIds.isEmpty {
            let nextDocId = queuedDocIds.removeFirst()
            startDownload(docId: nextDocId)
        }
    }

    private func startDownload(docId: Int64) {
        runningCount += 1
        DispatchQueue.main.async {
            self.activeTasks[docId] = 0.05
        }
        
        Task {
            // AM-4 : Vérification de l'espace disque disponible avant de lancer le téléchargement
            if let fileSize = await self.estimatedFileSize(docId: docId) {
                let freeSpace = self.availableDiskSpace()
                if freeSpace > 0 && freeSpace < fileSize * 2 {
                    print("[DownloadManager] Espace disque insuffisant pour doc \(docId): \(freeSpace) octets disponibles, \(fileSize * 2) requis")
                    self.finishTask(docId: docId, success: false)
                    return
                }
            }
            
            // 1. Télécharger d'abord le bundle d'indexation de façon STRICTE et ATOMIQUE
            do {
                let bundleJson = try await APIClient.shared.fetchSyncBundle(docId: docId)
                let inserted = RustBridge.shared.insertBundle(json: bundleJson, at: LocalDatabase.shared.dbURL)
                guard inserted else {
                    print("[DownloadManager] Échec critique insertion SQLite pour le bundle \(docId)")
                    self.finishTask(docId: docId, success: false)
                    return
                }
            } catch {
                print("[DownloadManager] Interruption réseau sur le bundle \(docId): \(error)")
                DispatchQueue.main.async {
                    self.interruptedTasks[docId] = self.activeTasks.removeValue(forKey: docId) ?? 0.0
                    self.runningCount = max(0, self.runningCount - 1)
                }
                return
            }

            // 2. Télécharger le fichier PDF avec reprise si disponible
            // AM-7 : Utiliser le header Authorization au lieu de l'URL query string
            let serverURL = APIClient.shared.serverURL
            guard let pdfURL = URL(string: "\(serverURL)/api/pdf/\(docId)") else {
                self.finishTask(docId: docId, success: false)
                return
            }

            var req = APIClient.shared.authorizedRequest(for: pdfURL)
            // Ajouter également les cookies de session (compatibilité avec les deux méthodes d'auth)
            if let cookies = HTTPCookieStorage.shared.cookies(for: pdfURL) {
                let headers = HTTPCookie.requestHeaderFields(with: cookies)
                for (k, v) in headers {
                    req.setValue(v, forHTTPHeaderField: k)
                }
            }

            let task: URLSessionDownloadTask
            self.mapLock.lock()
            let hasResumeData = self.resumeDataMap[docId] != nil
            let resumeData = hasResumeData ? self.resumeDataMap.removeValue(forKey: docId) : nil
            self.mapLock.unlock()
            
            if let resumeData = resumeData,
               (try? PropertyListSerialization.propertyList(from: resumeData, options: [], format: nil)) is [String: Any] {
                print("[DownloadManager] Reprise du téléchargement pour doc \(docId) avec resumeData (\(resumeData.count) octets)")
                task = self.session.downloadTask(withResumeData: resumeData)
            } else {
                task = self.session.downloadTask(with: req)
            }

            self.mapLock.lock()
            self.taskMap[task.taskIdentifier] = docId
            self.mapLock.unlock()
            task.resume()
        }
    }

    private func finishTask(docId: Int64, success: Bool) {
        lastProgressUpdate.removeValue(forKey: docId)
        DispatchQueue.main.async {
            if success {
                LocalDatabase.shared.refreshCachedDocs()
            }
            self.activeTasks.removeValue(forKey: docId)
            self.runningCount = max(0, self.runningCount - 1)
            self.processQueue()
        }
    }

    // MARK: - URLSessionDownloadDelegate

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        mapLock.lock()
        let docId = taskMap.removeValue(forKey: downloadTask.taskIdentifier)
        mapLock.unlock()
        guard let docId = docId else { return }
        let target = LocalDatabase.shared.localPdfURL(for: docId)

        // Validation d'intégrité PDF avant enregistrement
        if let pdfDoc = PDFDocument(url: location), pdfDoc.pageCount > 0 {
            let fileManager = FileManager.default
            try? fileManager.removeItem(at: target)
            do {
                try fileManager.moveItem(at: location, to: target)
                print("[DownloadManager] PDF \(docId) validé et enregistré (\(pdfDoc.pageCount) pages)")
                finishTask(docId: docId, success: true)
                return
            } catch {
                print("[DownloadManager] Erreur déplacement PDF: \(error)")
            }
        } else {
            print("[DownloadManager] PDF téléchargé corrompu ou invalide pour le doc \(docId)")
        }
        finishTask(docId: docId, success: false)
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        mapLock.lock()
        let docId = taskMap[downloadTask.taskIdentifier]
        mapLock.unlock()
        guard let docId = docId, totalBytesExpectedToWrite > 0 else { return }
        let pct = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)

        let now = CFAbsoluteTimeGetCurrent()
        if let last = lastProgressUpdate[docId] {
            // Throttling : au moins 100ms écoulées ET delta >= 0.03, sauf fin de téléchargement (>= 0.99)
            if (now - last.time < 0.1) && (pct - last.pct < 0.03) && (pct < 0.99) {
                return
            }
        }
        lastProgressUpdate[docId] = (time: now, pct: pct)

        DispatchQueue.main.async {
            self.activeTasks[docId] = pct
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        mapLock.lock()
        let docId = taskMap.removeValue(forKey: task.taskIdentifier)
        mapLock.unlock()
        guard let docId = docId else { return }
        
        if let error = error as NSError? {
            // Capture automatique de resumeData lors d'une interruption réseau ou timeout
            if let resumeData = error.userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
                print("[DownloadManager] Interruption réseau pour doc \(docId) - resumeData capturé (\(resumeData.count) octets)")
                mapLock.lock()
                self.resumeDataMap[docId] = resumeData
                mapLock.unlock()
            }
            DispatchQueue.main.async {
                self.interruptedTasks[docId] = self.activeTasks.removeValue(forKey: docId) ?? 0.0
                self.runningCount = max(0, self.runningCount - 1)
            }
        }
    }

    // MARK: - Helpers AM-4 (vérification espace disque)

    /// Estime la taille du fichier PDF à télécharger via les métadonnées SQLite locales
    private func estimatedFileSize(docId: Int64) async -> Int64? {
        let docs = LocalDatabase.shared.getLocalDocuments(folderId: nil)
        if let doc = docs.first(where: { $0.id == docId }), let size = doc.file_size {
            return size
        }
        return nil
    }

    /// Retourne l'espace disque disponible en octets (0 si non déterminable)
    private func availableDiskSpace() -> Int64 {
        let fm = FileManager.default
        if let attrs = try? fm.attributesOfFileSystem(forPath: NSHomeDirectory()),
           let freeSize = attrs[.systemFreeSize] as? Int64 {
            return freeSize
        }
        return 0
    }
}
