import NetworkExtension
import OCCore
import os

/// The background path for the GlobalProtect tunnel: a system VPN that iOS keeps running while
/// T3 is closed. It runs occore in packet mode and routes only the T3 server's address through
/// the gateway. The app starts it with the gateway cookie in the start options and the rest in
/// the provider configuration (see T3VpnTunnelModule.startSystem).
final class PacketTunnelProvider: NEPacketTunnelProvider {
  private static let logger = Logger(subsystem: "T3PacketTunnel", category: "tunnel")
  private static let maxLogLines = 300
  private static let timestamp: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter
  }()

  private let lock = NSLock()
  private var core: OpaquePointer?
  private var startCompletion: ((Error?) -> Void)?
  private var stopping = false
  private var gatewayHost = ""
  private var targetHost = ""
  private var logLines: [String] = []

  private var packetFD: Int32 = -1
  private var readSource: DispatchSourceRead?
  private let packetQueue = DispatchQueue(label: "t3.packet-tunnel.packets")
  private var readingFromOS = false

  override func startTunnel(
    options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void
  ) {
    let configuration = (protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration
    guard let gateway = configuration?["gateway"] as? String,
      let target = configuration?["targetHost"] as? String,
      let cookie = options?["cookie"] as? String
    else {
      // iOS started it without the app, so there is no cookie to connect with.
      completionHandler(TunnelError("Open T3 Code to connect the VPN."))
      return
    }
    guard isIPv4(target) else {
      completionHandler(TunnelError("The background VPN needs the T3 server as an IPv4 address."))
      return
    }
    gatewayHost = gateway.split(separator: ":").first.map(String.init) ?? gateway
    targetHost = target
    let os = configuration?["os"] as? String ?? "linux"
    let pin = configuration?["serverCertPin"] as? String

    let strings = [gateway, cookie, os, pin ?? ""].map { strdup($0) }
    defer { strings.forEach { free($0) } }
    var config = occore_config()
    config.gateway = UnsafePointer(strings[0])
    config.cookie = UnsafePointer(strings[1])
    config.os = UnsafePointer(strings[2])
    config.server_cert_pin = pin == nil ? nil : UnsafePointer(strings[3])
    config.ctx = Unmanaged.passUnretained(self).toOpaque()
    config.log = { ctx, _, message in
      guard let ctx, let message else { return }
      Unmanaged<PacketTunnelProvider>.fromOpaque(ctx).takeUnretainedValue()
        .appendLog(String(cString: message))
    }
    config.on_state = { ctx, state, detail in
      guard let ctx else { return }
      Unmanaged<PacketTunnelProvider>.fromOpaque(ctx).takeUnretainedValue()
        .handleState(state, detail: detail.map { String(cString: $0) })
    }
    let onNetwork: occore_network_fn = { ctx, address, gatewayAddress, mtu, _, _, _ in
      guard let ctx, let address else { return }
      Unmanaged<PacketTunnelProvider>.fromOpaque(ctx).takeUnretainedValue()
        .applyNetwork(
          address: String(cString: address),
          gatewayAddress: gatewayAddress.map { String(cString: $0) } ?? "",
          mtu: Int(mtu))
    }

    lock.lock()
    startCompletion = completionHandler
    stopping = false
    var started: OpaquePointer?
    var fd: Int32 = -1
    let result = occore_start_packets(&config, onNetwork, &started, &fd)
    if result != 0 {
      startCompletion = nil
      lock.unlock()
      completionHandler(TunnelError("Could not start the VPN: \(String(cString: strerror(-result)))"))
      return
    }
    core = started
    packetFD = fd
    lock.unlock()
    readFromCore()
  }

  override func stopTunnel(
    with reason: NEProviderStopReason, completionHandler: @escaping () -> Void
  ) {
    appendLog("Stopping (reason \(reason.rawValue))")
    lock.lock()
    stopping = true
    let current = core
    core = nil
    lock.unlock()
    readSource?.cancel()
    readSource = nil
    // occore_stop joins the openconnect thread, which may still report state, then closes the
    // packet socket.
    if let current { occore_stop(current) }
    completionHandler()
  }

  /// The app reads the extension's log through its tunnel session: any message returns the lines.
  override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
    lock.lock()
    let lines = logLines
    lock.unlock()
    completionHandler?(try? JSONSerialization.data(withJSONObject: lines))
  }

  // MARK: - Network settings

  /// Called by occore when the gateway assigns the tunnel's address, again after a reconnect.
  private func applyNetwork(address: String, gatewayAddress: String, mtu: Int) {
    // iOS takes only a numeric address here, not the gateway's hostname.
    let settings = NEPacketTunnelNetworkSettings(
      tunnelRemoteAddress: gatewayAddress.isEmpty ? gatewayHost : gatewayAddress)
    let ipv4 = NEIPv4Settings(addresses: [address], subnetMasks: ["255.255.255.255"])
    // Only the T3 server goes through the gateway; everything else stays on the phone's network.
    ipv4.includedRoutes = [NEIPv4Route(destinationAddress: targetHost, subnetMask: "255.255.255.255")]
    settings.ipv4Settings = ipv4
    settings.mtu = NSNumber(value: mtu)

    let done = DispatchSemaphore(value: 0)
    setTunnelNetworkSettings(settings) { [weak self] error in
      if let error, let self {
        // Without settings nothing is routed, so connected would be a lie.
        self.appendLog("Could not apply network settings: \(error.localizedDescription)")
        self.cancelTunnelWithError(error)
      }
      done.signal()
    }
    // occore marks the tunnel connected when this returns, so wait for iOS to take the settings.
    done.wait()
    readFromOS()
  }

  // MARK: - Packets

  /// Packets the gateway sent: occore frames each with a 4-byte address family.
  private func readFromCore() {
    let source = DispatchSource.makeReadSource(fileDescriptor: packetFD, queue: packetQueue)
    var buffer = [UInt8](repeating: 0, count: 65_539)
    source.setEventHandler { [weak self] in
      guard let self else { return }
      var packets: [Data] = []
      var protocols: [NSNumber] = []
      while true {
        let count = buffer.withUnsafeMutableBytes { recv(self.packetFD, $0.baseAddress, $0.count, 0) }
        if count <= 4 { break }
        let family = Int32(UInt32(bigEndian: buffer.withUnsafeBytes { $0.load(as: UInt32.self) }))
        packets.append(Data(buffer[4..<count]))
        protocols.append(NSNumber(value: family))
      }
      if !packets.isEmpty { self.packetFlow.writePackets(packets, withProtocols: protocols) }
    }
    source.resume()
    readSource = source
  }

  /// Packets from the phone to the T3 server, handed to occore with their address family.
  private func readFromOS() {
    lock.lock()
    if readingFromOS {
      lock.unlock()
      return
    }
    readingFromOS = true
    lock.unlock()
    readNextFromOS()
  }

  private func readNextFromOS() {
    packetFlow.readPackets { [weak self] packets, protocols in
      guard let self else { return }
      self.lock.lock()
      let fd = self.stopping ? -1 : self.packetFD
      self.lock.unlock()
      guard fd >= 0 else { return }
      for (packet, family) in zip(packets, protocols) {
        var framed = Data(count: 4)
        framed.withUnsafeMutableBytes { $0.storeBytes(of: UInt32(family.int32Value).bigEndian, as: UInt32.self) }
        framed.append(packet)
        _ = framed.withUnsafeBytes { send(fd, $0.baseAddress, $0.count, 0) }
      }
      self.readNextFromOS()
    }
  }

  // MARK: - State and log

  private func handleState(_ raw: Int32, detail: String?) {
    let name =
      Int(raw) == Int(OCCORE_CONNECTED.rawValue)
      ? "connected" : Int(raw) == Int(OCCORE_STOPPED.rawValue) ? "stopped" : "connecting"
    appendLog("State: \(name)\(detail.map { " · \($0)" } ?? "")")
    lock.lock()
    let completion = startCompletion
    let stopping = self.stopping
    if Int(raw) != Int(OCCORE_CONNECTING.rawValue) { startCompletion = nil }
    lock.unlock()

    switch Int(raw) {
    case Int(OCCORE_CONNECTED.rawValue):
      completion?(nil)
    case Int(OCCORE_STOPPED.rawValue):
      let error = TunnelError(
        detail == "gateway rejected the cookie"
          ? "The VPN sign-in expired. Sign in again in T3 Code." : "The VPN stopped: \(detail ?? "unknown")")
      if let completion {
        completion(error)
      } else if !stopping {
        cancelTunnelWithError(error)
      }
    default:
      break
    }
  }

  private func appendLog(_ message: String) {
    let line = "\(Self.timestamp.string(from: Date())) \(message)"
    Self.logger.log("\(line, privacy: .public)")
    lock.lock()
    logLines.append(line)
    if logLines.count > Self.maxLogLines { logLines.removeFirst(logLines.count - Self.maxLogLines) }
    lock.unlock()
  }
}

private struct TunnelError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/// The route is a single host, so the target must be an IPv4 literal.
private func isIPv4(_ text: String) -> Bool {
  var addr = in_addr()
  return inet_pton(AF_INET, text, &addr) == 1
}
