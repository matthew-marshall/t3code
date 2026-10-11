import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeVoiceThreadUpdates,
  snapshotVoiceThreads,
  type VoiceThreadShell,
} from "./threadUpdates.ts";

function shell(
  id: string,
  state: { readonly running?: boolean; readonly pending?: "approval" | "question" } = {},
): VoiceThreadShell {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    runtime: {
      status: state.running ? "running" : "idle",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: null,
      lastError: null,
      updatedAt: "2026-10-11T00:00:00.000Z",
    },
    hasPendingApprovals: state.pending === "approval",
    hasPendingUserInput: state.pending === "question",
    archivedAt: null,
  };
}

describe("describeVoiceThreadUpdates", () => {
  it("announces threads that finish or start waiting on the user", () => {
    const previous = snapshotVoiceThreads([
      shell("a", { running: true }),
      shell("b", { running: true }),
      shell("c", { running: true }),
      shell("d"),
    ]);
    expect(
      describeVoiceThreadUpdates(previous, [
        shell("a"),
        shell("b", { running: true, pending: "approval" }),
        shell("c", { running: true, pending: "question" }),
        shell("d"),
      ]),
    ).toEqual([
      'Thread "Thread a" finished its turn.',
      'Thread "Thread b" is waiting for the user to approve an action.',
      'Thread "Thread c" asked the user a question.',
    ]);
  });

  it("does not repeat an update that was already true", () => {
    const previous = snapshotVoiceThreads([shell("a", { running: true, pending: "approval" })]);
    expect(
      describeVoiceThreadUpdates(previous, [shell("a", { running: true, pending: "approval" })]),
    ).toEqual([]);
  });

  it("only announces a new thread once it needs the user", () => {
    const previous = snapshotVoiceThreads([]);
    expect(describeVoiceThreadUpdates(previous, [shell("new", { running: true })])).toEqual([]);
    expect(describeVoiceThreadUpdates(previous, [shell("new", { pending: "question" })])).toEqual([
      'Thread "Thread new" asked the user a question.',
    ]);
  });
});
