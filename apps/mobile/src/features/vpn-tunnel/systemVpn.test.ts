import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { state: string }) => void>(),
  native: {
    systemVpnAvailable: true,
    getSystemState: vi.fn(async () => "stopped"),
    startSystem: vi.fn(async () => {}),
    start: vi.fn(),
    addListener: vi.fn((event: string, listener: (event: { state: string }) => void) => {
      mocks.listeners.set(event, listener);
      return { remove: () => {} };
    }),
  },
}));

vi.mock("expo-secure-store", () => ({}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "00000000-0000-4000-8000-000000000000" }));
vi.mock("./nativeVpnTunnel", () => ({ nativeVpnTunnel: mocks.native }));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

import {
  ensureSystemVpn,
  isIPv4Address,
  onTunnelReachable,
  usesSystemVpn,
  type VpnTunnelConfig,
} from "./vpnTunnel";

const config: VpnTunnelConfig = {
  gateway: "gp.example.test",
  cookie: "authcookie=x",
  targetHost: "10.1.2.3",
  targetPort: 3773,
  os: "linux",
  background: true,
};

describe("the background (system) VPN", () => {
  beforeEach(() => {
    mocks.native.startSystem.mockClear();
    mocks.native.getSystemState.mockResolvedValue("stopped");
  });

  it("starts the system VPN once for concurrent connections, and leaves the in-app tunnel alone", async () => {
    await Promise.all([ensureSystemVpn(config), ensureSystemVpn(config)]);
    expect(mocks.native.startSystem).toHaveBeenCalledTimes(1);
    expect(mocks.native.startSystem).toHaveBeenCalledWith(
      expect.objectContaining({ gateway: "gp.example.test", targetHost: "10.1.2.3" }),
    );
    expect(mocks.native.start).not.toHaveBeenCalled();
  });

  it("does not restart a system VPN that is already connected", async () => {
    mocks.native.getSystemState.mockResolvedValue("connected");
    await ensureSystemVpn(config);
    expect(mocks.native.startSystem).not.toHaveBeenCalled();
  });

  it("is used only when turned on, and needs the workstation as an IPv4 address", () => {
    expect(usesSystemVpn(config)).toBe(true);
    expect(usesSystemVpn({ ...config, background: false })).toBe(false);
    expect(isIPv4Address("10.1.2.3")).toBe(true);
    expect(isIPv4Address("workstation.corp.example")).toBe(false);
    expect(isIPv4Address("10.1.2.300")).toBe(false);
  });

  it("has connections retry at once when either tunnel comes back up", () => {
    const retry = vi.fn();
    const unsubscribe = onTunnelReachable(retry);
    mocks.listeners.get("onState")?.({ state: "connecting" });
    expect(retry).not.toHaveBeenCalled();
    mocks.listeners.get("onState")?.({ state: "connected" });
    mocks.listeners.get("onSystemState")?.({ state: "connected" });
    expect(retry).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
