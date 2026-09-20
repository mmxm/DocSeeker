import Foundation
import PDFKit

let urlString = "http://127.0.0.1:8080/api/pdf/551?token=1767c6ff26f025bc448b54c0171b19e76306030970b0fb1fe767731b534515c7"
guard let url = URL(string: urlString) else {
    print("Invalid URL")
    exit(1)
}

print("Instantiating PDFDocument with remote URL: \(url)")
let start = Date()
if let doc = PDFDocument(url: url) {
    print("PDFDocument created in \(Date().timeIntervalSince(start))s")
    print("Initial pageCount: \(doc.pageCount)")
    print("IsLocked: \(doc.isLocked)")
    print("MajorVersion: \(doc.majorVersion)")
    
    // Attendre quelques secondes pour voir si pageCount augmente de manière asynchrone
    for i in 1...10 {
        Thread.sleep(forTimeInterval: 0.5)
        print("At \(Double(i)*0.5)s -> pageCount: \(doc.pageCount)")
        if doc.pageCount > 0 {
            print("First page available: \(doc.page(at: 0) != nil)")
            break
        }
    }
} else {
    print("PDFDocument(url:) returned nil!")
}
