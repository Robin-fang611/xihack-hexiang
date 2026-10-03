import Foundation
import Vision
import ImageIO

guard CommandLine.arguments.count == 2,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fputs("无法读取图片\n", stderr)
    exit(1)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    let result: [String: Any] = ["text": lines.joined(separator: "\n"), "status": lines.isEmpty ? "no_text" : "recognized"]
    let data = try JSONSerialization.data(withJSONObject: result)
    print(String(data: data, encoding: .utf8)!)
} catch {
    fputs("图片文字识别失败\n", stderr)
    exit(2)
}
