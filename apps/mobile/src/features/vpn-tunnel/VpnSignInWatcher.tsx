import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";
import { Alert, AppState } from "react-native";

import { voiceAgentController } from "../voice-agent/voiceAgentSession";
import { nativeVpnTunnel } from "./nativeVpnTunnel";
import {
  learnSignInExpiry,
  loadSignInExpiry,
  scheduleSignInWarning,
  signInStatus,
} from "./vpnSignIn";
import { loadVpnTunnelConfig, onSignInExpired } from "./vpnTunnel";

/** While the app is open, how often to see whether the sign-in is about to end. */
const CHECK_EVERY_MS = 5 * 60 * 1000;

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Tells a running voice session too, so the user hears it while driving. */
function tellVoiceAgent(text: string): void {
  if (voiceAgentController.getState().phase === "live") voiceAgentController.sendUpdate(text);
}

/**
 * Keeps the GlobalProtect sign-in from lapsing unnoticed: warns before it ends (a notification,
 * an in-app prompt, and the voice agent), and when the gateway refuses it, offers to sign in
 * instead of leaving T3 reconnecting. Renders nothing.
 */
export function VpnSignInWatcher() {
  const navigation = useNavigation();

  useEffect(() => {
    if (nativeVpnTunnel === null) return;
    let active = true;
    // Each sign-in (cookie) is warned about once, and its end prompted once.
    let warnedFor: string | undefined;
    let expiredFor: string | undefined;

    const openSignIn = () =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsVpnTunnelLogin" },
      });

    const promptExpired = async () => {
      const cookie = (await loadVpnTunnelConfig())?.cookie ?? "";
      if (!active || expiredFor === cookie) return;
      expiredFor = cookie;
      tellVoiceAgent(
        "The VPN sign-in expired, so the workstation is unreachable until the user signs in again in Settings → VPN Tunnel.",
      );
      Alert.alert("VPN sign-in expired", "Sign in again to reach the workstation.", [
        { text: "Not now", style: "cancel" },
        { text: "Sign in", onPress: openSignIn },
      ]);
    };

    const check = async () => {
      const config = await loadVpnTunnelConfig();
      if (!active || config === null) return;
      const status = signInStatus(config, await loadSignInExpiry(), Date.now());
      if (status.kind === "expiring" && warnedFor !== config.cookie) {
        warnedFor = config.cookie;
        const minutes = Math.max(1, Math.round((status.expiresAt - Date.now()) / 60_000));
        tellVoiceAgent(
          `The VPN sign-in expires at ${time(status.expiresAt)}, in about ${minutes} minutes. The user can sign in again in Settings → VPN Tunnel.`,
        );
        Alert.alert(
          "VPN sign-in expires soon",
          `It ends at ${time(status.expiresAt)}, in about ${minutes} min. Sign in again now to stay connected?`,
          [
            { text: "Later", style: "cancel" },
            { text: "Sign in", onPress: openSignIn },
          ],
        );
      }
    };

    // Each connection says when the sign-in ends; the warning is scheduled from it.
    const connected = nativeVpnTunnel.addListener("onState", (event) => {
      if (event.state !== "connected") return;
      const connectedAt = Date.now();
      void (async () => {
        const config = await loadVpnTunnelConfig();
        if (config === null) return;
        const expiry = (await learnSignInExpiry(config, connectedAt)) ?? (await loadSignInExpiry());
        await scheduleSignInWarning(config, expiry);
      })();
    });
    const expired = onSignInExpired(() => void promptExpired());
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") void check();
    });
    const interval = setInterval(() => void check(), CHECK_EVERY_MS);
    void check();

    return () => {
      active = false;
      connected.remove();
      expired();
      appState.remove();
      clearInterval(interval);
    };
  }, [navigation]);

  return null;
}
