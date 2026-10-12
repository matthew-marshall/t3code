import { DEFAULT_SERVER_SETTINGS, type ServerConfig, type T3ProjectFile } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { StartThreadTurnInput } from "../operations/commands.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "../state/models.ts";
import { createVoiceAgentWorkspace } from "./workspace.ts";

const MODEL = { instanceId: "codex", model: "gpt-6" };

const project = {
  id: "project-1",
  environmentId: "env-a",
  title: "Web app",
  workspaceRoot: "/repo",
  defaultModelSelection: MODEL,
} as unknown as EnvironmentProject;

const priorThread = {
  id: "t-1",
  environmentId: "env-a",
  projectId: "project-1",
  updatedAt: "2026-10-11T11:00:00.000Z",
  modelSelection: MODEL,
} as unknown as EnvironmentThreadShell;

function setup(options: {
  readonly envMode?: "local" | "worktree";
  readonly projectFile?: T3ProjectFile | null;
  readonly branch?: string | null;
}) {
  const sent: Array<StartThreadTurnInput> = [];
  const startTurn = {
    label: "start-turn",
    run: async (_registry: unknown, target: { readonly input: StartThreadTurnInput }) => {
      sent.push(target.input);
      return AsyncResult.success(undefined);
    },
  } as never;
  const unused = { label: "unused", run: async () => AsyncResult.success(undefined) } as never;
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    ...(options.envMode ? { defaultThreadEnvMode: options.envMode } : {}),
  };
  let ids = 0;
  const workspace = createVoiceAgentWorkspace({
    registry: AtomRegistry.make(),
    threadShellsAtom: Atom.make<ReadonlyArray<EnvironmentThreadShell>>([priorThread]),
    projectsAtom: Atom.make<ReadonlyArray<EnvironmentProject>>([project]),
    threadProjection: () => Atom.make(AsyncResult.initial()) as never,
    startTurn,
    interruptTurn: unused,
    settle: unused,
    unsettle: unused,
    respondToApproval: unused,
    respondToUserInput: unused,
    serverConfig: () => ({ settings }) as unknown as ServerConfig,
    readProjectFile: async () => options.projectFile ?? null,
    // Waiting, like the live status subscription, which stays open after its first snapshot.
    vcsStatus: () =>
      Atom.make(
        AsyncResult.success(
          options.branch === null ? null : ({ refName: options.branch ?? "main" } as never),
          { waiting: true },
        ),
      ),
    vcsListRefs: () =>
      Atom.make(
        AsyncResult.success(
          {
            refs: [
              { name: "main", current: true, isDefault: true, worktreePath: null },
              { name: "watchfree-imui", current: false, isDefault: false, worktreePath: null },
              {
                name: "origin/watchfree-imui",
                isRemote: true,
                current: false,
                isDefault: false,
                worktreePath: null,
              },
            ],
          } as never,
          { waiting: true },
        ),
      ),
    environmentLabel: () => null,
    openThread: () => {},
    creationSource: "mobile",
    newId: () => `0000000${++ids}-aaaa-bbbb-cccc-dddddddddddd`,
  });
  return { workspace, sent };
}

describe("createVoiceAgentWorkspace", () => {
  it("starts a thread in a new worktree off the checkout's branch when the project defaults to one", async () => {
    const { workspace, sent } = setup({ envMode: "worktree", branch: "main" });
    const { plan } = await workspace.startThread(project, "Add dark mode", {});

    expect(plan).toMatchObject({ mode: "worktree", baseBranch: "main" });
    expect(sent[0]!.runtimeMode).toBe("approval-required");
    expect(sent[0]!.bootstrap).toMatchObject({
      createThread: { projectId: "project-1", branch: "main", worktreePath: null },
      prepareWorktree: { projectCwd: "/repo", baseBranch: "main" },
      runSetupScript: true,
    });
    expect(sent[0]!.bootstrap!.prepareWorktree!.branch).toMatch(/^t3\/[0-9a-f]{8}$/);
  });

  it("lets the user's choice override the project default either way", async () => {
    const local = setup({ envMode: "worktree" });
    await local.workspace.startThread(project, "Fix the footer", { worktree: false });
    expect(local.sent[0]!.bootstrap!.prepareWorktree).toBeUndefined();
    expect(local.sent[0]!.bootstrap!.createThread).toMatchObject({ branch: null });

    const worktree = setup({ envMode: "local", branch: "release" });
    await worktree.workspace.startThread(project, "Hotfix", { worktree: true });
    expect(worktree.sent[0]!.bootstrap!.prepareWorktree).toMatchObject({ baseBranch: "release" });
  });

  it("starts a worktree off a named branch only when that branch exists", async () => {
    const { workspace, sent } = setup({ envMode: "local", branch: "main" });
    await expect(workspace.listBranches(project, undefined)).resolves.toEqual([
      { name: "main", current: true },
      { name: "watchfree-imui", current: false },
    ]);

    await workspace.startThread(project, "Port the player", { baseBranch: "watchfree-imui" });
    expect(sent[0]!.bootstrap!.prepareWorktree).toMatchObject({ baseBranch: "watchfree-imui" });

    await expect(
      workspace.startThread(project, "Port the player", { baseBranch: "watch-free-cpp" }),
    ).rejects.toThrow('no local branch named "watch-free-cpp"');
    expect(sent).toHaveLength(1);
  });

  it("follows a t3.json default when the environment sets none", async () => {
    const { workspace } = setup({
      projectFile: { defaultThreadEnvMode: "worktree" } as T3ProjectFile,
    });
    await expect(workspace.planNewThread(project)).resolves.toMatchObject({ mode: "worktree" });
  });

  it("refuses a worktree when the checkout is not on a branch", async () => {
    const { workspace, sent } = setup({ branch: null });
    await expect(workspace.startThread(project, "Anything", { worktree: true })).rejects.toThrow(
      "not on a branch",
    );
    expect(sent).toEqual([]);
  });
});
