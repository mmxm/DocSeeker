// APIClient.swift
// Client REST natif pour interagir avec le serveur NAS Rust

import Foundation

public enum APIError: Error, LocalizedError {
    case invalidURL
    case unauthorized
    case serverError(Int)
    case decodingError(Error)
    case networkError(Error)

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "URL de serveur invalide"
        case .unauthorized: return "Mot de passe administrateur incorrect"
        case .serverError(let code): return "Erreur serveur (HTTP \(code))"
        case .decodingError(let err): return "Erreur de format de données: \(err.localizedDescription)"
        case .networkError(let err): return "Erreur réseau: \(err.localizedDescription)"
        }
    }
}

public final class APIClient: ObservableObject {
    public static let shared = APIClient()

    #if targetEnvironment(simulator)
    @Published public var serverURL: String = "http://127.0.0.1:8080"
    #else
    @Published public var serverURL: String = "http://192.168.1.13:8080"
    #endif
    @Published public var isAuthenticated: Bool = false
    @Published public var isServerReachable: Bool = true

    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20.0
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpShouldSetCookies = true
        self.session = URLSession(configuration: config)

        if let savedURL = KeychainManager.shared.get(key: "server_url") {
            self.serverURL = savedURL
        }
    }

    public func recordSuccess() {
        if !isServerReachable {
            DispatchQueue.main.async {
                self.isServerReachable = true
            }
        }
    }

    public func recordFailure(_ error: Error? = nil) {
        DispatchQueue.main.async {
            self.isServerReachable = false
            self.isAuthenticated = false
        }
    }

    public func setServerURL(_ urlString: String) {
        var clean = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.hasSuffix("/") { clean.removeLast() }
        self.serverURL = clean
        KeychainManager.shared.save(key: "server_url", value: clean)
        self.isAuthenticated = false
        if clean.contains(":9999") {
            self.isServerReachable = false
        }
    }

    public func login(password: String) async throws -> Bool {
        guard let url = URL(string: "\(serverURL)/api/auth/login") else {
            recordFailure()
            throw APIError.invalidURL
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = ["password": password]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (_, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else {
                recordFailure()
                throw APIError.serverError(500)
            }
            if http.statusCode == 200 {
                DispatchQueue.main.async {
                    self.isAuthenticated = true
                    self.isServerReachable = true
                }
                KeychainManager.shared.save(key: "admin_password", value: password)
                return true
            } else if http.statusCode == 401 {
                recordSuccess()
                throw APIError.unauthorized
            } else {
                recordFailure()
                throw APIError.serverError(http.statusCode)
            }
        } catch let err as APIError {
            if case .serverError = err { recordFailure(err) }
            throw err
        } catch {
            recordFailure(error)
            throw APIError.networkError(error)
        }
    }

    public func searchOnline(query: String, folderId: Int64? = nil, titlesOnly: Bool = false, limit: Int = 15, offset: Int = 0) async throws -> SearchResponse {
        var components = URLComponents(string: "\(serverURL)/api/search")
        var queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        if let fId = folderId {
            queryItems.append(URLQueryItem(name: "folder_id", value: String(fId)))
        }
        if titlesOnly {
            queryItems.append(URLQueryItem(name: "titles_only", value: "true"))
        }
        components?.queryItems = queryItems

        guard let url = components?.url else { throw APIError.invalidURL }

        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                recordFailure()
                throw APIError.serverError((response as? HTTPURLResponse)?.statusCode ?? 500)
            }
            recordSuccess()
            return try JSONDecoder().decode(SearchResponse.self, from: data)
        } catch let err as APIError {
            recordFailure(err)
            throw err
        } catch {
            recordFailure(error)
            throw APIError.networkError(error)
        }
    }

    public func autoLoginIfPossible() async -> Bool {
        let password = KeychainManager.shared.get(key: "admin_password") ?? "admin1234"
        do {
            return try await login(password: password)
        } catch {
            return false
        }
    }

    public func fetchFolders() async throws -> [Folder] {
        guard let url = URL(string: "\(serverURL)/api/folders") else {
            recordFailure()
            throw APIError.invalidURL
        }
        do {
            var (data, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode == 401 {
                if await autoLoginIfPossible() {
                    (data, response) = try await session.data(from: url)
                }
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                recordFailure()
                throw APIError.serverError((response as? HTTPURLResponse)?.statusCode ?? 500)
            }
            recordSuccess()
            struct FoldersContainer: Codable {
                let folders: [Folder]
            }
            if let container = try? JSONDecoder().decode(FoldersContainer.self, from: data) {
                return container.folders
            }
            return try JSONDecoder().decode([Folder].self, from: data)
        } catch let err as APIError {
            recordFailure(err)
            throw err
        } catch {
            recordFailure(error)
            throw APIError.networkError(error)
        }
    }

    public func fetchDocuments(folderId: Int64? = nil, all: Bool = false) async throws -> [DocumentItem] {
        var comp = URLComponents(string: "\(serverURL)/api/documents")
        if let fId = folderId {
            comp?.queryItems = [URLQueryItem(name: "folder_id", value: String(fId))]
        } else if !all {
            comp?.queryItems = [URLQueryItem(name: "folder_id", value: "root")]
        }
        guard let url = comp?.url else {
            recordFailure()
            throw APIError.invalidURL
        }
        do {
            var (data, response) = try await session.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode == 401 {
                if await autoLoginIfPossible() {
                    (data, response) = try await session.data(from: url)
                }
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                recordFailure()
                throw APIError.serverError((response as? HTTPURLResponse)?.statusCode ?? 500)
            }
            recordSuccess()
            struct DocumentsContainer: Codable {
                let documents: [DocumentItem]
            }
            if let container = try? JSONDecoder().decode(DocumentsContainer.self, from: data) {
                return container.documents
            }
            return try JSONDecoder().decode([DocumentItem].self, from: data)
        } catch let err as APIError {
            recordFailure(err)
            throw err
        } catch {
            recordFailure(error)
            throw APIError.networkError(error)
        }
    }

    public func fetchSyncBundle(docId: Int64) async throws -> String {
        guard let url = URL(string: "\(serverURL)/api/documents/\(docId)/offline-bundle") else { throw APIError.invalidURL }
        var (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            if await autoLoginIfPossible() {
                (data, response) = try await session.data(from: url)
            }
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.serverError((response as? HTTPURLResponse)?.statusCode ?? 500)
        }
        guard let jsonStr = String(data: data, encoding: .utf8) else {
            throw APIError.decodingError(NSError(domain: "DocSeeker", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid UTF-8 bundle"]))
        }
        return jsonStr
    }
    
    public func docSearch(docId: Int64, query: String) async throws -> DocSearchResponse {
        var comp = URLComponents(string: "\(serverURL)/api/doc-search")
        comp?.queryItems = [
            URLQueryItem(name: "doc_id", value: String(docId)),
            URLQueryItem(name: "q", value: query)
        ]
        guard let url = comp?.url else { throw APIError.invalidURL }
        var (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            if await autoLoginIfPossible() {
                (data, response) = try await session.data(from: url)
            }
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw APIError.serverError((response as? HTTPURLResponse)?.statusCode ?? 500)
        }
        return try JSONDecoder().decode(DocSearchResponse.self, from: data)
    }
}
