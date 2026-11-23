// Web video encoder for the portfolio (macOS AVFoundation, no ffmpeg needed).
// Joins one or more segments (from one or more source files) into a single H.264 MP4:
// fast start, longest side <= maxSide, bitrate scaled to frame size, NO audio, no metadata.
// Optionally saves a poster frame (PNG) at a given time of the output.
//
// usage: transcode <spec.json>
//   { "out": "/path/out.mp4", "maxSide": 1280,
//     "segments": [ { "src": "/path/a.mp4", "start": 2.5, "end": 12 }, ... ],
//     "posterAt": 7.5, "posterOut": "/path/poster.png" }
// prints: { "w": 592, "h": 1280, "duration": 22.0 }
import AVFoundation
import AppKit

// Masks hide private details (e.g. an address in an app header). Coordinates are fractions (0–1)
// of the source frame; the fill colour is sampled per frame at (sx, sy) so it blends in.
//   "masks": [ { "x": 0.03, "y": 0.105, "w": 0.35, "h": 0.021, "sx": 0.405, "sy": 0.115 } ]
// Image mode (same masks): { "imageIn": "/a.png", "imageOut": "/b.png", "masks": [...] }
struct Segment: Decodable { let src: String; let start: Double?; let end: Double? }
struct Mask: Decodable { let x: Double; let y: Double; let w: Double; let h: Double; let sx: Double; let sy: Double }
struct Spec: Decodable {
  let out: String?; let segments: [Segment]?; let maxSide: Double?; let posterAt: Double?; let posterOut: String?
  let masks: [Mask]?; let imageIn: String?; let imageOut: String?
}

func fail(_ msg: String) -> Never { fputs(msg + "\n", stderr); exit(1) }

guard CommandLine.arguments.count == 2 else { fail("usage: transcode <spec.json>") }
let spec: Spec
do { spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) }
catch { fail("bad spec: \(error)") }
let masks = spec.masks ?? []

// Image mode: apply masks to a still image and exit.
if let imageIn = spec.imageIn, let imageOut = spec.imageOut {
  guard let src = NSImage(contentsOfFile: imageIn)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail("cannot read \(imageIn)") }
  let W = src.width, H = src.height
  guard let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("context") }
  ctx.draw(src, in: CGRect(x: 0, y: 0, width: W, height: H))
  let px = ctx.data!.assumingMemoryBound(to: UInt8.self)
  for m in masks {
    // Bitmap rows run top-down in memory; CoreGraphics drawing is bottom-up.
    let sx = min(W - 1, Int(m.sx * Double(W))), sy = min(H - 1, Int(m.sy * Double(H)))
    let o = sy * W * 4 + sx * 4
    ctx.setFillColor(red: CGFloat(px[o]) / 255, green: CGFloat(px[o + 1]) / 255, blue: CGFloat(px[o + 2]) / 255, alpha: 1)
    let r = CGRect(x: m.x * Double(W), y: Double(H) - (m.y + m.h) * Double(H), width: m.w * Double(W), height: m.h * Double(H))
    ctx.fill(r)
  }
  guard let outImg = ctx.makeImage(), let png = NSBitmapImageRep(cgImage: outImg).representation(using: .png, properties: [:]) else { fail("encode image") }
  do { try png.write(to: URL(fileURLWithPath: imageOut)) } catch { fail("write \(imageOut): \(error)") }
  print("{\"w\": \(W), \"h\": \(H)}")
  exit(0)
}

guard let outPath = spec.out, let segmentsList = spec.segments, !segmentsList.isEmpty else { fail("no segments") }

// Fill mask rectangles in a 4:2:0 bi-planar pixel buffer with the colour sampled at (sx, sy).
func applyMasks(_ buffer: CVPixelBuffer) {
  if masks.isEmpty { return }
  CVPixelBufferLockBaseAddress(buffer, [])
  defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
  guard CVPixelBufferGetPlaneCount(buffer) >= 2,
        let yBase = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)?.assumingMemoryBound(to: UInt8.self),
        let cBase = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)?.assumingMemoryBound(to: UInt8.self) else { return }
  let W = CVPixelBufferGetWidthOfPlane(buffer, 0), H = CVPixelBufferGetHeightOfPlane(buffer, 0)
  let yStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0), cStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
  for m in masks {
    let sx = min(W - 1, Int(m.sx * Double(W))), sy = min(H - 1, Int(m.sy * Double(H)))
    let yVal = yBase[sy * yStride + sx]
    let cb = cBase[(sy / 2) * cStride + (sx / 2) * 2], cr = cBase[(sy / 2) * cStride + (sx / 2) * 2 + 1]
    let x0 = max(0, Int(m.x * Double(W))), x1 = min(W, Int((m.x + m.w) * Double(W)))
    let y0 = max(0, Int(m.y * Double(H))), y1 = min(H, Int((m.y + m.h) * Double(H)))
    for row in y0..<y1 { memset(yBase + row * yStride + x0, Int32(yVal), x1 - x0) }
    for row in (y0 / 2)..<((y1 + 1) / 2) {
      var col = x0 / 2
      while col < (x1 + 1) / 2 { cBase[row * cStride + col * 2] = cb; cBase[row * cStride + col * 2 + 1] = cr; col += 1 }
    }
  }
}

let out = URL(fileURLWithPath: outPath)
try? FileManager.default.removeItem(at: out)

// 1) Build a composition from the segments.
let comp = AVMutableComposition()
guard let track = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { fail("composition failed") }
var cursor = CMTime.zero
var natural = CGSize.zero
var transform = CGAffineTransform.identity
var fps: Float = 30
for (i, seg) in segmentsList.enumerated() {
  let asset = AVURLAsset(url: URL(fileURLWithPath: seg.src))
  guard let src = asset.tracks(withMediaType: .video).first else { fail("no video track in \(seg.src)") }
  if i == 0 { natural = src.naturalSize; transform = src.preferredTransform; fps = src.nominalFrameRate }
  else if src.naturalSize != natural { fputs("warning: segment \(i) has a different frame size\n", stderr) }
  let total = CMTimeGetSeconds(asset.duration)
  let start = max(0, seg.start ?? 0), end = min(seg.end ?? total, total)
  guard end > start else { fail("segment \(i) is empty (\(start)-\(end))") }
  let range = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600), end: CMTime(seconds: end, preferredTimescale: 600))
  do { try track.insertTimeRange(range, of: src, at: cursor) } catch { fail("insert failed: \(error)") }
  cursor = CMTimeAdd(cursor, range.duration)
}
track.preferredTransform = transform

// 2) Encode.
let reader: AVAssetReader
do { reader = try AVAssetReader(asset: comp) } catch { fail("reader: \(error)") }
let readerOut = AVAssetReaderTrackOutput(track: track, outputSettings: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
readerOut.alwaysCopiesSampleData = !masks.isEmpty  // masks write into the decoded frames
reader.add(readerOut)

let maxSide = spec.maxSide ?? 1280
let scale = min(1.0, maxSide / Double(max(natural.width, natural.height)))
func even(_ x: Double) -> Int { let v = Int(x.rounded()); return max(2, v - v % 2) }
let w = even(Double(natural.width) * scale), h = even(Double(natural.height) * scale)
let rate = Double(fps > 0 ? fps : 30)
let bitrate = Int(min(2_000_000, max(800_000, Double(w * h) * min(rate, 30) * 0.07)))

let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: out, fileType: .mp4) } catch { fail("writer: \(error)") }
writer.shouldOptimizeForNetworkUse = true
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: w, AVVideoHeightKey: h,
  AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: bitrate,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: 60,
  ],
])
input.transform = transform
input.expectsMediaDataInRealTime = false
writer.add(input)

guard reader.startReading() else { fail("read failed: \(String(describing: reader.error))") }
writer.startWriting()
writer.startSession(atSourceTime: .zero)
let done = DispatchSemaphore(value: 0)
input.requestMediaDataWhenReady(on: DispatchQueue(label: "encode")) {
  while input.isReadyForMoreMediaData {
    guard let sample = readerOut.copyNextSampleBuffer() else { input.markAsFinished(); done.signal(); return }
    if let pb = CMSampleBufferGetImageBuffer(sample) { applyMasks(pb) }
    guard input.append(sample) else {
      input.markAsFinished(); done.signal(); return
    }
  }
}
done.wait()
writer.endSession(atSourceTime: cursor)
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
if writer.status != .completed || reader.status == .failed {
  fail("encode failed: \(String(describing: writer.error ?? reader.error))")
}

// 3) Poster frame from the finished file.
if let posterOut = spec.posterOut {
  let asset = AVURLAsset(url: out)
  let gen = AVAssetImageGenerator(asset: asset)
  gen.appliesPreferredTrackTransform = true
  gen.requestedTimeToleranceBefore = CMTime(seconds: 0.2, preferredTimescale: 600)
  gen.requestedTimeToleranceAfter = CMTime(seconds: 0.2, preferredTimescale: 600)
  let at = min(max(0, spec.posterAt ?? 0.5), max(0, CMTimeGetSeconds(cursor) - 0.2))
  if let cg = try? gen.copyCGImage(at: CMTime(seconds: at, preferredTimescale: 600), actualTime: nil),
     let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) {
    try? png.write(to: URL(fileURLWithPath: posterOut))
  }
}
print("{\"w\": \(w), \"h\": \(h), \"duration\": \(String(format: "%.2f", CMTimeGetSeconds(cursor)))}")
