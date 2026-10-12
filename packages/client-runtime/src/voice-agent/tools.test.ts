import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentProject, EnvironmentThreadShell } from "../state/models.ts";
import { createVoiceAgentTools, excerpt, type VoiceAgentWorkspace } from "./tools.ts";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");

const thread = (
  overrides: Record<string, unknown> & { readonly id: string; readonly title: string },
) =>
  ({
    environmentId: "env-a",
    projectId: "project-1",
    runtime: null,
    latestRun: null,
    lastVisitedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    archivedAt: null,
    updatedAt: "2026-10-11T11:00:00.000Z",
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

const project = (id: string, title: string, environmentId = "env-a") =>
  ({ id, title, environmentId }) as unknown as EnvironmentProject;

const request = (id: string, kind: string, responseCapability = "live") => ({
  id,
  kind,
  status: "pending",
  responseCapability: { type: responseCapability },
  createdAt: DateTime.makeUnsafe(NOW),
});

function setup(projection: Partial<OrchestrationV2ThreadProjection> = {}) {
  const workspace = {
    threads: () => [
      thread({ id: "t-idle", title: "Refactor billing", updatedAt: "2026-10-11T11:50:00.000Z" }),
      thread({ id: "t-approval", title: "Fix login", hasPendingApprovals: true }),
      thread({ id: "t-old", title: "Archived work", archivedAt: "2026-10-01T00:00:00.000Z" }),
      thread({
        id: "t-done",
        title: "Bump dependencies",
        latestRun: { completedAt: "2026-10-11T11:40:00.000Z" },
        lastVisitedAt: "2026-10-11T11:00:00.000Z",
      }),
      thread({ id: "t-settled", title: "Old login spike", settledOverride: "settled" }),
    ],
    projects: () => [project("project-1", "Web app")],
    environmentLabel: () => "Workstation",
    readThread: vi.fn(async () => ({
      messages: [],
      runtimeRequests: [],
      turnItems: [],
      ...projection,
    })),
    startThread: vi.fn(async () => ({
      threadId: "t-new",
      plan: { mode: "worktree", baseBranch: "main", startFromOrigin: false },
    })),
    sendMessage: vi.fn(async () => {}),
    stopTurn: vi.fn(async () => {}),
    setSettled: vi.fn(async () => {}),
    respondToApproval: vi.fn(async () => {}),
    answerQuestion: vi.fn(async () => {}),
    openThread: vi.fn(),
  } as unknown as VoiceAgentWorkspace;
  const tools = createVoiceAgentTools(workspace, () => NOW);
  const call = (name: string, args: Record<string, unknown>) =>
    tools.find((tool) => tool.declaration.name === name)!.run(args);
  return { workspace, call };
}

describe("voice agent tools", () => {
  it("lists threads that need the user first and leaves out archived ones", async () => {
    const { call } = setup();
    const listed = JSON.parse(await call("list_threads", {}));
    expect(listed.threads.map((entry: { threadId: string }) => entry.threadId)).toEqual([
      "t-approval",
      "t-done",
      "t-idle",
    ]);
    expect(listed.threads[0]).toMatchObject({
      status: "needs approval",
      project: "Web app",
      // One machine: nothing to tell apart.
      environment: null,
      updatedMinutesAgo: 60,
    });
  });

  it("approves only a request that is still pending and answerable", async () => {
    const { workspace, call } = setup({
      runtimeRequests: [request("r-live", "command"), request("r-stale", "command", "message")],
      turnItems: [],
    } as unknown as Partial<OrchestrationV2ThreadProjection>);

    await expect(
      call("respond_to_approval", {
        threadId: "t-approval",
        requestId: "r-live",
        decision: "approve",
      }),
    ).resolves.toBe("Approved.");
    expect(workspace.respondToApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-approval" }),
      "r-live",
      "accept",
    );

    await expect(
      call("respond_to_approval", {
        threadId: "t-approval",
        requestId: "r-stale",
        decision: "deny",
      }),
    ).resolves.toContain("can no longer be answered");
    await expect(
      call("respond_to_approval", {
        threadId: "t-approval",
        requestId: "r-gone",
        decision: "deny",
      }),
    ).resolves.toBe("That request is no longer pending.");
    expect(workspace.respondToApproval).toHaveBeenCalledTimes(1);
  });

  it("answers a question with the chosen options' values", async () => {
    const { workspace, call } = setup({
      runtimeRequests: [request("q-1", "user_input")],
      turnItems: [
        {
          type: "user_input_request",
          requestId: "q-1",
          questions: [
            {
              id: "db",
              header: "Database",
              question: "Which database?",
              options: [
                { label: "Postgres", description: "SQL", value: "pg" },
                { label: "SQLite", description: "File" },
              ],
              allowCustomAnswer: false,
            },
            {
              id: "extras",
              header: "Extras",
              question: "Which extras?",
              options: [
                { label: "Auth", description: "" },
                { label: "Billing", description: "" },
              ],
              multiSelect: true,
            },
          ],
        },
      ],
    } as unknown as Partial<OrchestrationV2ThreadProjection>);

    await call("answer_question", {
      threadId: "t-idle",
      requestId: "q-1",
      answers: [
        { questionId: "db", answer: "postgres" },
        { questionId: "extras", answer: "Auth, billing" },
      ],
    });
    expect(workspace.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-idle" }),
      "q-1",
      { db: "pg", extras: ["Auth", "Billing"] },
    );

    await expect(
      call("answer_question", {
        threadId: "t-idle",
        requestId: "q-1",
        answers: [
          { questionId: "db", answer: "MySQL" },
          { questionId: "extras", answer: "Auth" },
        ],
      }),
    ).rejects.toThrow('"MySQL" is not an option');
  });

  it("asks the agent to look a thread up instead of guessing", async () => {
    const { call } = setup();
    await expect(call("send_message", { threadId: "t-old", message: "hi" })).rejects.toThrow(
      "Use list_threads",
    );
  });

  it("passes the user's worktree choice through and says where the thread runs", async () => {
    const { workspace, call } = setup();
    const started = JSON.parse(
      await call("start_thread", {
        projectId: "project-1",
        message: "Add dark mode",
        worktree: true,
      }),
    );
    expect(workspace.startThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-1" }),
      "Add dark mode",
      { worktree: true },
    );
    expect(started).toMatchObject({ threadId: "t-new", runsIn: "a new worktree off main" });

    await call("start_thread", { projectId: "project-1", message: "Fix the footer" });
    // Left out: the project's default decides.
    expect(workspace.startThread).toHaveBeenLastCalledWith(expect.anything(), "Fix the footer", {});

    await call("start_thread", {
      projectId: "project-1",
      message: "Port the player",
      baseBranch: " watchfree-imui ",
    });
    expect(workspace.startThread).toHaveBeenLastCalledWith(expect.anything(), "Port the player", {
      baseBranch: "watchfree-imui",
    });
  });

  it("reports the app's Done check, and keeps settled threads out unless asked or searched for", async () => {
    const { call } = setup();
    const active = JSON.parse(await call("list_threads", {}));
    expect(
      active.threads.find((entry: { threadId: string }) => entry.threadId === "t-done"),
    ).toMatchObject({
      status: "done",
    });
    expect(
      active.threads.some((entry: { threadId: string }) => entry.threadId === "t-settled"),
    ).toBe(false);

    const settled = JSON.parse(await call("list_threads", { include: "settled" }));
    expect(settled.threads).toEqual([
      expect.objectContaining({ threadId: "t-settled", settled: true }),
    ]);

    const searched = JSON.parse(await call("list_threads", { query: "login" }));
    expect(searched.threads.map((entry: { threadId: string }) => entry.threadId)).toEqual([
      "t-approval",
      "t-settled",
    ]);
  });

  it("settles and reopens threads", async () => {
    const { workspace, call } = setup();
    await expect(call("settle_thread", { threadId: "t-done" })).resolves.toBe("Settled.");
    expect(workspace.setSettled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-done" }),
      true,
    );
    await expect(call("settle_thread", { threadId: "t-settled" })).resolves.toBe(
      "That thread is already settled.",
    );
    await expect(call("reopen_thread", { threadId: "t-settled" })).resolves.toBe("Reopened.");
    expect(workspace.setSettled).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "t-settled" }),
      false,
    );
  });

  it("keeps the end of a long message, where an agent's question usually is", async () => {
    const long = `${"Context. ".repeat(900)}Should I also update the README?`;
    const earlier = `${"Earlier detail. ".repeat(100)}Done with step one?`;
    const { call } = setup({
      messages: [
        { role: "assistant", text: earlier },
        { role: "assistant", text: long },
      ],
      runtimeRequests: [],
      turnItems: [],
    } as unknown as Partial<OrchestrationV2ThreadProjection>);
    const read = JSON.parse(await call("read_thread", { threadId: "t-idle" }));
    expect(read.messages[1].text.endsWith("Should I also update the README?")).toBe(true);
    expect(read.messages[1].text).toContain("characters omitted");
    expect(read.messages[0].text.endsWith("Done with step one?")).toBe(true);
    expect(excerpt("short", 100)).toBe("short");
  });
});
