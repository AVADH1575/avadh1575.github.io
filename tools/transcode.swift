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

struct Segment: Decodable { let src: String; let start: Double?; let end: Double? }
struct Spec: Decodable { let out: String; let segments: [Segment]; let maxSide: Double?; let posterAt: Double?; let posterOut: String? }

func fail(_ msg: String) -> Never { fputs(msg + "\n", stderr); exit(1) }

guard CommandLine.arguments.count == 2 else { fail("usage: transcode <spec.json>") }
let spec: Spec
do { spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) }
catch { fail("bad spec: \(error)") }
guard !spec.segments.isEmpty else { fail("no segments") }

let out = URL(fileURLWithPath: spec.out)
try? FileManager.default.removeItem(at: out)

// 1) Build a composition from the segments.
let comp = AVMutableComposition()
guard let track = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { fail("composition failed") }
var cursor = CMTime.zero
var natural = CGSize.zero
var transform = CGAffineTransform.identity
var fps: Float = 30
for (i, seg) in spec.segments.enumerated() {
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
readerOut.alwaysCopiesSampleData = false
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
    guard let sample = readerOut.copyNextSampleBuffer(), input.append(sample) else {
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
