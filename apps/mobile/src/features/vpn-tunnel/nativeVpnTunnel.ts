import { requireOptionalNativeModule } from "expo";

interface EventSubscription {
  remove(): void;
}

export type VpnTunnelState = "connecting" | "connected" | "stopped";

/** The system VPN (the packet tunnel extension), as iOS reports it. */
export type SystemVpnState = "connecting" | "connected" | "disconnecting" | "stopped";

export interface VpnTunnelStartOptions {
  readonly gateway: string;
  readonly cookie: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly serverCertPin?: string;
  readonly os: string;
  /** Also the faster UDP (ESP) channel; off keeps to TLS. */
  readonly useEsp?: boolean;
}

interface NativeVpnTunnelModule {
  start(options: VpnTunnelStartOptions): Promise<{ readonly localPort: number }>;
  stop(): Promise<void>;
  getState(): { readonly state: VpnTunnelState; readonly localPort?: number };
  /**
   * Replaces the local forward's listening socket, which iOS reclaims while the app is
   * suspended. Missing from builds that predate it.
   */
  reopenListener?(): Promise<{ readonly localPort: number | null }>;
  /** Recent timestamped tunnel log lines, oldest first. */
  getLog(): ReadonlyArray<string>;
  /** Whether this build embeds the packet tunnel extension. Missing from older builds. */
  readonly systemVpnAvailable?: boolean;
  /** Starts the system VPN, asking once to allow it; resolves when connected. */
  startSystem(options: VpnTunnelStartOptions): Promise<void>;
  stopSystem(): Promise<void>;
  getSystemState(): Promise<SystemVpnState>;
  /** The extension's recent log lines; empty when it is not running. */
  getSystemLog(): Promise<ReadonlyArray<string>>;
  addListener(
    event: "onState",
    listener: (event: { readonly state: VpnTunnelState; readonly detail?: string }) => void,
  ): EventSubscription;
  addListener(
    event: "onLog",
    listener: (event: { readonly level: number; readonly message: string }) => void,
  ): EventSubscription;
  addListener(
    event: "onSystemState",
    listener: (event: { readonly state: SystemVpnState }) => void,
  ): EventSubscription;
}

/** The in-app GlobalProtect tunnel (modules/t3-vpn-tunnel). Null where it isn't built in. */
export const nativeVpnTunnel = requireOptionalNativeModule<NativeVpnTunnelModule>("T3VpnTunnel");
