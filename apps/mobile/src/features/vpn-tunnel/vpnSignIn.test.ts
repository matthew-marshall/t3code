import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-notifications", () => ({}));
vi.mock("expo-secure-store", () => ({}));
vi.mock("./nativeVpnTunnel", () => ({ nativeVpnTunnel: null }));

import { signInStatus } from "./vpnSignIn";

const expiresAt = Date.parse("2026-10-14T22:27:00Z");
const config = { cookie: "authcookie=x" };
// What the gateway said: the sign-in ends at expiresAt, warn half an hour before.
const expiry = { cookie: "authcookie=x", expiresAt, warnBeforeSeconds: 1800 };

describe("VPN sign-in status", () => {
  it("is valid, then expiring within the warning window, then expired", () => {
    expect(signInStatus(config, expiry, expiresAt - 5 * 3_600_000)).toEqual({
      kind: "valid",
      expiresAt,
    });
    expect(signInStatus(config, expiry, expiresAt - 20 * 60_000)).toEqual({
      kind: "expiring",
      expiresAt,
    });
    expect(signInStatus(config, expiry, expiresAt + 1)).toEqual({ kind: "expired", expiresAt });
  });

  it("is unknown until the gateway has said, and for a new sign-in until it says again", () => {
    expect(signInStatus(config, null, expiresAt)).toEqual({ kind: "unknown" });
    expect(signInStatus({ cookie: "" }, expiry, expiresAt)).toEqual({ kind: "unknown" });
    expect(signInStatus({ cookie: "authcookie=new" }, expiry, expiresAt + 1)).toEqual({
      kind: "unknown",
    });
  });
});
