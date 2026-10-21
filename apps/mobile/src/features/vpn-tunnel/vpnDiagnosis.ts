import { nativeVpnTunnel } from "./nativeVpnTunnel";

/** SSH is open on the workstation, so it shows the machine is up even when T3 is not. */
export const SSH_PORT = 22;
const PROBE_TIMEOUT_MS = 3000;
const FORWARD_TIMEOUT_MS = 1000;

/** A round trip in ms, or why there was none: "timeout", "refused", "unresolved", "down", … */
export type ProbeOutcome = { readonly ms: number } | { readonly error: string };

export interface VpnDiagnosis {
  /** The app's local port into the tunnel, after reopening it when it refused. */
  readonly forward: ProbeOutcome;
  /** Whether the local port refused at first and was reopened. */
  readonly reopened: boolean;
  readonly ping: ProbeOutcome;
  readonly ssh: ProbeOutcome;
  readonly t3: ProbeOutcome;
  readonly t3Port: number;
}

const answered = (outcome: ProbeOutcome) => "ms" in outcome;
const failedWith = (outcome: ProbeOutcome, error: string) =>
  "error" in outcome && outcome.error === error;

/** One check's result as a short line. */
export function describeProbe(outcome: ProbeOutcome, answer = "answered"): string {
  if ("ms" in outcome) return `${answer} · ${outcome.ms} ms`;
  switch (outcome.error) {
    case "timeout":
      return "no answer";
    case "refused":
      return "refused";
    case "unresolved":
      return "the name did not resolve through the VPN";
    case "down":
      return "the tunnel is not connected";
    default:
      return outcome.error;
  }
}

/** What the checks together say is wrong, in a sentence. */
export function diagnosisVerdict(diagnosis: VpnDiagnosis): string {
  const { forward, reopened, ping, ssh, t3, t3Port } = diagnosis;
  const fixedForward =
    reopened && answered(forward) ? "iOS had closed the app's local port; reopened it. " : "";
  if ([ping, ssh, t3].some((outcome) => failedWith(outcome, "down"))) {
    return "The VPN tunnel is not connected yet.";
  }
  if ([ping, ssh, t3].some((outcome) => failedWith(outcome, "unresolved"))) {
    return "The workstation's name does not resolve through the VPN.";
  }
  if (answered(t3)) {
    return answered(forward)
      ? `${fixedForward}Everything answers. If T3 still cannot connect, retry connections.`
      : "The T3 server answers through the VPN, but the app's local port does not. Restart the app.";
  }
  const machineUp = answered(ping) || answered(ssh);
  if (failedWith(t3, "refused")) {
    return `${fixedForward}The workstation is up, but nothing listens on port ${t3Port}: T3 is not running.`;
  }
  if (machineUp) {
    return `${fixedForward}The workstation is up, but port ${t3Port} does not answer: T3 may be hung, or a firewall blocks the port.`;
  }
  return `${fixedForward}The workstation does not answer: it may be asleep, off or off the network, or the VPN is not passing traffic.`;
}

const probe = async (
  kind: "ping" | "tcp" | "forward",
  port: number,
  timeoutMs: number,
): Promise<ProbeOutcome> => {
  if (!nativeVpnTunnel?.probe) return { error: "not built into this app" };
  try {
    return await nativeVpnTunnel.probe(kind, port, timeoutMs);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Checks each step from the app to T3 on the workstation through the in-app tunnel: the local
 * port, then ping, SSH and the T3 port. A local port iOS has closed is reopened on the way. The
 * native side logs each result, so they show in the tunnel and device logs.
 */
export async function diagnoseVpnTunnel(t3Port: number): Promise<VpnDiagnosis> {
  let forward = await probe("forward", 0, FORWARD_TIMEOUT_MS);
  let reopened = false;
  if (failedWith(forward, "refused") && nativeVpnTunnel?.reopenListener) {
    reopened = await nativeVpnTunnel.reopenListener().then(
      () => true,
      () => false,
    );
    if (reopened) forward = await probe("forward", 0, FORWARD_TIMEOUT_MS);
  }
  // The core runs one probe at a time.
  const ping = await probe("ping", 0, PROBE_TIMEOUT_MS);
  const ssh = await probe("tcp", SSH_PORT, PROBE_TIMEOUT_MS);
  const t3 = await probe("tcp", t3Port, PROBE_TIMEOUT_MS);
  return { forward, reopened, ping, ssh, t3, t3Port };
}
