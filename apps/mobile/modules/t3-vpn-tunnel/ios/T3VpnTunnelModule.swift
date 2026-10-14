import ExpoModulesCore
import NetworkExtension
import OCCore
import os

struct VpnTunnelStartOptions: Record {
  @Field var gateway: String = ""
  @Field var cookie: String = ""
  @Field var targetHost: String = ""
  @Field var targetPort: Int = 0
  @Field var localPort: Int = 0
  @Field var serverCertPin: String?
  @Field var os: String = "linux"
  /** Also the faster UDP (ESP) channel; off keeps to TLS, which recovers at once. */
  @Field var useEsp: Bool = false
}

// Wraps occore (native/occore.h). One tunnel per process; start() resolves with the
// local port once the tunnel is up, and onState reports later drops and reconnects.
public final class T3VpnTunnelModule: Module {
  private let lock = NSLock()
  // Held while a core is stopped or its listener reopened, so stop() cannot free a core that
  // occore_reopen_listener is waiting on. Never taken by the tunnel's own callbacks.
  private let lifecycleLock = NSLock()
  private var core: OpaquePointer?
  private var startPromise: Promise?
  private var state = "stopped"
  // Recent tunnel log lines, so the settings screen can show what happened before it opened.
  private var logLines: [String] = []
  private static let maxLogLines = 300
  private static let logger = Logger(subsystem: "T3VpnTunnel", category: "tunnel")
  private static let timestamp: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter
  }()

  public func definition() -> ModuleDefinition {
    Name("T3VpnTunnel")
    Events("onState", "onLog", "onSystemState")

    // Whether this build embeds the packet tunnel extension (the background path).
    Constant("systemVpnAvailable") { () -> Bool in
      guard let plugIns = Bundle.main.builtInPlugInsURL else { return false }
      return FileManager.default.fileExists(
        atPath: plugIns.appendingPathComponent("T3PacketTunnel.appex").path)
    }

    AsyncFunction("start") { (options: VpnTunnelStartOptions, promise: Promise) in
      self.start(options, promise: promise)
    }

    AsyncFunction("stop") {
      self.stop()
    }

    Function("getLog") { () -> [String] in
      self.lock.lock()
      defer { self.lock.unlock() }
      return self.logLines
    }

    Function("getState") { () -> [String: Any] in
      self.lock.lock()
      defer { self.lock.unlock() }
      return [
        "state": self.state,
        "localPort": self.core.map { Int(occore_local_port($0)) } as Any,
        // What the gateway said about sign-ins once connected; 0 before.
        "sessionLifetime": self.core.map { Int(occore_session_lifetime($0)) } ?? 0,
        "lifetimeNotifyPrior": self.core.map { Int(occore_lifetime_notify_prior($0)) } ?? 0,
      ]
    }

    // iOS reclaims a suspended app's listening sockets, so the local forward goes dead after the
    // phone has been locked a while even though the VPN reconnects. Call on returning to the
    // foreground, before connecting through the tunnel; resolves with the (usually same) port.
    AsyncFunction("reopenListener") { () -> [String: Any] in
      self.lifecycleLock.lock()
      defer { self.lifecycleLock.unlock() }
      self.lock.lock()
      let current = self.core
      self.lock.unlock()
      guard let current else { return ["localPort": NSNull()] }
      let result = occore_reopen_listener(current)
      if result != 0 {
        throw Exception(
          name: "ERR_VPN_REOPEN", description: "Could not reopen the tunnel's local port: \(String(cString: strerror(-result)))")
      }
      return ["localPort": Int(occore_local_port(current))]
    }

    // The background path: the same tunnel as a system VPN (the packet tunnel extension), which
    // keeps running while the app is closed. Resolves once it is connected.
    AsyncFunction("startSystem") { (options: VpnTunnelStartOptions) in
      try await self.startSystem(options)
    }

    AsyncFunction("stopSystem") {
      let manager = try await self.systemManager(create: false)
      manager?.connection.stopVPNTunnel()
    }

    AsyncFunction("getSystemState") { () -> String in
      let manager = try await self.systemManager(create: false)
      return manager.map { Self.statusName($0.connection.status) } ?? "stopped"
    }

    /// The extension's recent log lines; empty when it is not running.
    AsyncFunction("getSystemLog") { () -> [String] in
      guard let session = try await self.systemManager(create: false)?.connection as? NETunnelProviderSession,
        session.status != .invalid, session.status != .disconnected
      else { return [] }
      return await withCheckedContinuation { continuation in
        do {
          try session.sendProviderMessage(Data()) { data in
            let lines = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String] }
            continuation.resume(returning: lines ?? [])
          }
        } catch {
          continuation.resume(returning: [])
        }
      }
    }

    OnStartObserving {
      self.statusObserver = NotificationCenter.default.addObserver(
        forName: .NEVPNStatusDidChange, object: nil, queue: nil
      ) { [weak self] note in
        guard let connection = note.object as? NEVPNConnection else { return }
        self?.sendEvent("onSystemState", ["state": Self.statusName(connection.status)])
      }
    }

    OnStopObserving {
      if let observer = self.statusObserver { NotificationCenter.default.removeObserver(observer) }
      self.statusObserver = nil
    }

    OnDestroy {
      self.stop()
    }
  }

  private var statusObserver: NSObjectProtocol?

  private static var extensionBundleIdentifier: String {
    (Bundle.main.bundleIdentifier ?? "") + ".packet-tunnel"
  }

  private static func statusName(_ status: NEVPNStatus) -> String {
    switch status {
    case .connected: return "connected"
    case .connecting, .reasserting: return "connecting"
    case .disconnecting: return "disconnecting"
    default: return "stopped"
    }
  }

  /// This app's VPN configuration, created (which asks the user to allow it once) when `create`.
  private func systemManager(create: Bool) async throws -> NETunnelProviderManager? {
    let managers = try await NETunnelProviderManager.loadAllFromPreferences()
    if let existing = managers.first { return existing }
    return create ? NETunnelProviderManager() : nil
  }

  private func startSystem(_ options: VpnTunnelStartOptions) async throws {
    guard let manager = try await systemManager(create: true) else { return }
    let proto = (manager.protocolConfiguration as? NETunnelProviderProtocol) ?? NETunnelProviderProtocol()
    proto.providerBundleIdentifier = Self.extensionBundleIdentifier
    proto.serverAddress = options.gateway
    // Not secret; the cookie only travels in the start options below.
    var configuration: [String: Any] = [
      "gateway": options.gateway, "targetHost": options.targetHost, "os": options.os,
    ]
    if let pin = options.serverCertPin { configuration["serverCertPin"] = pin }
    configuration["useEsp"] = options.useEsp
    proto.providerConfiguration = configuration
    proto.disconnectOnSleep = false
    manager.protocolConfiguration = proto
    manager.localizedDescription = "T3 Code"
    manager.isEnabled = true
    try await manager.saveToPreferences()
    // Saving can leave the manager stale until reloaded.
    try await manager.loadFromPreferences()

    if manager.connection.status == .connected { return }
    try await waitForConnection(manager) {
      try (manager.connection as? NETunnelProviderSession)?.startTunnel(options: [
        "cookie": options.cookie as NSString
      ])
    }
  }

  /// Runs `start`, then waits until the VPN connects or gives up with the extension's reason.
  private func waitForConnection(
    _ manager: NETunnelProviderManager, start: () throws -> Void
  ) async throws {
    let connection = manager.connection
    let stream = AsyncStream<NEVPNStatus> { continuation in
      let observer = NotificationCenter.default.addObserver(
        forName: .NEVPNStatusDidChange, object: connection, queue: nil
      ) { _ in continuation.yield(connection.status) }
      continuation.onTermination = { _ in NotificationCenter.default.removeObserver(observer) }
    }
    try start()
    var sawConnecting = false
    for await status in stream {
      switch status {
      case .connected:
        return
      case .connecting, .reasserting:
        sawConnecting = true
      case .disconnected, .invalid:
        guard sawConnecting else { continue }
        // The async form throws the extension's reason rather than returning it.
        var reason = "The VPN did not connect."
        do {
          try await connection.fetchLastDisconnectError()
        } catch {
          reason = error.localizedDescription
        }
        throw Exception(name: "ERR_VPN_SYSTEM", description: reason)
      default:
        continue
      }
    }
  }

  private func start(_ options: VpnTunnelStartOptions, promise: Promise) {
    stop()

    let strings = [options.gateway, options.cookie, options.targetHost, options.os, options.serverCertPin ?? ""]
      .map { strdup($0) }
    defer { strings.forEach { free($0) } }

    var config = occore_config()
    config.gateway = UnsafePointer(strings[0])
    config.cookie = UnsafePointer(strings[1])
    config.target_host = UnsafePointer(strings[2])
    config.os = UnsafePointer(strings[3])
    config.server_cert_pin = options.serverCertPin == nil ? nil : UnsafePointer(strings[4])
    config.target_port = UInt16(clamping: options.targetPort)
    config.local_port = UInt16(clamping: options.localPort)
    config.use_esp = options.useEsp ? 1 : 0
    config.ctx = Unmanaged.passUnretained(self).toOpaque()
    config.log = { ctx, level, message in
      guard let ctx, let message else { return }
      let module = Unmanaged<T3VpnTunnelModule>.fromOpaque(ctx).takeUnretainedValue()
      module.appendLog(level: Int(level), message: String(cString: message))
    }
    config.on_state = { ctx, state, detail in
      guard let ctx else { return }
      let module = Unmanaged<T3VpnTunnelModule>.fromOpaque(ctx).takeUnretainedValue()
      module.handleState(state, detail: detail.map { String(cString: $0) })
    }

    lock.lock()
    startPromise = promise
    state = "connecting"
    var started: OpaquePointer?
    let result = occore_start(&config, &started)
    if result != 0 {
      startPromise = nil
      state = "stopped"
      lock.unlock()
      promise.reject("ERR_VPN_START", String(cString: strerror(-result)))
      return
    }
    core = started
    lock.unlock()
  }

  private func appendLog(level: Int, message: String) {
    let line = "\(Self.timestamp.string(from: Date())) \(message)"
    Self.logger.log("\(line, privacy: .public)")
    lock.lock()
    logLines.append(line)
    if logLines.count > Self.maxLogLines { logLines.removeFirst(logLines.count - Self.maxLogLines) }
    lock.unlock()
    sendEvent("onLog", ["level": level, "message": line])
  }

  private func handleState(_ raw: Int32, detail: String?) {
    let name: String
    switch Int(raw) {
    case Int(OCCORE_CONNECTED.rawValue): name = "connected"
    case Int(OCCORE_STOPPED.rawValue): name = "stopped"
    default: name = "connecting"
    }

    lock.lock()
    state = name
    let promise = startPromise
    let port = core.map { Int(occore_local_port($0)) }
    if name != "connecting" { startPromise = nil }
    lock.unlock()

    if name == "connected", let port {
      promise?.resolve(["localPort": port])
    } else if name == "stopped" {
      promise?.reject("ERR_VPN_STOPPED", detail ?? "VPN tunnel stopped")
    }
    appendLog(level: 1, message: "State: \(name)\(detail.map { " · \($0)" } ?? "")")
    sendEvent("onState", ["state": name, "detail": detail as Any])
  }

  private func stop() {
    lock.lock()
    let current = core
    core = nil
    lock.unlock()
    // occore_stop joins the tunnel threads, which may still call handleState.
    if let current {
      lifecycleLock.lock()
      occore_stop(current)
      lifecycleLock.unlock()
    }
  }
}
