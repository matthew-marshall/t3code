import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type ServerConfig,
  type T3ProjectFile,
  ThreadId,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import type { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type {
  InterruptThreadTurnInput,
  SettleThreadInput,
  UnsettleThreadInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  StartThreadTurnInput,
} from "../operations/commands.ts";
import { deriveThreadTitleSeed } from "../operations/threadTitle.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "../state/models.ts";
import {
  type AtomCommand,
  type AtomCommandResult,
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "../state/runtime.ts";
import type { VoiceAgentWorkspace, VoiceBranch, VoiceNewThreadPlan } from "./tools.ts";

type EnvironmentInput<I> = { readonly environmentId: EnvironmentId; readonly input: I };

/** The client's own atoms and commands the voice workspace is built from. */
export interface VoiceAgentWorkspaceSources {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly projectsAtom: Atom.Atom<ReadonlyArray<EnvironmentProject>>;
  readonly threadProjection: (
    target: EnvironmentInput<{ readonly threadId: ThreadId }>,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ThreadProjection, unknown>>;
  readonly startTurn: AtomCommand<EnvironmentInput<StartThreadTurnInput>, unknown, unknown>;
  readonly interruptTurn: AtomCommand<EnvironmentInput<InterruptThreadTurnInput>, unknown, unknown>;
  readonly settle: AtomCommand<EnvironmentInput<SettleThreadInput>, unknown, unknown>;
  readonly unsettle: AtomCommand<EnvironmentInput<UnsettleThreadInput>, unknown, unknown>;
  readonly respondToApproval: AtomCommand<
    EnvironmentInput<RespondToThreadApprovalInput>,
    unknown,
    unknown
  >;
  readonly respondToUserInput: AtomCommand<
    EnvironmentInput<RespondToThreadUserInputInput>,
    unknown,
    unknown
  >;
  readonly serverConfig: (environmentId: EnvironmentId) => ServerConfig | null;
  /** The project's checked-in t3.json, or null when it is missing, unreadable or invalid. */
  readonly readProjectFile: (project: EnvironmentProject) => Promise<T3ProjectFile | null>;
  readonly vcsStatus: (
    target: EnvironmentInput<{ readonly cwd: string; readonly includeRemote?: boolean }>,
  ) => Atom.Atom<AsyncResult.AsyncResult<VcsStatusResult | null, unknown>>;
  readonly vcsListRefs: (
    target: EnvironmentInput<VcsListRefsInput>,
  ) => Atom.Atom<AsyncResult.AsyncResult<VcsListRefsResult, unknown>>;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly openThread: (thread: EnvironmentThreadShell) => void;
  readonly creationSource: "web" | "mobile";
  readonly newId: () => string;
}

const describeFailure = (result: AtomCommandResult<unknown, unknown>, fallback: string) => {
  if (result._tag === "Success") return fallback;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
};

/**
 * Threads voice starts run with approval required, whatever the project's
 * default: the agent should not act on a misheard request unchecked.
 */
const VOICE_RUNTIME_MODE = "approval-required" as const;

/** Enough for the agent to match a spoken branch name against. */
const BRANCH_LIMIT = 100;

export function createVoiceAgentWorkspace(
  sources: VoiceAgentWorkspaceSources,
): VoiceAgentWorkspace {
  const { registry } = sources;
  const threads = () => registry.get(sources.threadShellsAtom);

  const run = async <I>(
    command: AtomCommand<EnvironmentInput<I>, unknown, unknown>,
    environmentId: EnvironmentId,
    input: I,
    fallback: string,
  ) => {
    const result = await runAtomCommand(
      registry,
      command,
      { environmentId, input },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw new Error(describeFailure(result, fallback));
  };

  /** The project's default model, else the one its latest thread used, else the machine's latest. */
  const modelForProject = (
    project: EnvironmentProject,
    configured: ModelSelection | null,
  ): ModelSelection => {
    if (configured) return configured;
    const recent = threads()
      .filter((thread) => thread.environmentId === project.environmentId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const fallback =
      recent.find((thread) => thread.projectId === project.id) ?? recent[0] ?? undefined;
    if (fallback === undefined) {
      throw new Error("This project has no default model yet. Start its first thread in the app.");
    }
    return fallback.modelSelection;
  };

  /** The checkout's current branch, which a new worktree branches from. */
  const currentBranch = async (project: EnvironmentProject): Promise<string> => {
    const result = await executeAtomQuery(
      registry,
      sources.vcsStatus({
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot, includeRemote: false },
      }),
      // Status is a live subscription; its first value is the current snapshot.
      { reportFailure: false, firstValue: true },
    );
    const branch = result._tag === "Success" ? (result.value?.refName ?? null) : null;
    if (branch === null) {
      throw new Error(
        "The project checkout is not on a branch, so there is nothing to base a worktree on.",
      );
    }
    return branch;
  };

  /** The checkout's local branches, the current one first. */
  const listBranches = async (
    project: EnvironmentProject,
    query: string | undefined,
  ): Promise<ReadonlyArray<VoiceBranch>> => {
    const result = await executeAtomQuery(
      registry,
      sources.vcsListRefs({
        environmentId: project.environmentId,
        input: {
          cwd: project.workspaceRoot,
          refKind: "local",
          limit: BRANCH_LIMIT,
          ...(query ? { query } : {}),
        },
      }),
      // Refs are a live subscription too; the first value is the current list.
      { reportFailure: false, firstValue: true },
    );
    if (result._tag === "Failure") {
      throw new Error(describeFailure(result, "Could not list the project's branches."));
    }
    return result.value.refs
      .filter((ref) => ref.isRemote !== true)
      .map((ref) => ({ name: ref.name, current: ref.current }))
      .sort((left, right) => Number(right.current) - Number(left.current));
  };

  /** Where and how a new thread would start, the way the app's new-task screen decides it. */
  const planNewThread = async (
    project: EnvironmentProject,
    worktree: boolean | undefined,
    baseBranch?: string,
  ): Promise<VoiceNewThreadPlan> => {
    const config = sources.serverConfig(project.environmentId);
    const projectFile = await sources.readProjectFile(project).catch(() => null);
    const resolved = resolveProjectSettings(
      config?.settings ?? DEFAULT_SERVER_SETTINGS,
      project.id,
      project,
      projectFile,
    );
    const defaultMode = resolveNewThreadEnvMode({
      projectSettings: resolved,
      workspaceRoot: project.workspaceRoot === "" ? null : project.workspaceRoot,
      newProjectsRoot: config?.newProjectsRoot,
      projectHasThreads: threads().some(
        (thread) =>
          thread.environmentId === project.environmentId && thread.projectId === project.id,
      ),
    });
    const mode =
      project.isScratch === true
        ? "local"
        : baseBranch !== undefined
          ? "worktree"
          : worktree === undefined
            ? defaultMode
            : worktree
              ? "worktree"
              : "local";
    if (baseBranch !== undefined && mode === "worktree") {
      // A misheard name must not become a new branch off nothing.
      const branches = await listBranches(project, baseBranch);
      if (!branches.some((branch) => branch.name === baseBranch)) {
        throw new Error(
          `There is no local branch named "${baseBranch}". Find its exact name with list_branches.`,
        );
      }
    }
    return {
      mode,
      baseBranch: mode === "worktree" ? (baseBranch ?? (await currentBranch(project))) : null,
      startFromOrigin: resolved.settings.newWorktreesStartFromOrigin,
      modelSelection: modelForProject(project, resolved.settings.defaultModelSelection),
    };
  };

  return {
    threads,
    projects: () => registry.get(sources.projectsAtom),
    environmentLabel: sources.environmentLabel,
    readThread: async (thread) => {
      const result = await executeAtomQuery(
        registry,
        sources.threadProjection({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        }),
        { refresh: true, reportFailure: false },
      );
      if (result._tag === "Failure") {
        throw new Error(describeFailure(result, "Could not read that thread."));
      }
      return result.value;
    },
    planNewThread: (project) => planNewThread(project, undefined),
    listBranches,
    startThread: async (project, message, { worktree, baseBranch }) => {
      const plan = await planNewThread(project, worktree, baseBranch);
      const { modelSelection } = plan;
      const threadId = ThreadId.make(sources.newId());
      const title = deriveThreadTitleSeed({ text: message, attachments: [] });
      const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
      await run(
        sources.startTurn,
        project.environmentId,
        {
          creationSource: sources.creationSource,
          threadId,
          message: {
            messageId: MessageId.make(sources.newId()),
            role: "user",
            text: message,
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode: VOICE_RUNTIME_MODE,
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection,
              runtimeMode: VOICE_RUNTIME_MODE,
              interactionMode: "default",
              branch: plan.baseBranch,
              worktreePath: null,
              createdAt,
            },
            // The same worktree the new-task screen prepares: a temporary
            // branch off the checkout's branch, renamed once the agent names it.
            ...(plan.mode === "worktree" && plan.baseBranch !== null
              ? {
                  prepareWorktree: {
                    projectCwd: project.workspaceRoot,
                    baseBranch: plan.baseBranch,
                    branch: buildTemporaryWorktreeBranchName(() => sources.newId()),
                    ...(plan.startFromOrigin ? { startFromOrigin: true } : {}),
                  },
                  runSetupScript: true,
                }
              : {}),
          },
          createdAt,
        },
        "Could not start the thread.",
      );
      return { threadId, plan };
    },
    sendMessage: (thread, message) =>
      run(
        sources.startTurn,
        thread.environmentId,
        {
          creationSource: sources.creationSource,
          threadId: thread.id,
          message: {
            messageId: MessageId.make(sources.newId()),
            role: "user",
            text: message,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        },
        "Could not send the message.",
      ),
    stopTurn: (thread) =>
      run(
        sources.interruptTurn,
        thread.environmentId,
        { threadId: thread.id },
        "Could not stop the thread.",
      ),
    setSettled: (thread, settled) =>
      settled
        ? run(
            sources.settle,
            thread.environmentId,
            { threadId: thread.id },
            "Could not settle the thread.",
          )
        : run(
            sources.unsettle,
            thread.environmentId,
            { threadId: thread.id, reason: "user" },
            "Could not reopen the thread.",
          ),
    respondToApproval: (thread, requestId, decision) =>
      run(
        sources.respondToApproval,
        thread.environmentId,
        { threadId: thread.id, requestId, decision },
        "Could not answer the request.",
      ),
    answerQuestion: (thread, requestId, answers) =>
      run(
        sources.respondToUserInput,
        thread.environmentId,
        { threadId: thread.id, requestId, answers },
        "Could not answer the question.",
      ),
    openThread: sources.openThread,
  };
}
