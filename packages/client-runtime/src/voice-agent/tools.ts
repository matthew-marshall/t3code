import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadProjection,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";

import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "../state/models.ts";
import {
  derivePendingThreadRequests,
  type ThreadUserInputQuestion,
} from "../state/threadRequests.ts";
import type { VoiceAgentTool } from "./session.ts";

/**
 * What the voice tools read and do, built from the client's own state and
 * commands (see `createVoiceAgentWorkspace`). Every connected environment is
 * in reach; nothing here needs an environment to know about voice.
 */
export interface VoiceAgentWorkspace {
  readonly threads: () => ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: () => ReadonlyArray<EnvironmentProject>;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly readThread: (thread: EnvironmentThreadShell) => Promise<OrchestrationV2ThreadProjection>;
  /** Where a new thread in the project starts by default. */
  readonly planNewThread: (project: EnvironmentProject) => Promise<VoiceNewThreadPlan>;
  /** `worktree` overrides the project's default; undefined keeps it. */
  readonly startThread: (
    project: EnvironmentProject,
    message: string,
    worktree: boolean | undefined,
  ) => Promise<{ readonly threadId: ThreadId; readonly plan: VoiceNewThreadPlan }>;
  readonly sendMessage: (thread: EnvironmentThreadShell, message: string) => Promise<void>;
  readonly stopTurn: (thread: EnvironmentThreadShell) => Promise<void>;
  readonly respondToApproval: (
    thread: EnvironmentThreadShell,
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly answerQuestion: (
    thread: EnvironmentThreadShell,
    requestId: RuntimeRequestId,
    answers: ProviderUserInputAnswers,
  ) => Promise<void>;
  readonly openThread: (thread: EnvironmentThreadShell) => void;
}

/** Where and how a new thread starts, as the app's new-task screen would decide it. */
export interface VoiceNewThreadPlan {
  readonly mode: "local" | "worktree";
  /** The branch a new worktree starts from; null in the project checkout. */
  readonly baseBranch: string | null;
  readonly startFromOrigin: boolean;
  readonly modelSelection: ModelSelection;
}

const describeWorkspace = (plan: VoiceNewThreadPlan) =>
  plan.mode === "worktree"
    ? `a new worktree off ${plan.startFromOrigin ? "origin/" : ""}${plan.baseBranch}`
    : "the project checkout";

export const VOICE_AGENT_INSTRUCTIONS = `You are the voice interface for T3 Code, an app that runs coding agents (Codex, Claude, Cursor and others) in threads inside projects. The user is talking to you hands-free, often while driving or running, so:
- Keep replies to one or two short spoken sentences. Never read out code, file paths, IDs, or long lists; summarize instead.
- Refer to threads and projects by their titles. IDs are only for passing to tools.
- To start new work, find the project with list_projects and call plan_thread. Confirm in a few words, including where it will run (for example "Start that in a new worktree off main?"); the user may ask for a new worktree or the project checkout instead. Then call start_thread with the user's request as the message.
- To follow up on existing work, find the thread with list_threads, then use send_message. Use read_thread to tell the user what an agent said or what it is asking.
- Threads that need approval or have a question come first in list_threads. read_thread gives the request IDs.
- Before approving or denying a request, stopping a thread, or starting one, say in a few words what you are about to do and wait for the user to say yes. Never approve on your own judgment.
- If a request is ambiguous, ask one short clarifying question instead of guessing.
Messages that start with "[T3 update]" come from the app, not the user: mention them briefly when relevant.`;

const LIST_LIMIT = 10;
const MESSAGE_LIMIT = 6;
const MESSAGE_CHARS = 800;

type ThreadStatus = "needs approval" | "has a question" | "working" | "failed" | "idle";

function threadStatus(thread: EnvironmentThreadShell): ThreadStatus {
  if (thread.hasPendingApprovals) return "needs approval";
  if (thread.hasPendingUserInput) return "has a question";
  if (threadRuntimeIsActive(thread.runtime)) return "working";
  if (thread.runtime?.lastError) return "failed";
  return "idle";
}

const STATUS_RANK: Record<ThreadStatus, number> = {
  "needs approval": 0,
  "has a question": 0,
  working: 1,
  failed: 2,
  idle: 3,
};

const minutesAgo = (iso: string, now: number) =>
  Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

const stringArg = (args: Record<string, unknown>, name: string): string => {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

const matches = (query: string | undefined, ...values: ReadonlyArray<string | null>) =>
  query === undefined ||
  values.some((value) => value?.toLowerCase().includes(query.toLowerCase()) === true);

const optionalQuery = (args: Record<string, unknown>) =>
  typeof args.query === "string" && args.query.trim().length > 0 ? args.query.trim() : undefined;

/**
 * Turns spoken answers into the provider's answer format: an option's value
 * (or label) when one matches, else the text itself where custom answers are
 * allowed. Multi-select answers are comma separated.
 */
export function resolveVoiceAnswer(
  question: ThreadUserInputQuestion,
  answer: string,
): string | ReadonlyArray<string> {
  const parts = question.multiSelect ? answer.split(",") : [answer];
  const resolved = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const option = question.options.find(
        (candidate) =>
          candidate.label.toLowerCase() === part.toLowerCase() ||
          candidate.value?.toLowerCase() === part.toLowerCase(),
      );
      if (option !== undefined) return option.value ?? option.label;
      if (question.options.length > 0 && question.allowCustomAnswer === false) {
        throw new Error(
          `"${part}" is not an option for "${question.question}". Options: ${question.options
            .map((candidate) => candidate.label)
            .join(", ")}.`,
        );
      }
      return part;
    });
  if (resolved.length === 0) throw new Error(`No answer given for "${question.question}".`);
  return question.multiSelect ? resolved : resolved[0]!;
}

const APPROVAL_DECISIONS: Record<string, ProviderApprovalDecision> = {
  approve: "accept",
  approve_for_session: "acceptForSession",
  deny: "decline",
};

/** The tools the voice agent calls, over the client's own state and commands. */
export function createVoiceAgentTools(
  workspace: VoiceAgentWorkspace,
  now: () => number = Date.now,
): ReadonlyArray<VoiceAgentTool> {
  const environmentName = (environmentId: EnvironmentId) => {
    const environments = new Set(workspace.projects().map((project) => project.environmentId));
    // Only worth saying when there is more than one machine to tell apart.
    return environments.size > 1 ? workspace.environmentLabel(environmentId) : null;
  };
  const projectTitle = (thread: EnvironmentThreadShell) =>
    workspace
      .projects()
      .find(
        (project) =>
          project.id === thread.projectId && project.environmentId === thread.environmentId,
      )?.title ?? null;
  const findThread = (args: Record<string, unknown>) => {
    const threadId = stringArg(args, "threadId");
    const thread = workspace
      .threads()
      .find((candidate) => candidate.id === threadId && candidate.archivedAt === null);
    if (thread === undefined) throw new Error("No such thread. Use list_threads to find it.");
    return thread;
  };
  const findProject = (args: Record<string, unknown>) => {
    const projectId = stringArg(args, "projectId");
    const project = workspace.projects().find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("No such project. Use list_projects.");
    return project;
  };
  const pendingRequests = async (thread: EnvironmentThreadShell) =>
    derivePendingThreadRequests(await workspace.readThread(thread));

  const threadIdSchema = { type: "string", description: "From list_threads." };

  return [
    {
      declaration: {
        name: "list_threads",
        description:
          "Lists threads across the user's projects, those needing the user first, then working, then most recent.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words from the thread or project title." },
            needsAttention: {
              type: "boolean",
              description: "Only threads waiting on an approval or a question.",
            },
          },
        },
      },
      run: async (args) => {
        const query = optionalQuery(args);
        const threads = workspace
          .threads()
          .filter((thread) => thread.archivedAt === null)
          .filter((thread) => matches(query, thread.title, projectTitle(thread)))
          .filter(
            (thread) =>
              args.needsAttention !== true ||
              thread.hasPendingApprovals ||
              thread.hasPendingUserInput,
          )
          .sort(
            (left, right) =>
              STATUS_RANK[threadStatus(left)] - STATUS_RANK[threadStatus(right)] ||
              Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
          );
        return JSON.stringify({
          total: threads.length,
          threads: threads.slice(0, LIST_LIMIT).map((thread) => ({
            threadId: thread.id,
            title: thread.title,
            project: projectTitle(thread),
            environment: environmentName(thread.environmentId),
            status: threadStatus(thread),
            ...(thread.runtime?.lastError ? { error: clip(thread.runtime.lastError, 200) } : {}),
            updatedMinutesAgo: minutesAgo(thread.updatedAt, now()),
          })),
        });
      },
    },
    {
      declaration: {
        name: "list_projects",
        description: "Lists the user's projects, to start new threads in.",
        parametersJsonSchema: {
          type: "object",
          properties: { query: { type: "string", description: "Words from the project title." } },
        },
      },
      run: async (args) => {
        const query = optionalQuery(args);
        return JSON.stringify(
          workspace
            .projects()
            .filter((project) => project.isScratch !== true && matches(query, project.title))
            .map((project) => ({
              projectId: project.id,
              title: project.title,
              environment: environmentName(project.environmentId),
            })),
        );
      },
    },
    {
      declaration: {
        name: "read_thread",
        description:
          "Reads a thread's latest messages and anything it is waiting on: approval requests and questions, with their request IDs.",
        parametersJsonSchema: {
          type: "object",
          properties: { threadId: threadIdSchema },
          required: ["threadId"],
        },
      },
      run: async (args) => {
        const thread = findThread(args);
        const projection = await workspace.readThread(thread);
        const pending = derivePendingThreadRequests(projection);
        return JSON.stringify({
          title: thread.title,
          status: threadStatus(thread),
          messages: projection.messages
            .filter((message) => message.role !== "system" && message.text.trim().length > 0)
            .slice(-MESSAGE_LIMIT)
            .map((message) => ({
              from: message.role === "user" ? "user" : "agent",
              text: clip(message.text, MESSAGE_CHARS),
            })),
          approvals: pending.approvals
            .filter((approval) => approval.responseCapability === "live")
            .map((approval) => ({
              requestId: approval.requestId,
              kind: approval.requestKind,
              detail: approval.detail === undefined ? null : clip(approval.detail, 400),
              app: approval.appName ?? null,
            })),
          questions: pending.userInputs
            .filter((request) => request.responseCapability !== "not_resumable")
            .map((request) => ({
              requestId: request.requestId,
              questions: request.questions.map((question) => ({
                questionId: question.id,
                question: question.question,
                options: question.options.map((option) => option.label),
                multiSelect: question.multiSelect,
              })),
            })),
        });
      },
    },
    {
      declaration: {
        name: "plan_thread",
        description:
          "Says where a new thread in a project would run by default (a new worktree and its base branch, or the project checkout) and on which model.",
        parametersJsonSchema: {
          type: "object",
          properties: { projectId: { type: "string", description: "From list_projects." } },
          required: ["projectId"],
        },
      },
      run: async (args) => {
        const plan = await workspace.planNewThread(findProject(args));
        return JSON.stringify({
          runsIn: describeWorkspace(plan),
          model: plan.modelSelection.model,
        });
      },
    },
    {
      declaration: {
        name: "start_thread",
        description:
          "Starts a new thread in a project with the user's request as its first message, on the project's default model. Confirm with the user first.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "From list_projects." },
            message: { type: "string", description: "The request, in the user's words." },
            worktree: {
              type: "boolean",
              description:
                "true for a new worktree, false for the project checkout. Leave out to use the project's default from plan_thread.",
            },
          },
          required: ["projectId", "message"],
        },
      },
      run: async (args) => {
        const project = findProject(args);
        const worktree = typeof args.worktree === "boolean" ? args.worktree : undefined;
        const { threadId, plan } = await workspace.startThread(
          project,
          stringArg(args, "message"),
          worktree,
        );
        return JSON.stringify({ started: true, threadId, runsIn: describeWorkspace(plan) });
      },
    },
    {
      declaration: {
        name: "send_message",
        description:
          "Sends a follow-up message to a thread's agent. If it is working, the message goes in after the current turn.",
        parametersJsonSchema: {
          type: "object",
          properties: { threadId: threadIdSchema, message: { type: "string" } },
          required: ["threadId", "message"],
        },
      },
      run: async (args) => {
        await workspace.sendMessage(findThread(args), stringArg(args, "message"));
        return "Sent.";
      },
    },
    {
      declaration: {
        name: "stop_thread",
        description: "Stops the turn a thread's agent is running. Confirm with the user first.",
        parametersJsonSchema: {
          type: "object",
          properties: { threadId: threadIdSchema },
          required: ["threadId"],
        },
      },
      run: async (args) => {
        const thread = findThread(args);
        if (!threadRuntimeIsActive(thread.runtime)) return "That thread is not running.";
        await workspace.stopTurn(thread);
        return "Stopped.";
      },
    },
    {
      declaration: {
        name: "respond_to_approval",
        description:
          "Approves or denies an agent's request to run a command, change files, or use a tool. Only after reading the request to the user and hearing them say yes or no.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            threadId: threadIdSchema,
            requestId: { type: "string", description: "From read_thread." },
            decision: {
              type: "string",
              enum: Object.keys(APPROVAL_DECISIONS),
              description:
                "approve_for_session also allows requests like it for the rest of the session.",
            },
          },
          required: ["threadId", "requestId", "decision"],
        },
      },
      run: async (args) => {
        const thread = findThread(args);
        const decision = APPROVAL_DECISIONS[stringArg(args, "decision")];
        if (decision === undefined)
          throw new Error("decision must be approve, approve_for_session or deny.");
        const requestId = stringArg(args, "requestId");
        const approval = (await pendingRequests(thread)).approvals.find(
          (candidate) => candidate.requestId === requestId,
        );
        if (approval === undefined) return "That request is no longer pending.";
        if (approval.responseCapability !== "live") {
          return "That request can no longer be answered; the agent has moved on.";
        }
        await workspace.respondToApproval(thread, approval.requestId, decision);
        return decision === "decline" ? "Denied." : "Approved.";
      },
    },
    {
      declaration: {
        name: "answer_question",
        description:
          "Answers an agent's question. Pick an option by its label; separate several choices with commas.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            threadId: threadIdSchema,
            requestId: { type: "string", description: "From read_thread." },
            answers: {
              type: "array",
              items: {
                type: "object",
                properties: { questionId: { type: "string" }, answer: { type: "string" } },
                required: ["questionId", "answer"],
              },
            },
          },
          required: ["threadId", "requestId", "answers"],
        },
      },
      run: async (args) => {
        const thread = findThread(args);
        const requestId = stringArg(args, "requestId");
        const request = (await pendingRequests(thread)).userInputs.find(
          (candidate) => candidate.requestId === requestId,
        );
        if (request === undefined) return "That question is no longer pending.";
        if (request.responseCapability === "not_resumable") {
          return "That question can no longer be answered; the agent has moved on.";
        }
        const given = Array.isArray(args.answers) ? args.answers : [];
        const answers: Record<string, string | ReadonlyArray<string>> = {};
        for (const question of request.questions) {
          const entry = given.find(
            (candidate): candidate is { questionId: string; answer: string } =>
              typeof candidate === "object" &&
              candidate !== null &&
              candidate.questionId === question.id &&
              typeof candidate.answer === "string",
          );
          if (entry === undefined) {
            if (question.required === false) continue;
            throw new Error(`No answer given for "${question.question}".`);
          }
          answers[question.id] = resolveVoiceAnswer(question, entry.answer);
        }
        await workspace.answerQuestion(thread, request.requestId, answers);
        return "Answered.";
      },
    },
    {
      declaration: {
        name: "open_thread",
        description: "Shows a thread on the user's screen.",
        parametersJsonSchema: {
          type: "object",
          properties: { threadId: threadIdSchema },
          required: ["threadId"],
        },
      },
      run: async (args) => {
        workspace.openThread(findThread(args));
        return "Opened.";
      },
    },
  ];
}
