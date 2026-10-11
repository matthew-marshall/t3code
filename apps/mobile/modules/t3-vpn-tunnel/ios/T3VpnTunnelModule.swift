import ExpoModulesCore
import OCCore

struct VpnTunnelStartOptions: Record {
  @Field var gateway: String = ""
  @Field var cookie: String = ""
  @Field var targetHost: String = ""
  @Field var targetPort: Int = 0
  @Field var localPort: Int = 0
  @Field var serverCertPin: String?
  @Field var os: String = "linux"
}

// Wraps occore (native/occore.h). One tunnel per process; start() resolves with the
// local port once the tunnel is up, and onState reports later drops and reconnects.
public final class T3VpnTunnelModule: Module {
  private let lock = NSLock()
  private var core: OpaquePointer?
  private var startPromise: Promise?
  private var state = "stopped"

  public func definition() -> ModuleDefinition {
    Name("T3VpnTunnel")
    Events("onState", "onLog")

    AsyncFunction("start") { (options: VpnTunnelStartOptions, promise: Promise) in
      self.start(options, promise: promise)
    }

    AsyncFunction("stop") {
      self.stop()
    }

    Function("getState") { () -> [String: Any] in
      self.lock.lock()
      defer { self.lock.unlock() }
      return ["state": self.state, "localPort": self.core.map { Int(occore_local_port($0)) } as Any]
    }

    OnDestroy {
      self.stop()
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
    config.ctx = Unmanaged.passUnretained(self).toOpaque()
    config.log = { ctx, level, message in
      guard let ctx, let message else { return }
      let module = Unmanaged<T3VpnTunnelModule>.fromOpaque(ctx).takeUnretainedValue()
      module.sendEvent("onLog", ["level": Int(level), "message": String(cString: message)])
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
    sendEvent("onState", ["state": name, "detail": detail as Any])
  }

  private func stop() {
    lock.lock()
    let current = core
    core = nil
    lock.unlock()
    // occore_stop joins the tunnel threads, which may still call handleState.
    if let current { occore_stop(current) }
  }
}
