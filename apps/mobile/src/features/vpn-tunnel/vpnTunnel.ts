import type { ClientCapabilities } from "@t3tools/client-runtime/platform";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import type { GpProfile } from "./globalProtect";
import { nativeVpnTunnel } from "./nativeVpnTunnel";

type DirectEndpoint = ClientCapabilities.DirectEndpoint;

const CONFIG_KEY = "t3code.vpn-tunnel.v1";
const HOST_ID_KEY = "t3code.vpn-tunnel.host-id";

/** One saved tunnel: connections to targetHost:targetPort go through the GlobalProtect gateway. */
export interface VpnTunnelConfig {
  /** Portal used by in-app sign-in. */
  readonly portal?: string;
  /** Gateway host[:port]; empty until signed in. */
  readonly gateway: string;
  /** Gateway cookie from in-app sign-in or `gpclient connect --cookie-only`; empty until signed in. */
  readonly cookie: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly serverCertPin?: string;
  /** Must match the OS the cookie was obtained with. */
  readonly os: string;
  /**
   * Run as a system VPN (the packet tunnel extension) that keeps working while the app is closed
   * and carries only targetHost, instead of the in-app tunnel. targetHost must be an IPv4 address.
   */
  readonly background?: boolean;
  /**
   * Also use GlobalProtect's faster UDP (ESP) channel. Off by default: it can die silently after
   * the phone sleeps, while TLS fails loudly and reconnects at once, and T3 does not need the speed.
   */
  readonly useEsp?: boolean;
  /** When the cookie was obtained, shown on the VPN page. */
  readonly signedInAt?: number;
}

export async function loadVpnTunnelConfig(): Promise<VpnTunnelConfig | null> {
  try {
    const raw = await SecureStore.getItemAsync(CONFIG_KEY);
    return raw === null ? null : (JSON.parse(raw) as VpnTunnelConfig);
  } catch {
    return null;
  }
}

/** Stable per-install GlobalProtect identity (the gateway sees it as the computer's host-id). */
export async function loadGpProfile(): Promise<GpProfile> {
  let hostId = await SecureStore.getItemAsync(HOST_ID_KEY);
  if (hostId === null) {
    hostId = uuidv4();
    await SecureStore.setItemAsync(HOST_ID_KEY, hostId);
  }
  return { hostId, computer: `t3-${hostId.slice(0, 8)}` };
}

export class VpnTunnelSignInRequiredError extends Error {
  constructor() {
    super("Sign in to the VPN in Settings → VPN Tunnel.");
  }
}

/** Reads COOKIE='...' and HOST='...' from `gpclient connect --cookie-only` output. */
export function parseGpclientCookieOutput(
  text: string,
): { readonly cookie: string; readonly gateway: string } | null {
  const value = (key: string) =>
    text.match(new RegExp(`^${key}='?([^'\\n]*)'?\\s*$`, "m"))?.[1]?.trim() ?? "";
  const cookie = value("COOKIE");
  const gateway = value("HOST");
  return cookie && gateway ? { cookie, gateway } : null;
}

export async function saveVpnTunnelConfig(config: VpnTunnelConfig | null): Promise<void> {
  await nativeVpnTunnel?.stop();
  // A running system VPN keeps the settings it started with; the next connection starts it anew.
  if (nativeVpnTunnel?.systemVpnAvailable) await nativeVpnTunnel.stopSystem();
  if (config === null) {
    await SecureStore.deleteItemAsync(CONFIG_KEY);
  } else {
    await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(config));
  }
}

function effectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80;
}

/** Whether the config runs as the system VPN, and this build can. */
export function usesSystemVpn(config: VpnTunnelConfig): boolean {
  return config.background === true && nativeVpnTunnel?.systemVpnAvailable === true;
}

export function isIPv4Address(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Whether an endpoint is the tunnel's target, i.e. should be routed through the tunnel. */
export function isTunnelTarget(endpoint: DirectEndpoint, config: VpnTunnelConfig): boolean {
  const url = new URL(endpoint.httpBaseUrl);
  return (
    url.hostname.toLowerCase() === config.targetHost.toLowerCase() &&
    effectivePort(url) === config.targetPort
  );
}

/** Points an endpoint at the tunnel's localhost forward. */
export function rewriteToTunnel(endpoint: DirectEndpoint, localPort: number): DirectEndpoint {
  const rewrite = (value: string) => {
    const url = new URL(value);
    url.hostname = "127.0.0.1";
    url.port = String(localPort);
    return url.toString();
  };
  return { httpBaseUrl: rewrite(endpoint.httpBaseUrl), wsBaseUrl: rewrite(endpoint.wsBaseUrl) };
}

const reachableListeners = new Set<() => void>();

/**
 * Called when connections through the tunnel can work again: it came up or reconnected, or the
 * user asked to retry. The app's connections retry at once instead of waiting out their backoff,
 * which grows to minutes while the tunnel is down.
 */
export function onTunnelReachable(listener: () => void): () => void {
  reachableListeners.add(listener);
  return () => reachableListeners.delete(listener);
}

export function retryTunnelConnections(): void {
  for (const listener of reachableListeners) listener();
}

const signInExpiredListeners = new Set<() => void>();

/** Called when the gateway refuses the saved sign-in, from either tunnel. */
export function onSignInExpired(listener: () => void): () => void {
  signInExpiredListeners.add(listener);
  return () => signInExpiredListeners.delete(listener);
}

const signInExpired = () => {
  for (const listener of signInExpiredListeners) listener();
};

/** How either tunnel words a refused sign-in. */
export const isSignInExpiredError = (message: string) =>
  message.includes("rejected the cookie") || message.includes("sign-in expired");

nativeVpnTunnel?.addListener("onState", (event) => {
  if (event.state === "connected") retryTunnelConnections();
  if (event.state === "stopped" && isSignInExpiredError(event.detail ?? "")) signInExpired();
});
if (nativeVpnTunnel?.systemVpnAvailable) {
  nativeVpnTunnel.addListener("onSystemState", (event) => {
    if (event.state === "connected") retryTunnelConnections();
  });
}

let pendingStart: Promise<number> | null = null;

// iOS reclaims a suspended app's listening sockets (Apple TN2277). The VPN reconnects by itself
// after the phone has been locked, but the tunnel's local forward stays dead, so every connection
// through it fails until the app is relaunched. After any trip to the background the next
// connection reopens the forward first. Doing it here rather than on the "active" event means it
// cannot race the app's own reconnect on returning to the foreground.
// iOS also wakes the app in the background for a moment, when the VPN reconnects. A forward
// reopened then can be reclaimed again before the app is next opened, so only a reopen in the
// foreground settles it.
let forwardMayBeReclaimed = false;
let inBackground = AppState.currentState === "background";
AppState.addEventListener("change", (state) => {
  inBackground = state === "background";
  if (inBackground) forwardMayBeReclaimed = true;
});

let pendingReopen: Promise<number> | null = null;

function reopenForward(native: NonNullable<typeof nativeVpnTunnel>, port: number): Promise<number> {
  if (!native.reopenListener) return Promise.resolve(port);
  pendingReopen ??= native
    .reopenListener()
    .then((result) => {
      forwardMayBeReclaimed = inBackground;
      return result.localPort ?? port;
    })
    .finally(() => {
      pendingReopen = null;
    });
  return pendingReopen;
}

let pendingSystemStart: Promise<void> | null = null;

/**
 * Starts the system VPN unless it is already up. iOS keeps it running, and reconnects it after
 * network changes, until it is turned off in Settings → VPN Tunnel.
 */
export function ensureSystemVpn(config: VpnTunnelConfig): Promise<void> {
  const native = nativeVpnTunnel;
  if (native === null || !native.systemVpnAvailable) {
    return Promise.reject(new Error("The background VPN is not built into this app."));
  }
  if (config.cookie === "" || config.gateway === "") {
    return Promise.reject(new VpnTunnelSignInRequiredError());
  }
  pendingSystemStart ??= native
    .getSystemState()
    .then((state) =>
      state === "connected"
        ? undefined
        : native.startSystem({
            gateway: config.gateway,
            cookie: config.cookie,
            targetHost: config.targetHost,
            targetPort: config.targetPort,
            os: config.os,
            ...(config.serverCertPin ? { serverCertPin: config.serverCertPin } : {}),
            useEsp: config.useEsp === true,
          }),
    )
    .catch((error: unknown) => {
      if (error instanceof Error && isSignInExpiredError(error.message)) signInExpired();
      throw error;
    })
    .finally(() => {
      pendingSystemStart = null;
    });
  return pendingSystemStart;
}

/** Starts the tunnel if needed and resolves with its local port. */
export function ensureVpnTunnel(config: VpnTunnelConfig): Promise<number> {
  const native = nativeVpnTunnel;
  if (native === null)
    return Promise.reject(new Error("The VPN tunnel is not built into this app."));
  if (config.cookie === "" || config.gateway === "") {
    return Promise.reject(new VpnTunnelSignInRequiredError());
  }
  const current = native.getState();
  if (current.state === "connected" && current.localPort !== undefined) {
    return forwardMayBeReclaimed
      ? reopenForward(native, current.localPort)
      : Promise.resolve(current.localPort);
  }
  pendingStart ??= native
    .start({
      gateway: config.gateway,
      cookie: config.cookie,
      targetHost: config.targetHost,
      targetPort: config.targetPort,
      os: config.os,
      ...(config.serverCertPin ? { serverCertPin: config.serverCertPin } : {}),
      useEsp: config.useEsp === true,
    })
    .then((result) => {
      // A newly started tunnel has a new forward.
      forwardMayBeReclaimed = false;
      return result.localPort;
    })
    .finally(() => {
      pendingStart = null;
    });
  return pendingStart;
}
