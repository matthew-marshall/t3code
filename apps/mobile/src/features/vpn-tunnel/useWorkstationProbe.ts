import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";

import { nativeVpnTunnel } from "./nativeVpnTunnel";
import { usesSystemVpn, type VpnTunnelConfig } from "./vpnTunnel";

const PROBE_EVERY_MS = 5000;
const PROBE_TIMEOUT_MS = 4000;

export type WorkstationProbe =
  | { readonly kind: "idle"; readonly reason: string }
  | { readonly kind: "ok"; readonly ms: number; readonly status: number }
  | { readonly kind: "failed"; readonly error: string };

/** Where an HTTP request reaches the workstation: straight through the system VPN, or the forward. */
function probeUrl(config: VpnTunnelConfig): string | null {
  if (usesSystemVpn(config)) return `http://${config.targetHost}:${config.targetPort}/`;
  const state = nativeVpnTunnel?.getState();
  if (state?.state !== "connected" || state.localPort === undefined) return null;
  return `http://127.0.0.1:${state.localPort}/`;
}

/**
 * While the screen is shown, asks the T3 server on the workstation for its front page every few
 * seconds through the tunnel. Any HTTP answer means the network path works, which tells a VPN
 * problem apart from T3's own connection state.
 */
export function useWorkstationProbe(config: VpnTunnelConfig | null): WorkstationProbe {
  const [probe, setProbe] = useState<WorkstationProbe>({ kind: "idle", reason: "Not checked yet" });
  useFocusEffect(
    useCallback(() => {
      if (config === null) return;
      let active = true;
      const check = async () => {
        const url = probeUrl(config);
        if (url === null) {
          setProbe({ kind: "idle", reason: "The tunnel is not running" });
          return;
        }
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
        const startedAt = performance.now();
        try {
          const response = await fetch(url, { signal: abort.signal, cache: "no-store" });
          if (active) {
            setProbe({
              kind: "ok",
              ms: Math.round(performance.now() - startedAt),
              status: response.status,
            });
          }
        } catch (error) {
          if (active) {
            setProbe({
              kind: "failed",
              error: abort.signal.aborted
                ? `no answer in ${PROBE_TIMEOUT_MS / 1000} s`
                : error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        } finally {
          clearTimeout(timeout);
        }
      };
      void check();
      const interval = setInterval(() => void check(), PROBE_EVERY_MS);
      return () => {
        active = false;
        clearInterval(interval);
      };
    }, [config]),
  );
  return probe;
}
