import { requireOptionalNativeModule } from "expo";

interface EventSubscription {
  remove(): void;
}

export type VpnTunnelState = "connecting" | "connected" | "stopped";

export interface VpnTunnelStartOptions {
  readonly gateway: string;
  readonly cookie: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly serverCertPin?: string;
  readonly os: string;
}

interface NativeVpnTunnelModule {
  start(options: VpnTunnelStartOptions): Promise<{ readonly localPort: number }>;
  stop(): Promise<void>;
  getState(): { readonly state: VpnTunnelState; readonly localPort?: number };
  addListener(
    event: "onState",
    listener: (event: { readonly state: VpnTunnelState; readonly detail?: string }) => void,
  ): EventSubscription;
  addListener(
    event: "onLog",
    listener: (event: { readonly level: number; readonly message: string }) => void,
  ): EventSubscription;
}

/** The in-app GlobalProtect tunnel (modules/t3-vpn-tunnel). Null where it isn't built in. */
export const nativeVpnTunnel = requireOptionalNativeModule<NativeVpnTunnelModule>("T3VpnTunnel");
