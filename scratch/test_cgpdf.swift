import Foundation
import CoreGraphics
import PDFKit

let url = URL(fileURLWithPath: "data/documents/Endocrinologie 6E 2024.pdf")
guard let doc = CGPDFDocument(url as CFURL) else {
    print("Cannot open doc")
    exit(1)
}
print("Pages:", doc.numberOfPages)
if let page = doc.page(at: 491) {
    let mb = page.getBoxRect(.mediaBox)
    let cb = page.getBoxRect(.cropBox)
    print("Page 491 - MediaBox: \(mb), CropBox: \(cb)")
}
