// NetworkMonitor.swift
// Surveillance native de la connectivité réseau avec NWPathMonitor

import Foundation
import Network
import Combine

public final class NetworkMonitor: ObservableObject {
    public static let shared = NetworkMonitor()

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.docseeker.networkmonitor")

    @Published public var isOnline: Bool = true
    @Published public var isExpensive: Bool = false

    public var isConnected: Bool {
        isOnline
    }

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                self?.isOnline = (path.status == .satisfied)
                self?.isExpensive = path.isExpensive
            }
        }
        monitor.start(queue: queue)
    }
}
