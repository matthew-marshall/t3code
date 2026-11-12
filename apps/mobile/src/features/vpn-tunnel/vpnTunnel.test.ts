import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));
vi.mock("./nativeVpnTunnel", () => ({ nativeVpnTunnel: null }));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "00000000-0000-4000-8000-000000000000" }));

import {
  isTunnelTarget,
  parseGpclientCookieOutput,
  rewriteToTunnel,
  type VpnTunnelConfig,
} from "./vpnTunnel";

const config: VpnTunnelConfig = {
  gateway: "gp.example.test",
  cookie: "authcookie=x",
  targetHost: "Workstation.corp.example",
  targetPort: 3773,
  os: "linux",
};

describe("vpn tunnel endpoints", () => {
  it("matches the target host case-insensitively and by effective port", () => {
    expect(
      isTunnelTarget(
        {
          httpBaseUrl: "http://workstation.corp.example:3773/",
          wsBaseUrl: "ws://workstation.corp.example:3773/",
        },
        config,
      ),
    ).toBe(true);
    expect(
      isTunnelTarget(
        {
          httpBaseUrl: "http://workstation.corp.example/",
          wsBaseUrl: "ws://workstation.corp.example/",
        },
        config,
      ),
    ).toBe(false);
    expect(
      isTunnelTarget(
        {
          httpBaseUrl: "http://other.corp.example:3773/",
          wsBaseUrl: "ws://other.corp.example:3773/",
        },
        config,
      ),
    ).toBe(false);
    expect(
      isTunnelTarget(
        {
          httpBaseUrl: "https://workstation.corp.example/",
          wsBaseUrl: "wss://workstation.corp.example/",
        },
        { ...config, targetPort: 443 },
      ),
    ).toBe(true);
  });

  it("rewrites both URLs to the local forward and keeps paths", () => {
    expect(
      rewriteToTunnel(
        { httpBaseUrl: "http://10.1.2.3:3773/base/", wsBaseUrl: "ws://10.1.2.3:3773/base/" },
        49152,
      ),
    ).toEqual({
      httpBaseUrl: "http://127.0.0.1:49152/base/",
      wsBaseUrl: "ws://127.0.0.1:49152/base/",
    });
  });

  it("parses gpclient --cookie-only output", () => {
    expect(
      parseGpclientCookieOutput(
        "COOKIE='authcookie=abc&portal=p&user=me&computer=box'\nHOST='gw.example.test'\n",
      ),
    ).toEqual({
      cookie: "authcookie=abc&portal=p&user=me&computer=box",
      gateway: "gw.example.test",
    });
    expect(parseGpclientCookieOutput("COOKIE='x'")).toBeNull();
  });
});
