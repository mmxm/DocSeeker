import Foundation
import CoreGraphics
import ImageIO

let token = "1767c6ff26f025bc448b54c0171b19e76306030970b0fb1fe767731b534515c7"
let urlStr = "http://127.0.0.1:8080/api/crop/558/490/6?h=d8a2a900&terms=diabete&token=\(token)"

guard let url = URL(string: urlStr) else {
    print("Invalid URL")
    exit(1)
}

let semaphore = DispatchSemaphore(value: 0)

var request = URLRequest(url: url)
URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }
    if let error = error {
        print("Error:", error)
        return
    }
    guard let http = response as? HTTPURLResponse else {
        print("Not HTTP response")
        return
    }
    print("HTTP Status:", http.statusCode)
    print("Content-Type:", http.allHeaderFields["content-type"] ?? "")
    print("Data size:", data?.count ?? 0)
    
    if let data = data {
        if let source = CGImageSourceCreateWithData(data as CFData, nil) {
            let count = CGImageSourceGetCount(source)
            print("CGImageSource count:", count)
            if let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) {
                print("Decoded CGImage width:", cgImage.width, "height:", cgImage.height)
            } else {
                print("Failed to create CGImage from data (WebP format issue?)")
            }
        } else {
            print("Failed to create CGImageSource from data")
        }
    }
}.resume()

semaphore.wait()
