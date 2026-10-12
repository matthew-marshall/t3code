import AVFoundation
import ExpoModulesCore
import os

private let captureSampleRate = 16_000.0
private let playbackSampleRate = 24_000.0
/// 100 ms of 16-bit mono capture, the chunk size Gemini Live recommends.
private let captureChunkBytes = 3_200

/// Audio for one voice-agent session. The microphone goes out as base64 16 kHz
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
  private let captureFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: captureSampleRate, channels: 1, interleaved: true)!
  private let playbackFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: playbackSampleRate, channels: 1, interleaved: false)!

  public func definition() -> ModuleDefinition {
    Name("T3VoiceAudio")
    Events("onCapture", "onInputs", "onError")

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

    AsyncFunction("start") {
      try self.queue.sync {
        self.active = true
        self.rebuilds = []
        self.microphoneWaits = 0
        try self.startEngine()
        self.observe()
      }
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
        self.resetPlayback()
        self.player?.stop()
      }
    }

    OnDestroy {
      self.queue.sync { self.stop() }
    }
  }

  private func activateSession() throws {
    let session = AVAudioSession.sharedInstance()
    // Bluetooth HFP lets a car or headset microphone in; the speaker replaces
    // the earpiece when nothing is connected.
    try session.setCategory(
      .playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
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
    let inputFormat = input.outputFormat(forBus: 0)
    // A zero format means no microphone; installing a tap on it would crash.
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
      let converter = AVAudioConverter(from: inputFormat, to: captureFormat)
    else {
      throw VoiceAudioException(VoiceAudioException.noMicrophone)
    }
    pending = Data()
    input.installTap(
      onBus: 0, bufferSize: AVAudioFrameCount(inputFormat.sampleRate / 10), format: inputFormat
    ) { [weak self] buffer, _ in
      self?.capture(buffer, converter: converter)
    }
    engine.prepare()
    try engine.start()
    // Speech that arrived while the engine was restarting plays now.
    playing = false
    startPlaybackIfReady()
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

  private func capture(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter) {
    let capacity =
      AVAudioFrameCount(Double(buffer.frameLength) * captureSampleRate / buffer.format.sampleRate)
      + 16
    guard let output = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: capacity) else {
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
    pending.append(UnsafeBufferPointer(start: samples[0], count: Int(output.frameLength)))
    while pending.count >= captureChunkBytes {
      let chunk = pending.prefix(captureChunkBytes)
      pending.removeFirst(captureChunkBytes)
      sendEvent("onCapture", ["data": chunk.base64EncodedString()])
    }
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
      return
    }
    guard prerollDeadline == nil else { return }
    let deadline = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.prerollDeadline = nil
      guard !self.playing, self.queuedFrames > 0, self.engine?.isRunning == true else { return }
      self.player?.play()
      self.playing = true
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
    }
  }

  private func resetPlayback() {
    playbackGeneration += 1
    queuedFrames = 0
    playing = false
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
