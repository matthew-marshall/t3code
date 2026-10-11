import type { ClientCapabilities } from "@t3tools/client-runtime/platform";
import * as SecureStore from "expo-secure-store";

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

let pendingStart: Promise<number> | null = null;

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
    return Promise.resolve(current.localPort);
  }
  pendingStart ??= native
    .start({
      gateway: config.gateway,
      cookie: config.cookie,
      targetHost: config.targetHost,
      targetPort: config.targetPort,
      os: config.os,
      ...(config.serverCertPin ? { serverCertPin: config.serverCertPin } : {}),
    })
    .then((result) => result.localPort)
    .finally(() => {
      pendingStart = null;
    });
  return pendingStart;
}
