import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  appState: null as ((state: string) => void) | null,
  native: {
    getState: vi.fn(() => ({ state: "connected", localPort: 51000 })),
    start: vi.fn(),
    addListener: vi.fn(() => ({ remove: () => {} })),
    reopenListener: vi.fn(async () => ({ localPort: 51000 })),
  },
}));

vi.mock("expo-secure-store", () => ({}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "00000000-0000-4000-8000-000000000000" }));
vi.mock("./nativeVpnTunnel", () => ({ nativeVpnTunnel: mocks.native }));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.appState = listener;
      return { remove: () => {} };
    },
  },
}));

import { ensureVpnTunnel, type VpnTunnelConfig } from "./vpnTunnel";

const config: VpnTunnelConfig = {
  gateway: "gp.example.test",
  cookie: "authcookie=x",
  targetHost: "workstation.corp.example",
  targetPort: 3773,
  os: "linux",
};

describe("ensureVpnTunnel after the app was suspended", () => {
  beforeEach(() => {
    mocks.native.reopenListener.mockClear();
  });

  it("reopens the local forward once before the first connection after a trip to the background", async () => {
    await expect(ensureVpnTunnel(config)).resolves.toBe(51000);
    expect(mocks.native.reopenListener).not.toHaveBeenCalled();

    mocks.appState?.("background");
    mocks.appState?.("active");
    const [first, second] = await Promise.all([ensureVpnTunnel(config), ensureVpnTunnel(config)]);
    expect([first, second]).toEqual([51000, 51000]);
    // Connections racing on resume share one reopen.
    expect(mocks.native.reopenListener).toHaveBeenCalledTimes(1);

    await ensureVpnTunnel(config);
    expect(mocks.native.reopenListener).toHaveBeenCalledTimes(1);
  });

  it("reopens again after a reopen while the app was woken in the background", async () => {
    mocks.appState?.("background");
    // The VPN reconnected while the app was briefly woken, and the app was suspended again.
    await ensureVpnTunnel(config);
    expect(mocks.native.reopenListener).toHaveBeenCalledTimes(1);

    mocks.appState?.("active");
    await ensureVpnTunnel(config);
    expect(mocks.native.reopenListener).toHaveBeenCalledTimes(2);
    await ensureVpnTunnel(config);
    expect(mocks.native.reopenListener).toHaveBeenCalledTimes(2);
  });

  it("uses the port the forward reopened on, and retries the reopen if it failed", async () => {
    mocks.appState?.("background");
    mocks.native.reopenListener.mockRejectedValueOnce(new Error("timed out"));
    await expect(ensureVpnTunnel(config)).rejects.toThrow("timed out");

    mocks.native.reopenListener.mockResolvedValueOnce({ localPort: 52000 });
    await expect(ensureVpnTunnel(config)).resolves.toBe(52000);
    expect(mocks.native.reopenListener).toHaveBeenCalledTimes(2);
  });
});
