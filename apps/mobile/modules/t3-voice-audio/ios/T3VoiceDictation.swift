import AVFoundation
import Speech
import os

private let logger = Logger(subsystem: "T3VoiceAudio", category: "dictation")

/// The voice agent's sound cues, as Float32 mono buffers in `format`. Each is a few soft bell
/// tones; the ones that repeat or come often are short and quiet.
enum Chime: String {
  /// Dictation starts (rising) and ends (falling).
  case start, end
  /// A tool call that finished at once.
  case tool
  /// A slower tool call starts and ends.
  case toolStart = "tool-start", toolEnd = "tool-end"
  /// Every second or two while the agent works: a tool is running, or it is thinking.
  case working
  /// The connection dropped and is reconnecting, and is back.
  case connectionLost = "connection-lost", connectionBack = "connection-back"
  /// The session stopped on an error.
  case error

  private struct Shape {
    let notes: [Double]
    let step: Double
    let noteLength: Double
    let decay: Double
    let peak: Float
  }

  private var shape: Shape {
    switch self {
    case .start: return Shape(notes: [1_046.5, 1_568.0], step: 0.12, noteLength: 0.17, decay: 0.07, peak: 0.28)
    case .end: return Shape(notes: [1_568.0, 1_046.5], step: 0.12, noteLength: 0.17, decay: 0.07, peak: 0.28)
    case .tool: return Shape(notes: [1_760.0], step: 0, noteLength: 0.05, decay: 0.02, peak: 0.12)
    case .toolStart:
      return Shape(notes: [1_318.5, 1_760.0], step: 0.07, noteLength: 0.07, decay: 0.03, peak: 0.13)
    case .toolEnd:
      return Shape(notes: [1_760.0, 1_318.5], step: 0.07, noteLength: 0.07, decay: 0.03, peak: 0.13)
    case .working: return Shape(notes: [523.3], step: 0, noteLength: 0.12, decay: 0.05, peak: 0.09)
    case .connectionLost:
      return Shape(notes: [659.3, 440.0], step: 0.18, noteLength: 0.26, decay: 0.12, peak: 0.26)
    case .connectionBack:
      return Shape(notes: [440.0, 659.3, 880.0], step: 0.1, noteLength: 0.16, decay: 0.07, peak: 0.22)
    case .error:
      return Shape(notes: [392.0, 329.6, 261.6], step: 0.16, noteLength: 0.24, decay: 0.12, peak: 0.26)
    }
  }

  func buffer(format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let shape = shape
    let rate = format.sampleRate
    let attack = 0.008
    let release = min(0.03, shape.noteLength / 3)
    let total = AVAudioFrameCount(
      (shape.step * Double(shape.notes.count - 1) + shape.noteLength + 0.01) * rate)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: total),
      let channel = buffer.floatChannelData?[0]
    else { return nil }
    buffer.frameLength = total
    for index in 0..<Int(total) { channel[index] = 0 }
    for (position, frequency) in shape.notes.enumerated() {
      let offset = Int(shape.step * Double(position) * rate)
      let frames = min(Int(shape.noteLength * rate), Int(total) - offset)
      for frame in 0..<frames {
        let time = Double(frame) / rate
        let envelope =
          min(1, time / attack) * exp(-time / shape.decay)
          * min(1, (shape.noteLength - time) / release)
        let phase = 2 * Double.pi * frequency * time
        // A quiet octave above gives the sine a little warmth.
        let tone = sin(phase) + 0.12 * sin(2 * phase)
        channel[offset + frame] += shape.peak * Float(envelope * tone)
      }
    }
    return buffer
  }
}

/// Converts capture buffers to the format a consumer wants, keeping resampler state between
/// buffers. Passes buffers already in that format through untouched.
final class PCMConverter {
  let target: AVAudioFormat
  private var converter: AVAudioConverter?

  init(target: AVAudioFormat) {
    self.target = target
  }

  func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if buffer.format.isEqual(target) { return buffer }
    if converter == nil || converter?.inputFormat.isEqual(buffer.format) == false {
      converter = AVAudioConverter(from: buffer.format, to: target)
    }
    guard let converter else { return nil }
    let capacity =
      AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate)
      + 16
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
      return nil
    }
    var consumed = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, output.frameLength > 0 else { return nil }
    return output
  }
}

/// The capture written to an AAC `.m4a` in the caches directory. The file opens on the first
/// buffer, at that buffer's rate, so recording can start before the engine does and carries on
/// across engine rebuilds. Dictation queue only.
final class AudioRecording {
  private static let bitRate = 32_000

  let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("dictation-\(UUID().uuidString).m4a")
  private var file: AVAudioFile?
  private var failed = false
  private var frames: AVAudioFramePosition = 0

  func write(_ buffer: AVAudioPCMBuffer) {
    if file == nil, !failed {
      do {
        file = try open(matching: buffer.format)
      } catch {
        failed = true
        logger.error("Could not open the recording: \(error.localizedDescription, privacy: .public)")
      }
    }
    guard let file, Self.matches(buffer.format, file.processingFormat) else { return }
    do {
      try file.write(from: buffer)
      frames += AVAudioFramePosition(buffer.frameLength)
    } catch {
      logger.error("Recording write failed: \(error.localizedDescription, privacy: .public)")
    }
  }

  /// Closes the file and describes it for JS, or deletes it and returns nil when nothing was
  /// recorded.
  func finish() -> [String: Any]? {
    close()
    guard frames > 0 else {
      try? FileManager.default.removeItem(at: url)
      return nil
    }
    return ["uri": url.absoluteString, "mimeType": "audio/mp4"]
  }

  func discard() {
    close()
    try? FileManager.default.removeItem(at: url)
  }

  private func close() {
    // Before iOS 18 the file is finalized when it is released.
    if #available(iOS 18, *) { file?.close() }
    file = nil
  }

  /// Mono AAC at about 32 kbps (20 minutes is under 5 MB), written from Int16 buffers. Falls
  /// back to the encoder's default bit rate if it rejects 32 kbps at this sample rate.
  private func open(matching format: AVAudioFormat) throws -> AVAudioFile {
    var settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: format.sampleRate,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: Self.bitRate,
    ]
    do {
      return try AVAudioFile(
        forWriting: url, settings: settings, commonFormat: format.commonFormat,
        interleaved: format.isInterleaved)
    } catch {
      settings.removeValue(forKey: AVEncoderBitRateKey)
      try? FileManager.default.removeItem(at: url)
      return try AVAudioFile(
        forWriting: url, settings: settings, commonFormat: format.commonFormat,
        interleaved: format.isInterleaved)
    }
  }

  private static func matches(_ buffer: AVAudioFormat, _ file: AVAudioFormat) -> Bool {
    buffer.sampleRate == file.sampleRate && buffer.commonFormat == file.commonFormat
      && buffer.channelCount == file.channelCount
  }
}

/// On-device speech recognition of the capture while dictating. `onText` gets the current
/// segment's text as it changes, volatile guesses included, and once more with `isFinal` when
/// the segment is settled; `finish` returns every segment joined. Listeners restart their
/// recognizer if it ends on its own, so they run for as long as the user keeps talking.
protocol PhraseListener: AnyObject {
  /// Dictation queue only.
  func append(_ buffer: AVAudioPCMBuffer)
  /// Called off the dictation queue.
  func finish() async -> String
}

/// Settled segments joined into one transcript.
struct Transcript {
  private(set) var text = ""

  mutating func commit(_ segment: String) {
    let trimmed = segment.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    text = text.isEmpty ? trimmed : "\(text) \(trimmed)"
  }
}

/// Gives up on a recognizer that keeps ending right after it starts.
struct RestartBudget {
  private static let limit = 5
  private static let window: TimeInterval = 30
  private var restarts: [Date] = []

  mutating func allow() -> Bool {
    let now = Date()
    restarts = restarts.filter { now.timeIntervalSince($0) < Self.window }
    guard restarts.count < Self.limit else { return false }
    restarts.append(now)
    return true
  }
}

struct DictationError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}

/// iOS 26's SpeechAnalyzer with a SpeechTranscriber, on device with volatile results. Needs the
/// locale's model, which it downloads on start if the phone lacks it.
@available(iOS 26, *)
final class AnalyzerPhraseListener: PhraseListener {
  /// One analyzer run; a new one replaces it if the analyzer stops early.
  private final class Run {
    let analyzer: SpeechAnalyzer
    let input: AsyncStream<AnalyzerInput>.Continuation
    let converter: PCMConverter
    var results: Task<Void, Never>?

    init(analyzer: SpeechAnalyzer, input: AsyncStream<AnalyzerInput>.Continuation, converter: PCMConverter) {
      self.analyzer = analyzer
      self.input = input
      self.converter = converter
    }
  }

  private let locale: Locale
  private let queue: DispatchQueue
  private let onText: (String, Bool) -> Void
  /// Queue only.
  private var run: Run?
  private var transcript = Transcript()
  private var volatile = ""
  private var finishing = false
  private var budget = RestartBudget()

  static func start(
    locale identifier: String, queue: DispatchQueue, onText: @escaping (String, Bool) -> Void
  ) async throws -> AnalyzerPhraseListener {
    let locale = try await prepareModel(for: identifier)
    let listener = AnalyzerPhraseListener(locale: locale, queue: queue, onText: onText)
    let run = try await listener.makeRun()
    queue.sync { listener.run = run }
    return listener
  }

  private init(locale: Locale, queue: DispatchQueue, onText: @escaping (String, Bool) -> Void) {
    self.locale = locale
    self.queue = queue
    self.onText = onText
  }

  private static func makeTranscriber(_ locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(
      locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults],
      attributeOptions: [])
  }

  /// Resolves the locale the transcriber supports and makes sure its model is on the phone.
  private static func prepareModel(for identifier: String) async throws -> Locale {
    guard
      let locale = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: identifier))
    else {
      throw DictationError("On-device transcription doesn't support \(identifier).")
    }
    let transcriber = makeTranscriber(locale)
    switch await AssetInventory.status(forModules: [transcriber]) {
    case .installed:
      break
    case .supported, .downloading:
      logger.notice("Downloading the speech model for \(locale.identifier, privacy: .public)")
      do {
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
          try await request.downloadAndInstall()
        }
      } catch {
        throw DictationError(
          "Couldn't download the speech model for \(locale.identifier): \(error.localizedDescription)")
      }
    case .unsupported:
      throw DictationError("On-device transcription isn't available for \(locale.identifier).")
    @unknown default:
      break
    }
    return locale
  }

  private func makeRun() async throws -> Run {
    let transcriber = Self.makeTranscriber(locale)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    else {
      throw DictationError("On-device transcription has no audio format for \(locale.identifier).")
    }
    try await analyzer.prepareToAnalyze(in: format)
    let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
    try await analyzer.start(inputSequence: stream)
    let run = Run(analyzer: analyzer, input: input, converter: PCMConverter(target: format))
    run.results = Task { [weak self, queue] in
      do {
        for try await result in transcriber.results {
          let text = String(result.text.characters)
          let isFinal = result.isFinal
          queue.async { self?.received(text, isFinal: isFinal) }
        }
      } catch {
        logger.error("Speech analyzer stopped: \(error.localizedDescription, privacy: .public)")
      }
      queue.async { self?.ended(run) }
    }
    return run
  }

  func append(_ buffer: AVAudioPCMBuffer) {
    guard let run, let converted = run.converter.convert(buffer) else { return }
    run.input.yield(AnalyzerInput(buffer: converted))
  }

  private func received(_ text: String, isFinal: Bool) {
    if isFinal {
      transcript.commit(text)
      volatile = ""
    } else {
      volatile = text
    }
    onText(text, isFinal)
  }

  /// The analyzer stopped without being asked to; keeps what it heard and starts another.
  private func ended(_ ended: Run) {
    guard !finishing, run === ended else { return }
    run = nil
    transcript.commit(volatile)
    volatile = ""
    guard budget.allow() else {
      logger.error("Speech analyzer keeps stopping; giving up on the phrase listener")
      return
    }
    Task { [weak self] in
      guard let self else { return }
      do {
        let next = try await self.makeRun()
        self.queue.async {
          if self.finishing {
            next.input.finish()
            Task { await next.analyzer.cancelAndFinishNow() }
          } else {
            self.run = next
          }
        }
      } catch {
        logger.error("Speech analyzer restart failed: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  func finish() async -> String {
    let run = queue.sync { () -> Run? in
      finishing = true
      defer { self.run = nil }
      return self.run
    }
    if let run {
      run.input.finish()
      // Finalizing settles the last volatile words; a stuck analyzer is cut off after 5 s.
      let finalized = await withTaskGroup(of: Bool.self) { group in
        group.addTask {
          do {
            try await run.analyzer.finalizeAndFinishThroughEndOfInput()
            return true
          } catch {
            return false
          }
        }
        group.addTask {
          try? await Task.sleep(for: .seconds(5))
          return false
        }
        let first = await group.next() ?? false
        group.cancelAll()
        return first
      }
      if !finalized { await run.analyzer.cancelAndFinishNow() }
      await run.results?.value
    }
    return queue.sync {
      transcript.commit(volatile)
      volatile = ""
      return transcript.text
    }
  }
}

/// SFSpeechRecognizer on device, for iPhones before iOS 26 or without SpeechTranscriber. Needs
/// speech recognition permission. A recognition task ends on its own after long silence, so a
/// new one starts whenever one ends.
final class RecognizerPhraseListener: PhraseListener {
  private let recognizer: SFSpeechRecognizer
  private let queue: DispatchQueue
  private let onText: (String, Bool) -> Void
  /// Queue only.
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var converter: PCMConverter?
  private var segment = ""
  private var transcript = Transcript()
  private var finishing = false
  private var finished: CheckedContinuation<Void, Never>?
  private var budget = RestartBudget()

  static func start(
    locale identifier: String, queue: DispatchQueue, onText: @escaping (String, Bool) -> Void
  ) async throws -> RecognizerPhraseListener {
    let status = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
    guard status == .authorized else {
      throw DictationError("Allow speech recognition in Settings to dictate.")
    }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier)) else {
      throw DictationError("Speech recognition doesn't support \(identifier).")
    }
    guard recognizer.supportsOnDeviceRecognition else {
      throw DictationError("On-device speech recognition isn't available for \(identifier).")
    }
    let listener = RecognizerPhraseListener(recognizer: recognizer, queue: queue, onText: onText)
    queue.sync { listener.begin() }
    return listener
  }

  private init(
    recognizer: SFSpeechRecognizer, queue: DispatchQueue, onText: @escaping (String, Bool) -> Void
  ) {
    self.recognizer = recognizer
    self.queue = queue
    self.onText = onText
  }

  private func begin() {
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.addsPunctuation = true
    request.taskHint = .dictation
    self.request = request
    converter = PCMConverter(target: request.nativeAudioFormat)
    segment = ""
    task = recognizer.recognitionTask(with: request) { [weak self, queue] result, error in
      let text = result?.bestTranscription.formattedString
      let isFinal = result?.isFinal ?? false
      queue.async { self?.handle(request, text: text, isFinal: isFinal, failed: error != nil) }
    }
  }

  private func handle(
    _ from: SFSpeechAudioBufferRecognitionRequest, text: String?, isFinal: Bool, failed: Bool
  ) {
    guard from === request else { return }
    if let text {
      segment = text
      onText(text, isFinal)
    }
    guard isFinal || failed else { return }
    transcript.commit(segment)
    segment = ""
    request = nil
    task = nil
    converter = nil
    if finishing {
      finished?.resume()
      finished = nil
    } else if budget.allow() {
      begin()
    } else {
      logger.error("Speech recognition keeps stopping; giving up on the phrase listener")
    }
  }

  func append(_ buffer: AVAudioPCMBuffer) {
    guard let request, let converted = converter?.convert(buffer) else { return }
    request.append(converted)
  }

  func finish() async -> String {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      queue.async {
        self.finishing = true
        guard let request = self.request else {
          continuation.resume()
          return
        }
        self.finished = continuation
        request.endAudio()
        // The last result normally arrives within a moment of ending the audio.
        self.queue.asyncAfter(deadline: .now() + 3) {
          guard let pending = self.finished else { return }
          self.finished = nil
          self.task?.cancel()
          self.transcript.commit(self.segment)
          self.segment = ""
          self.request = nil
          self.task = nil
          pending.resume()
        }
      }
    }
    return queue.sync { transcript.text }
  }
}
