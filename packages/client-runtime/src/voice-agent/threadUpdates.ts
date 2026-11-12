import { type EnvironmentThreadShell, threadRuntimeIsActive } from "../state/models.ts";

/** What the voice agent is told about a thread; only changes to it are announced. */
export interface VoiceThreadSnapshot {
  readonly active: boolean;
  readonly needsApproval: boolean;
  readonly hasQuestion: boolean;
}

export type VoiceThreadSnapshots = ReadonlyMap<string, VoiceThreadSnapshot>;

export type VoiceThreadShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "title"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "archivedAt"
>;

const threadKey = (shell: VoiceThreadShell) => `${shell.environmentId}:${shell.id}`;

export function snapshotVoiceThreads(
  shells: ReadonlyArray<VoiceThreadShell>,
): VoiceThreadSnapshots {
  const snapshots = new Map<string, VoiceThreadSnapshot>();
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    snapshots.set(threadKey(shell), {
      active: threadRuntimeIsActive(shell.runtime),
      needsApproval: shell.hasPendingApprovals,
      hasQuestion: shell.hasPendingUserInput,
    });
  }
  return snapshots;
}

/**
 * Updates worth telling the agent between two snapshots: a thread finishing,
 * or starting to wait on the user. Threads absent from `previous` are new and
 * only announced once they need something.
 */
export function describeVoiceThreadUpdates(
  previous: VoiceThreadSnapshots,
  shells: ReadonlyArray<VoiceThreadShell>,
): ReadonlyArray<string> {
  const next = snapshotVoiceThreads(shells);
  const updates: Array<string> = [];
  for (const shell of shells) {
    const current = next.get(threadKey(shell));
    if (current === undefined) continue;
    const before = previous.get(threadKey(shell));
    const title = `"${shell.title}"`;
    if (current.needsApproval && !before?.needsApproval) {
      updates.push(`Thread ${title} is waiting for the user to approve an action.`);
    } else if (current.hasQuestion && !before?.hasQuestion) {
      updates.push(`Thread ${title} asked the user a question.`);
    } else if (before?.active && !current.active) {
      updates.push(`Thread ${title} finished its turn.`);
    }
  }
  return updates;
}
