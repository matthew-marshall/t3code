import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";

import { nativeVpnTunnel } from "./nativeVpnTunnel";
import type { VpnTunnelConfig } from "./vpnTunnel";

const EXPIRY_KEY = "t3code.vpn-tunnel.sign-in-expiry";
const NOTIFICATION_ID = "t3code.vpn-tunnel.sign-in-expiring";
/** Warns this long before a sign-in ends when the gateway does not say. */
export const DEFAULT_WARN_BEFORE_SECONDS = 60 * 60;

/**
 * When a sign-in ends, as the gateway said on connecting, and how early to warn. Kept with the
 * cookie it is for, so a new sign-in does not inherit the old one's end.
 */
export interface SignInExpiry {
  readonly cookie: string;
  readonly expiresAt: number;
  readonly warnBeforeSeconds: number;
}

export type SignInStatus =
  | { readonly kind: "unknown" }
  | { readonly kind: "valid"; readonly expiresAt: number }
  | { readonly kind: "expiring"; readonly expiresAt: number }
  | { readonly kind: "expired"; readonly expiresAt: number };

/** Where the saved sign-in stands at `now`. */
export function signInStatus(
  config: Pick<VpnTunnelConfig, "cookie">,
  expiry: SignInExpiry | null,
  now: number,
): SignInStatus {
  if (config.cookie === "" || expiry === null || expiry.cookie !== config.cookie) {
    return { kind: "unknown" };
  }
  const { expiresAt } = expiry;
  if (now >= expiresAt) return { kind: "expired", expiresAt };
  if (now >= expiresAt - expiry.warnBeforeSeconds * 1000) return { kind: "expiring", expiresAt };
  return { kind: "valid", expiresAt };
}

export async function loadSignInExpiry(): Promise<SignInExpiry | null> {
  try {
    const raw = await SecureStore.getItemAsync(EXPIRY_KEY);
    return raw === null ? null : (JSON.parse(raw) as SignInExpiry);
  } catch {
    return null;
  }
}

/**
 * Saves when the sign-in ends, from what the gateway told the in-app tunnel as it connected: the
 * sign-in's remaining seconds, not its total. Returns it, or null when the gateway has not said.
 */
export async function learnSignInExpiry(
  config: Pick<VpnTunnelConfig, "cookie">,
  now: number,
): Promise<SignInExpiry | null> {
  const state = nativeVpnTunnel?.getState();
  const remainingSeconds = state?.sessionLifetime ?? 0;
  if (remainingSeconds <= 0 || config.cookie === "") return null;
  const notifyPrior = state?.lifetimeNotifyPrior ?? 0;
  const learned: SignInExpiry = {
    cookie: config.cookie,
    expiresAt: now + remainingSeconds * 1000,
    warnBeforeSeconds: notifyPrior > 0 ? notifyPrior : DEFAULT_WARN_BEFORE_SECONDS,
  };
  await SecureStore.setItemAsync(EXPIRY_KEY, JSON.stringify(learned));
  return learned;
}

/**
 * A notification when the sign-in is about to end, so it reaches the user with the app closed.
 * Replaces any earlier one; does nothing without notification permission.
 */
export async function scheduleSignInWarning(
  config: Pick<VpnTunnelConfig, "cookie">,
  expiry: SignInExpiry | null,
): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(NOTIFICATION_ID);
    const status = signInStatus(config, expiry, Date.now());
    if (status.kind !== "valid" || expiry === null) return;
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return;
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: {
        title: "VPN sign-in expires soon",
        body: `Open T3 Code and sign in again before ${new Date(status.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} to stay connected.`,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(status.expiresAt - expiry.warnBeforeSeconds * 1000),
      },
    });
  } catch {
    // The in-app prompt still warns when the app is opened.
  }
}
