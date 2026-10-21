import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  native: {
    probe: vi.fn(),
    reopenListener: vi.fn(async () => ({ localPort: 51000 })),
  },
}));
vi.mock("./nativeVpnTunnel", () => ({ nativeVpnTunnel: mocks.native }));

import { diagnoseVpnTunnel, diagnosisVerdict, type VpnDiagnosis } from "./vpnDiagnosis";

const ok = { ms: 30 };
const timeout = { error: "timeout" };
const refused = { error: "refused" };
const healthy: VpnDiagnosis = {
  forward: ok,
  reopened: false,
  ping: ok,
  ssh: ok,
  t3: ok,
  t3Port: 3773,
};

describe("VPN diagnosis", () => {
  it("tells T3 not running apart from the workstation being away", () => {
    expect(diagnosisVerdict(healthy)).toContain("Everything answers");
    expect(diagnosisVerdict({ ...healthy, t3: refused })).toBe(
      "The workstation is up, but nothing listens on port 3773: T3 is not running.",
    );
    // SSH answering shows the machine is up even when ping is blocked.
    expect(diagnosisVerdict({ ...healthy, ping: timeout, t3: timeout })).toContain(
      "The workstation is up, but port 3773 does not answer",
    );
    expect(diagnosisVerdict({ ...healthy, ping: timeout, ssh: timeout, t3: timeout })).toContain(
      "The workstation does not answer",
    );
    expect(diagnosisVerdict({ ...healthy, forward: refused })).toContain("Restart the app");
    expect(diagnosisVerdict({ ...healthy, ping: { error: "down" } })).toBe(
      "The VPN tunnel is not connected yet.",
    );
  });

  it("reopens a local port iOS closed before checking the workstation", async () => {
    mocks.native.probe.mockImplementation(async (kind: string, port: number) => {
      if (kind === "forward") {
        return mocks.native.reopenListener.mock.calls.length === 0 ? refused : { ms: 1 };
      }
      return port === 3773 ? refused : { ms: 40 };
    });

    const diagnosis = await diagnoseVpnTunnel(3773);

    expect(diagnosis).toMatchObject({ reopened: true, forward: { ms: 1 }, ssh: { ms: 40 } });
    expect(mocks.native.probe.mock.calls.map(([kind, port]) => `${kind}:${port}`)).toEqual([
      "forward:0",
      "forward:0",
      "ping:0",
      "tcp:22",
      "tcp:3773",
    ]);
    expect(diagnosisVerdict(diagnosis)).toBe(
      "iOS had closed the app's local port; reopened it. The workstation is up, but nothing listens on port 3773: T3 is not running.",
    );
  });
});
