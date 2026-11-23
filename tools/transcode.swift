// Web video encoder for the portfolio (macOS AVFoundation, no ffmpeg needed).
// - H.264 MP4, fast start, longest side <= maxSide, bitrate scaled to the frame size
// - Optional clip: start / duration in seconds
// - Drops audio (UI demos; avoids publishing background conversations) and all metadata
//
// usage: transcode <src> <out> [start] [duration] [maxSide]
import AVFoundation

let args = CommandLine.arguments
guard args.count >= 3 else { fputs("usage: transcode <src> <out> [start] [duration] [maxSide]\n", stderr); exit(2) }
let src = URL(fileURLWithPath: args[1]), out = URL(fileURLWithPath: args[2])
let start = args.count > 3 ? Double(args[3]) ?? 0 : 0
let wanted = args.count > 4 ? Double(args[4]) ?? -1 : -1
let maxSide = args.count > 5 ? Double(args[5]) ?? 1280 : 1280
try? FileManager.default.removeItem(at: out)

let asset = AVURLAsset(url: src)
guard let track = asset.tracks(withMediaType: .video).first else { fputs("no video track\n", stderr); exit(1) }
let total = CMTimeGetSeconds(asset.duration)
let length = wanted > 0 ? min(wanted, total - start) : total - start
guard length > 0 else { fputs("clip is outside the video\n", stderr); exit(1) }

let reader = try AVAssetReader(asset: asset)
reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600),
                               duration: CMTime(seconds: length, preferredTimescale: 600))
let readerOut = AVAssetReaderTrackOutput(track: track, outputSettings: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
readerOut.alwaysCopiesSampleData = false
reader.add(readerOut)

let natural = track.naturalSize
let scale = min(1.0, maxSide / Double(max(natural.width, natural.height)))
func even(_ x: Double) -> Int { let v = Int(x.rounded()); return max(2, v - v % 2) }
let w = even(Double(natural.width) * scale), h = even(Double(natural.height) * scale)
let fps = Double(track.nominalFrameRate > 0 ? track.nominalFrameRate : 30)
let bitrate = Int(min(2_000_000, max(800_000, Double(w * h) * min(fps, 30) * 0.07)))

let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
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
input.transform = track.preferredTransform
input.expectsMediaDataInRealTime = false
writer.add(input)

guard reader.startReading() else { fputs("read failed: \(String(describing: reader.error))\n", stderr); exit(1) }
writer.startWriting()
writer.startSession(atSourceTime: reader.timeRange.start)

let done = DispatchSemaphore(value: 0)
input.requestMediaDataWhenReady(on: DispatchQueue(label: "encode")) {
  while input.isReadyForMoreMediaData {
    guard let sample = readerOut.copyNextSampleBuffer(), input.append(sample) else {
      input.markAsFinished(); done.signal(); return
    }
  }
}
done.wait()
writer.endSession(atSourceTime: CMTimeAdd(reader.timeRange.start, reader.timeRange.duration))
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
if writer.status != .completed || reader.status == .failed {
  fputs("encode failed: \(String(describing: writer.error ?? reader.error))\n", stderr); exit(1)
}
print("\(w)x\(h) \(String(format: "%.1f", length))s \(bitrate / 1000) kbps")
