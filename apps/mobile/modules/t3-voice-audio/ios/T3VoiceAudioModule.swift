import AVFoundation
import ExpoModulesCore
import MediaPlayer
import Speech
import os

private let playbackSampleRate = 24_000.0

/// 16-bit mono capture at the rate the session's provider takes: 16 kHz for Gemini, 24 kHz for
/// OpenAI.
private func makeCaptureFormat(sampleRate: Double) -> AVAudioFormat {
  AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
}

/// Audio for one voice-agent session. The microphone goes out as base64 16 or 24 kHz
/// PCM `onCapture` events and `play` queues base64 24 kHz PCM speech. Both run
/// on one voice-processing AVAudioEngine, so iOS cancels the agent's own voice
/// out of the microphone, which hands-free mode on the speaker depends on.
///
/// The session keeps running with the screen locked (the app declares the
/// `audio` background mode). A call or a route change, such as a car
/// connecting, stops the engine; it is rebuilt on the new route once the
/// route settles.
public final class T3VoiceAudioModule: Module {
  private static let logger = Logger(subsystem: "T3VoiceAudio", category: "audio")
  /// How long the route must stay quiet before the engine is rebuilt. iOS reconfigures audio
  /// in bursts, starting just after the engine starts while voice processing settles.
  private static let settleDelay: DispatchTimeInterval = .milliseconds(300)
  /// Rebuilds wait this many settle delays for the microphone to report a format.
  private static let maxMicrophoneWaits = 8
  /// More rebuilds than this in `rebuildWindow` means the route will not settle.
  private static let maxRebuilds = 6
  private static let rebuildWindow: TimeInterval = 15

  private enum Reactivation: Int, Comparable {
    case none, activate, configure
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
  }

  /// Speech buffered before playback starts, so network jitter does not become audible gaps.
  private static let prerollFrames = AVAudioFrameCount(playbackSampleRate * 0.2)
  /// A reply shorter than the preroll still plays after this long.
  private static let prerollTimeout: DispatchTimeInterval = .milliseconds(250)
  /// While speech plays on the phone's own speaker, quieter microphone chunks are sent as
  /// silence: echo cancellation leaves enough of the agent's voice for Gemini to hear it as the
  /// user and cut itself off. Someone talking over the agent is louder and still gets through.
  private static let echoGateDbfs = -32.0
  /// The room keeps echoing the agent briefly after its speech stops.
  private static let echoTail: TimeInterval = 0.3

  private let queue = DispatchQueue(label: "t3.voice-audio")
  /// Speech scheduled and not yet played, and whether the player is running; queue only.
  private var queuedFrames: AVAudioFrameCount = 0
  private var playing = false
  private var prerollDeadline: DispatchWorkItem?
  /// Bumped when queued speech is dropped, so completions of dropped buffers are ignored.
  private var playbackGeneration = 0
  /// Between start and stop; queue only. The engine can be missing in between while it is rebuilt.
  private var active = false
  private var pendingRebuild: DispatchWorkItem?
  private var pendingReactivation = Reactivation.none
  private var microphoneWaits = 0
  private var rebuilds: [Date] = []
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var observers: [NSObjectProtocol] = []
  /// Capture not yet sent; only the tap thread touches it while an engine runs.
  private var pending = Data()
  /// Where the speech detector's model ships; nil if the build lacks it.
  private static let modelBundle = Bundle(for: T3VoiceAudioModule.self)
    .url(forResource: "T3VoiceAudioModels", withExtension: "bundle")
    .flatMap(Bundle.init(url:))
  private static let voiceActivityFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: VoiceActivityModel.sampleRate, channels: 1,
    interleaved: false)!
  /// The highest speech probability since the last chunk went out, and the one before; tap thread.
  private var speechSinceChunk: Float?
  private var lastSpeech: Float = 0
  /// Shared by the queue, which opens and closes the gate, and the tap thread, which applies it.
  private let echoGate = OSAllocatedUnfairLock(initialState: EchoGate())
  /// Set by `start`, before the engine that reads it runs.
  private var captureFormat = makeCaptureFormat(sampleRate: 16_000)
  private let playbackFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: playbackSampleRate, channels: 1, interleaved: false)!

  /// Dictation's phrase listener and recording, which get every converted capture buffer while
  /// either is running. They outlive engine rebuilds. Owned by `dictationQueue`, which never
  /// waits on `queue`.
  private let dictationQueue = DispatchQueue(label: "t3.voice-audio.dictation")
  private var listener: PhraseListener?
  /// A stopped listener settling its last words, for `stopSpeechListener` to collect.
  private var listenerFinish: Task<String, Never>?
  private var recording: AudioRecording?
  /// A recording `stop` closed before `stopRecording` collected it.
  private var finishedRecording: [String: Any]?
  /// Whether the tap hands capture to dictation; set on `dictationQueue`, read on the tap thread.
  private let dictationFeeding = OSAllocatedUnfairLock(initialState: false)

  public func definition() -> ModuleDefinition {
    Name("T3VoiceAudio")
    Events("onCapture", "onInputs", "onError", "onSpeech", "onRemoteCommand", "onStartRequested")

    // Siri's "Talk to T3" (StartVoiceAgentIntent, in the app target) asks for a voice session.
    // A request while the app runs arrives as `onStartRequested`; one that launched it waits here.
    // A line in the device log, to line feedback up with the native logs around it.
    Function("logMarker") { (text: String) in
      Self.logger.notice("\(text, privacy: .public)")
    }

    Function("takeStartRequest") { () -> Bool in
      let defaults = UserDefaults.standard
      let at = defaults.double(forKey: Self.startRequestKey)
      defaults.removeObject(forKey: Self.startRequestKey)
      return at > 0 && Date().timeIntervalSince1970 - at < 60
    }

    OnCreate {
      self.startObserver = NotificationCenter.default.addObserver(
        forName: Notification.Name("T3VoiceStartRequested"), object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onStartRequested", [:])
      }
    }

    // Activates the voice session and lists its microphones; iOS lists them only then.
    AsyncFunction("prepare") { () -> [[String: String]] in
      try self.queue.sync {
        try self.activateSession()
        return self.availableInputs()
      }
    }

    AsyncFunction("setInput") { (uid: String) in
      try self.queue.sync {
        let session = AVAudioSession.sharedInstance()
        // Choosing the microphone already in use still reroutes audio, which stops the engine.
        guard session.currentRoute.inputs.first?.uid != uid,
          session.preferredInput?.uid != uid,
          let port = session.availableInputs?.first(where: { $0.uid == uid })
        else { return }
        Self.logger.notice("Switching microphone to \(port.portName, privacy: .public)")
        try session.setPreferredInput(port)
      }
    }

    AsyncFunction("start") { (sampleRate: Double) in
      try self.queue.sync {
        self.captureFormat = makeCaptureFormat(sampleRate: sampleRate)
        self.active = true
        self.rebuilds = []
        self.microphoneWaits = 0
        try self.startEngine()
        self.observe()
      }
      self.waitForSettledEngine()
    }

    AsyncFunction("stop") {
      self.queue.sync { self.stop() }
    }

    Function("play") { (base64: String) in
      self.queue.async { self.schedule(base64) }
    }

    Function("clearPlayback") {
      self.queue.async {
        // Stopping drops every scheduled buffer; the next speech buffers up again before playing.
        if self.queuedFrames > 0 {
          Self.logger.notice("Speech cleared with \(self.queuedFrames, privacy: .public) frames queued")
        }
        self.resetPlayback()
        self.player?.stop()
      }
    }

    // While on, play/pause presses (a steering wheel, headphones, the lock screen) send
    // `onRemoteCommand` instead of reaching other apps; dictation uses them to finish. Showing a
    // Now Playing entry is what makes iOS route those presses here.
    Function("setRemoteControl") { (enabled: Bool) in
      DispatchQueue.main.async { self.setRemoteControl(enabled) }
    }

    // A sound cue (see `Chime`), on the same route as the agent's voice.
    Function("playChime") { (kind: String) in
      guard let chime = Chime(rawValue: kind) else { return }
      self.queue.async { self.playChime(chime) }
    }

    // On-device recognition of the capture. `onSpeech` carries the current segment's text as it
    // changes, then once more with `isFinal` when the segment settles; a new segment starts after
    // a pause. Resolves once recognition is ready, which can include downloading the model.
    AsyncFunction("startSpeechListener") { (locale: String) async throws in
      if let previous = self.dictationQueue.sync(execute: { self.detachListener() }) {
        _ = await previous.value
      }
      let onText: (String, Bool) -> Void = { [weak self] text, isFinal in
        self?.sendEvent("onSpeech", ["text": text, "isFinal": isFinal])
      }
      let listener: PhraseListener
      if #available(iOS 26, *), SpeechTranscriber.isAvailable {
        listener = try await AnalyzerPhraseListener.start(
          locale: locale, queue: self.dictationQueue, onText: onText)
      } else {
        listener = try await RecognizerPhraseListener.start(
          locale: locale, queue: self.dictationQueue, onText: onText)
      }
      self.dictationQueue.sync {
        self.listener = listener
        self.updateDictationFeeding()
      }
    }

    // The whole transcript since `startSpeechListener`, settled segments joined by spaces.
    AsyncFunction("stopSpeechListener") { () async -> String in
      let finish = self.dictationQueue.sync { () -> Task<String, Never>? in
        _ = self.detachListener()
        defer { self.listenerFinish = nil }
        return self.listenerFinish
      }
      return await finish?.value ?? ""
    }

    AsyncFunction("startRecording") {
      self.dictationQueue.sync {
        self.recording?.discard()
        self.finishedRecording = nil
        self.recording = AudioRecording()
        self.updateDictationFeeding()
      }
    }

    // `{ uri, mimeType }` of the AAC recording, or nil if nothing was captured.
    AsyncFunction("stopRecording") { () -> [String: Any]? in
      self.dictationQueue.sync {
        self.finishRecording()
        defer { self.finishedRecording = nil }
        return self.finishedRecording
      }
    }

    OnDestroy {
      self.queue.sync { self.stop() }
      DispatchQueue.main.async { self.setRemoteControl(false) }
    }
  }

  private static let startRequestKey = "t3.voice.startRequestedAt"
  private var startObserver: NSObjectProtocol?

  /// Main thread only, like MPRemoteCommandCenter.
  private var remoteTargets: [(MPRemoteCommand, Any)] = []

  private func setRemoteControl(_ enabled: Bool) {
    let center = MPRemoteCommandCenter.shared()
    for (command, target) in remoteTargets { command.removeTarget(target) }
    remoteTargets = []
    guard enabled else {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      return
    }
    for command in [center.togglePlayPauseCommand, center.pauseCommand, center.playCommand] {
      command.isEnabled = true
      let target = command.addTarget { [weak self] _ in
        self?.sendEvent("onRemoteCommand", ["command": "toggle"])
        return .success
      }
      remoteTargets.append((command, target))
    }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: "Dictating",
      MPMediaItemPropertyArtist: "T3 Code · press play/pause to finish",
      MPNowPlayingInfoPropertyPlaybackRate: 1.0,
    ]
  }

  private func activateSession() throws {
    let session = AVAudioSession.sharedInstance()
    // Bluetooth HFP lets a car or headset microphone in; the speaker replaces
    // the earpiece when nothing is connected.
    try session.setCategory(
      .playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
    // Echo cancellation compares what plays with what the microphone hears; one rate for both
    // sides keeps it from resampling either. Logs showed speech at 44.1 kHz and the mic at 48.
    try? session.setPreferredSampleRate(48_000)
    try session.setActive(true)
  }

  private func availableInputs() -> [[String: String]] {
    (AVAudioSession.sharedInstance().availableInputs ?? []).map {
      ["uid": $0.uid, "name": $0.portName, "type": $0.portType.rawValue]
    }
  }

  /// Creates the session's one engine. Enabling voice processing reconfigures the phone's shared
  /// voice audio unit, which stops whatever engine is running: a new engine per configuration
  /// change triggers the next change, forever. So a new engine is made only when the session
  /// starts and after a media services reset; other changes restart this one (`runEngine`).
  private func makeEngine() throws {
    teardownEngine()
    let engine = AVAudioEngine()
    try engine.inputNode.setVoiceProcessingEnabled(true)
    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
    self.engine = engine
    self.player = player
  }

  /// Wires the microphone for the current route's format, then starts the engine and speech.
  private func runEngine() throws {
    guard let engine, player != nil else { return }
    let input = engine.inputNode
    input.removeTap(onBus: 0)
    // Echo cancellation is voice processing on this node; make sure a reconfiguration left it on.
    if !input.isVoiceProcessingEnabled {
      Self.logger.error("Voice processing was off after a reconfiguration; turning it back on")
      try input.setVoiceProcessingEnabled(true)
    }
    if input.isVoiceProcessingBypassed {
      input.isVoiceProcessingBypassed = false
    }
    let inputFormat = input.outputFormat(forBus: 0)
    // A zero format means no microphone; installing a tap on it would crash.
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
      let converter = AVAudioConverter(from: inputFormat, to: captureFormat)
    else {
      throw VoiceAudioException(VoiceAudioException.noMicrophone)
    }
    pending = Data()
    // How likely the microphone hears someone talking, sent with each chunk so hands-free opens
    // for speech rather than any loud sound. One per engine run, fed only by its tap. Without it
    // only the level is sent.
    let detector = Self.modelBundle.flatMap(VoiceActivityModel.init(bundle:))
    if detector == nil {
      Self.logger.error("Speech detection is unavailable; hands-free goes by loudness")
    }
    speechSinceChunk = nil
    lastSpeech = 0
    let detectorConverter =
      detector == nil ? nil : AVAudioConverter(from: captureFormat, to: Self.voiceActivityFormat)
    input.installTap(
      onBus: 0, bufferSize: AVAudioFrameCount(inputFormat.sampleRate / 10), format: inputFormat
    ) { [weak self] buffer, _ in
      self?.capture(buffer, converter: converter, detector: detector, detectorConverter: detectorConverter)
    }
    engine.prepare()
    try engine.start()
    logAudioState(engine)
    // Speech that arrived while the engine was restarting plays now.
    playing = false
    startPlaybackIfReady()
  }

  /// What echo cancellation depends on, for reading in the device log.
  private func logAudioState(_ engine: AVAudioEngine) {
    let session = AVAudioSession.sharedInstance()
    let input = engine.inputNode
    let inputs = session.currentRoute.inputs.map(\.portName).joined(separator: ",")
    let outputs = session.currentRoute.outputs.map(\.portName).joined(separator: ",")
    Self.logger.notice(
      """
      Audio running: voice processing in=\(input.isVoiceProcessingEnabled, privacy: .public) \
      out=\(engine.outputNode.isVoiceProcessingEnabled, privacy: .public) \
      bypassed=\(input.isVoiceProcessingBypassed, privacy: .public); \
      mic \(input.outputFormat(forBus: 0).sampleRate, privacy: .public) Hz \
      x\(input.outputFormat(forBus: 0).channelCount, privacy: .public), \
      speaker \(engine.outputNode.outputFormat(forBus: 0).sampleRate, privacy: .public) Hz, \
      session \(session.sampleRate, privacy: .public) Hz \
      \(session.category.rawValue, privacy: .public)/\(session.mode.rawValue, privacy: .public); \
      route \(inputs, privacy: .public) -> \(outputs, privacy: .public)
      """)
  }

  /// iOS reconfigures audio about 0.2 s after a voice-processing engine starts, which stops it
  /// until the restart. Resolving `start` only once that has passed means the app shows
  /// "Listening" when the microphone is really on, so a first "hello" is not lost in the gap.
  /// Runs on the module's calling thread, never on `queue`, which does the restart.
  private func waitForSettledEngine() {
    let deadline = Date().addingTimeInterval(1.5)
    Thread.sleep(forTimeInterval: 0.35)
    while Date() < deadline {
      let settled = queue.sync { pendingRebuild == nil && engine?.isRunning == true }
      if settled { return }
      Thread.sleep(forTimeInterval: 0.05)
    }
    Self.logger.notice("Audio was still settling after 1.5 s; starting anyway")
  }

  private func startEngine() throws {
    try makeEngine()
    try runEngine()
  }

  private func teardownEngine() {
    resetPlayback()
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
    player = nil
  }

  private func stop() {
    active = false
    dictationQueue.sync {
      _ = detachListener()
      finishRecording()
    }
    pendingRebuild?.cancel()
    pendingRebuild = nil
    pendingReactivation = .none
    teardownEngine()
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers = []
    let session = AVAudioSession.sharedInstance()
    try? session.setPreferredInput(nil)
    // Lets music or a podcast the session paused pick back up.
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Rebuilds the engine once the route has been quiet for `settleDelay`. A call ending needs the
  /// session reactivated and a media server reset needs it configured again; a plain route or
  /// configuration change needs neither, and redoing them would only reroute audio again.
  private func scheduleRebuild(_ reactivation: Reactivation, reason: String) {
    guard active else { return }
    Self.logger.notice("Audio \(reason, privacy: .public); rebuilding once the route settles")
    pendingReactivation = max(pendingReactivation, reactivation)
    pendingRebuild?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.rebuild() }
    pendingRebuild = work
    queue.asyncAfter(deadline: .now() + Self.settleDelay, execute: work)
  }

  private func rebuild() {
    pendingRebuild = nil
    guard active else { return }
    let now = Date()
    rebuilds = rebuilds.filter { now.timeIntervalSince($0) < Self.rebuildWindow }
    if rebuilds.count >= Self.maxRebuilds {
      fail("The audio route keeps changing. Try again.")
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      let reactivation = pendingReactivation
      switch reactivation {
      case .configure: try activateSession()
      case .activate: try session.setActive(true)
      case .none: break
      }
      pendingReactivation = .none
      // A media services reset invalidates every audio object; anything else keeps the engine.
      if reactivation == .configure || engine == nil {
        try makeEngine()
      }
      try runEngine()
      rebuilds.append(now)
      microphoneWaits = 0
      Self.logger.notice("Audio engine restarted")
    } catch let error as VoiceAudioException where error.microphoneUnavailable
      && microphoneWaits < Self.maxMicrophoneWaits
    {
      // The new route has no input format yet; give it another moment.
      microphoneWaits += 1
      scheduleRebuild(.none, reason: "has no microphone format yet")
    } catch {
      fail("Lost the microphone: \(describe(error))")
    }
  }

  private func fail(_ message: String) {
    Self.logger.error("\(message, privacy: .public)")
    teardownEngine()
    active = false
    sendEvent("onError", ["message": message])
  }

  private func describe(_ error: Error) -> String {
    (error as? VoiceAudioException)?.reason ?? error.localizedDescription
  }

  private func observe() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(
        forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
      ) { [weak self] note in
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          AVAudioSession.InterruptionType(rawValue: raw) == .ended
        else { return }
        self?.queue.async { self?.scheduleRebuild(.activate, reason: "interruption ended") }
      },
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) {
        [weak self] note in
        // An engine posts this even while it is being torn down after a rebuild replaced it.
        // Only its identity crosses to the queue: holding the notification (and so the engine)
        // past this handler over-released a dying engine and crashed.
        guard let object = note.object as AnyObject? else { return }
        let changed = ObjectIdentifier(object)
        self?.queue.async {
          guard let self, let engine = self.engine, ObjectIdentifier(engine) == changed,
            !engine.isRunning
          else { return }
          self.scheduleRebuild(.none, reason: "configuration changed")
        }
      },
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil
      ) { [weak self] _ in
        self?.queue.async { self?.scheduleRebuild(.configure, reason: "media services reset") }
      },
      // A microphone came or went: the app picks again by the user's microphone priority.
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
      ) { [weak self] note in
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
          reason == .newDeviceAvailable || reason == .oldDeviceUnavailable
        else { return }
        self?.queue.async {
          guard let self, self.active else { return }
          self.sendEvent("onInputs", ["inputs": self.availableInputs()])
        }
      },
    ]
  }

  private func capture(
    _ buffer: AVAudioPCMBuffer, converter: AVAudioConverter, detector: VoiceActivityModel?,
    detectorConverter: AVAudioConverter?
  ) {
    let format = converter.outputFormat
    let capacity =
      AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate)
      + 16
    // 100 ms of 16-bit mono, the chunk size both providers recommend.
    let chunkBytes = Int(format.sampleRate / 10) * 2
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      return
    }
    var consumed = false
    var error: NSError?
    // `.noDataNow` rather than end of stream keeps the resampler's state between buffers.
    converter.convert(to: output, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    guard error == nil, output.frameLength > 0, let samples = output.int16ChannelData else {
      return
    }
    // Dictation hears the user unsilenced by the echo gate; each tap call makes a new buffer.
    if dictationFeeding.withLock({ $0 }) {
      dictationQueue.async { [weak self] in self?.feedDictation(output) }
    }
    if let detector, let detectorConverter,
      let speech = detectSpeech(output, detector: detector, converter: detectorConverter)
    {
      speechSinceChunk = max(speechSinceChunk ?? 0, speech)
    }
    pending.append(UnsafeBufferPointer(start: samples[0], count: Int(output.frameLength)))
    while pending.count >= chunkBytes {
      var chunk = Data(pending.prefix(chunkBytes))
      pending.removeFirst(chunkBytes)
      let level = Self.dbfs(chunk)
      let silenced = echoGate.withLock { gate in
        guard gate.isActive(at: ProcessInfo.processInfo.systemUptime) else { return false }
        if level < Self.echoGateDbfs {
          gate.loudestHeld = max(gate.loudestHeld, level)
          return true
        }
        gate.passed += 1
        return false
      }
      if silenced { chunk.resetBytes(in: 0..<chunk.count) }
      // A chunk cut before a detector frame finished carries the last probability on.
      let speech = speechSinceChunk ?? lastSpeech
      lastSpeech = speech
      speechSinceChunk = nil
      // The level and speech probability let hands-free send only around speech; silenced echo
      // counts as quiet.
      var event: [String: Any] = [
        "data": chunk.base64EncodedString(), "level": silenced ? -120 : level,
      ]
      if detector != nil { event["speech"] = silenced ? 0 : Double(speech) }
      sendEvent("onCapture", event)
    }
  }

  /// The detector's speech probability for frames this capture completed; tap thread.
  private func detectSpeech(
    _ capture: AVAudioPCMBuffer, detector: VoiceActivityModel, converter: AVAudioConverter
  ) -> Float? {
    let capacity =
      AVAudioFrameCount(
        Double(capture.frameLength) * VoiceActivityModel.sampleRate / capture.format.sampleRate) + 16
    guard
      let output = AVAudioPCMBuffer(pcmFormat: Self.voiceActivityFormat, frameCapacity: capacity)
    else { return nil }
    var consumed = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return capture
    }
    guard error == nil, output.frameLength > 0, let samples = output.floatChannelData else {
      return nil
    }
    return detector.feed(UnsafeBufferPointer(start: samples[0], count: Int(output.frameLength)))
  }

  private static func dbfs(_ pcm: Data) -> Double {
    let sumOfSquares = pcm.withUnsafeBytes { raw in
      raw.bindMemory(to: Int16.self).reduce(0.0) { sum, sample in
        let value = Double(Int16(littleEndian: sample)) / 32_768
        return sum + value * value
      }
    }
    let rms = (sumOfSquares / Double(max(pcm.count / 2, 1))).squareRoot()
    return rms > 0 ? 20 * log10(rms) : -120
  }

  /// Turns the echo gate on when speech starts playing on the built-in speaker; queue only.
  private func speechStarted() {
    let onSpeaker = AVAudioSession.sharedInstance().currentRoute.outputs.contains {
      $0.portType == .builtInSpeaker
    }
    guard onSpeaker else { return }
    echoGate.withLock { $0.until = .infinity }
  }

  /// Turns the echo gate off once the room's echo dies down, and logs what it held back so the
  /// threshold can be checked against real echo; queue only.
  private func speechStopped() {
    let summary = echoGate.withLock { gate -> (Double, Int)? in
      guard gate.until == .infinity else { return nil }
      gate.until = ProcessInfo.processInfo.systemUptime + Self.echoTail
      defer {
        gate.loudestHeld = -120
        gate.passed = 0
      }
      return (gate.loudestHeld, gate.passed)
    }
    guard let (loudestHeld, passed) = summary else { return }
    Self.logger.notice(
      """
      Echo gate: loudest held back \(loudestHeld, format: .fixed(precision: 1), privacy: .public) \
      dBFS, \(passed, privacy: .public) louder chunks let through
      """)
  }

  private func schedule(_ base64: String) {
    guard let player, let data = Data(base64Encoded: base64), data.count >= 2 else { return }
    let frames = data.count / 2
    guard
      let buffer = AVAudioPCMBuffer(
        pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(frames)),
      let channel = buffer.floatChannelData?[0]
    else { return }
    buffer.frameLength = AVAudioFrameCount(frames)
    data.withUnsafeBytes { raw in
      for index in 0..<frames {
        let sample = Int16(
          littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
        channel[index] = Float(sample) / 32_768
      }
    }
    let generation = playbackGeneration
    let scheduled = buffer.frameLength
    queuedFrames += scheduled
    player.scheduleBuffer(buffer) { [weak self] in
      // Called on the render thread, or when the player is stopped.
      self?.queue.async { self?.finished(scheduled, generation: generation) }
    }
    startPlaybackIfReady()
  }

  /// Starts the player once enough speech is buffered, or once the preroll timeout passes.
  private func startPlaybackIfReady() {
    guard !playing, queuedFrames > 0, let player, engine?.isRunning == true else { return }
    if queuedFrames >= Self.prerollFrames {
      prerollDeadline?.cancel()
      prerollDeadline = nil
      player.play()
      playing = true
      speechStarted()
      return
    }
    guard prerollDeadline == nil else { return }
    let deadline = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.prerollDeadline = nil
      guard !self.playing, self.queuedFrames > 0, self.engine?.isRunning == true else { return }
      self.player?.play()
      self.playing = true
      self.speechStarted()
    }
    prerollDeadline = deadline
    queue.asyncAfter(deadline: .now() + Self.prerollTimeout, execute: deadline)
  }

  /// When the buffer runs dry mid-reply, pause and buffer up again rather than stutter.
  private func finished(_ frames: AVAudioFrameCount, generation: Int) {
    guard generation == playbackGeneration else { return }
    queuedFrames = queuedFrames > frames ? queuedFrames - frames : 0
    if queuedFrames == 0, playing {
      player?.pause()
      playing = false
      speechStopped()
      Self.logger.notice("Speech buffer ran dry; waiting for more")
    }
  }

  /// Plays a chime right away, ahead of any speech still buffering. It is counted like speech, so
  /// the player pauses and the echo gate closes once it and any speech have played; queue only.
  private func playChime(_ chime: Chime) {
    guard let player, engine?.isRunning == true, let buffer = chime.buffer(format: playbackFormat)
    else { return }
    let generation = playbackGeneration
    let frames = buffer.frameLength
    queuedFrames += frames
    player.scheduleBuffer(buffer) { [weak self] in
      self?.queue.async { self?.finished(frames, generation: generation) }
    }
    guard !playing else { return }
    prerollDeadline?.cancel()
    prerollDeadline = nil
    player.play()
    playing = true
    speechStarted()
  }

  /// Dictation queue only.
  private func feedDictation(_ buffer: AVAudioPCMBuffer) {
    recording?.write(buffer)
    listener?.append(buffer)
  }

  /// Dictation queue only.
  private func updateDictationFeeding() {
    let feeding = listener != nil || recording != nil
    dictationFeeding.withLock { $0 = feeding }
  }

  /// Stops feeding the listener and lets it settle in the background; returns that settling.
  /// Dictation queue only.
  @discardableResult
  private func detachListener() -> Task<String, Never>? {
    if let listener {
      self.listener = nil
      updateDictationFeeding()
      listenerFinish = Task { await listener.finish() }
    }
    return listenerFinish
  }

  /// Closes the recording and keeps its result for `stopRecording`; dictation queue only.
  private func finishRecording() {
    guard let recording else { return }
    self.recording = nil
    updateDictationFeeding()
    finishedRecording = recording.finish()
  }

  private func resetPlayback() {
    playbackGeneration += 1
    queuedFrames = 0
    playing = false
    speechStopped()
    prerollDeadline?.cancel()
    prerollDeadline = nil
  }
}

final class VoiceAudioException: GenericException<String>, @unchecked Sendable {
  static let noMicrophone = "No microphone is available."

  override var reason: String {
    param
  }

  var microphoneUnavailable: Bool { param == Self.noMicrophone }
}

/// Silences quiet microphone chunks while the agent talks on the speaker, until `until`.
private struct EchoGate {
  var until: TimeInterval = 0
  /// Since speech started: the loudest chunk silenced, and how many louder ones went through.
  var loudestHeld = -120.0
  var passed = 0

  func isActive(at now: TimeInterval) -> Bool { now < until }
}
