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
import { threadHasUnseenCompletion } from "../state/threadInbox.ts";
import {
  derivePendingThreadRequests,
  type ThreadUserInputQuestion,
} from "../state/threadRequests.ts";
import type { VoiceDictationStore } from "./dictation.ts";
import type { VoiceAgentMode } from "./liveProtocol.ts";
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
  /** The project checkout's local branches, the current one first; `query` narrows them. */
  readonly listBranches: (
    project: EnvironmentProject,
    query: string | undefined,
  ) => Promise<ReadonlyArray<VoiceBranch>>;
  /**
   * `worktree` overrides the project's default; undefined keeps it. A `baseBranch` must be an
   * existing local branch, and starts a new worktree off it.
   */
  readonly startThread: (
    project: EnvironmentProject,
    message: string,
    options: { readonly worktree?: boolean; readonly baseBranch?: string },
  ) => Promise<{ readonly threadId: ThreadId; readonly plan: VoiceNewThreadPlan }>;
  readonly sendMessage: (thread: EnvironmentThreadShell, message: string) => Promise<void>;
  readonly stopTurn: (thread: EnvironmentThreadShell) => Promise<void>;
  /** Settles a thread (moves it out of the active list), or reopens a settled one. */
  readonly setSettled: (thread: EnvironmentThreadShell, settled: boolean) => Promise<void>;
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

export interface VoiceBranch {
  readonly name: string;
  readonly current: boolean;
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
- Speak only your reply: never your reasoning, notes to yourself, or markdown. Say each thing once.
- Refer to threads and projects by their titles. IDs are only for passing to tools.
- To start new work, first collect three things. The project: find it with list_projects. The task: what the new thread's agent should do, as a full request in the user's words; a branch, title or project name alone is not a task, so ask for one. Where it runs: plan_thread gives the project's default; the user may ask for a new worktree or the project checkout instead, and if they name a branch, find its exact name with list_branches and start a new worktree off it.
- Then read all three back in one sentence, for example "Start a thread in halfos to port the player to C++, in a new worktree off watchfree-imui?", and call start_thread only after the user says yes to that summary. If the user changes anything, read back the corrected summary and wait for yes again: a correction is not a yes.
- To follow up on existing work, find the thread with list_threads, then use send_message. Use read_thread to tell the user what an agent said or what it is asking.
- Threads that need approval or have a question come first in list_threads. read_thread gives the request IDs.
- A thread's status "done" means it finished and the user has not looked at it yet (the green Done check in the app). "Settled" threads are finished work moved out of the active list; list_threads leaves them out unless asked for, or when searching. settle_thread and reopen_thread move threads between the two.
- Before approving or denying a request, stopping a thread, or starting one, say in a few words what you are about to do and wait for the user to say yes. Never approve on your own judgment.
- If a request is ambiguous, ask one short clarifying question instead of guessing.
- When the user wants to dictate or say something long, call start_dictation, say only "Go ahead" or similar, and then stay silent. The transcript arrives as a "[T3 dictation dN]" message: unless it is clear what it is for, ask. To send it or start a thread with it, pass its dictationId instead of retyping it; read the summary back as usual before starting a thread.
- If the user asks you to stop listening, or to listen again, call set_listening_mode.
- Only say an action worked after its tool returned success. If a tool failed or its outcome is unknown, say so, and check with list_threads or read_thread before trying again.
Messages that start with "[T3 update]" come from the app, not the user: mention them briefly when relevant.`;

const LIST_LIMIT = 10;
const MESSAGE_LIMIT = 6;
/** Earlier messages are context; the latest is usually what the user is asking about. */
const MESSAGE_CHARS = 800;
const LATEST_MESSAGE_CHARS = 6_000;

type ThreadStatus = "needs approval" | "has a question" | "working" | "failed" | "done" | "idle";

function threadStatus(thread: EnvironmentThreadShell): ThreadStatus {
  if (thread.hasPendingApprovals) return "needs approval";
  if (thread.hasPendingUserInput) return "has a question";
  if (threadRuntimeIsActive(thread.runtime)) return "working";
  if (thread.runtime?.lastError) return "failed";
  // The app's green Done check: finished, and not opened since.
  if (threadHasUnseenCompletion(thread)) return "done";
  return "idle";
}

const STATUS_RANK: Record<ThreadStatus, number> = {
  "needs approval": 0,
  "has a question": 0,
  working: 1,
  failed: 2,
  done: 2,
  idle: 3,
};

const isSettled = (thread: EnvironmentThreadShell) => thread.settledOverride === "settled";

const isSnoozed = (thread: EnvironmentThreadShell, now: number) =>
  thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now;

type ListScope = "active" | "settled" | "all";

const minutesAgo = (iso: string, now: number) =>
  Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/**
 * Shortens a message to `limit` characters keeping its start and its end, where agents usually
 * put their question or conclusion, and says how much was left out.
 */
export function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)} … [${omitted} characters omitted] … ${text.slice(-tail)}`;
}

const stringArg = (args: Record<string, unknown>, name: string): string => {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

/** What the session lets its tools control. */
export interface VoiceAgentSessionControls {
  readonly dictation?: VoiceAgentDictationTools;
  /** Switches listening mode once the agent is quiet; returns what the agent is told. */
  readonly setListeningMode?: (mode: VoiceAgentMode) => string;
}

/** Dictation as the tools see it: the saved transcripts, and a way to start one. */
export interface VoiceAgentDictationTools {
  readonly store: VoiceDictationStore;
  /** Starts dictation once the agent is quiet; returns what the agent is told. */
  readonly request: () => string;
}

const dictationIdSchema = {
  type: "string",
  description:
    'A dictation to use as the message instead of "message": its ID from a [T3 dictation] message, or "latest".',
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
  controls: VoiceAgentSessionControls = {},
): ReadonlyArray<VoiceAgentTool> {
  const { dictation, setListeningMode } = controls;
  /** "message", or the text of the dictation "dictationId" names. */
  const messageArg = (args: Record<string, unknown>): string => {
    if (typeof args.dictationId === "string" && args.dictationId.trim()) {
      const saved = dictation?.store.get(args.dictationId);
      if (!saved) throw new Error(`There is no dictation "${args.dictationId}".`);
      return saved.text;
    }
    return stringArg(args, "message");
  };
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
          "Lists threads across the user's projects, those needing the user first, then working, then done or failed, then most recent.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words from the thread or project title." },
            needsAttention: {
              type: "boolean",
              description: "Only threads waiting on an approval or a question.",
            },
            include: {
              type: "string",
              enum: ["active", "settled", "all"],
              description:
                "Which threads: the active list (default), settled ones, or both. A search covers all unless this is given.",
            },
          },
        },
      },
      run: async (args) => {
        const query = optionalQuery(args);
        const scope: ListScope =
          args.include === "active" || args.include === "settled" || args.include === "all"
            ? args.include
            : query === undefined
              ? "active"
              : "all";
        const threads = workspace
          .threads()
          .filter((thread) => thread.archivedAt === null)
          .filter((thread) =>
            scope === "all" ? true : scope === "settled" ? isSettled(thread) : !isSettled(thread),
          )
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
            ...(isSettled(thread) ? { settled: true } : {}),
            ...(isSnoozed(thread, now()) ? { snoozed: true } : {}),
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
            .map((message, index, recent) => ({
              from: message.role === "user" ? "user" : "agent",
              text: excerpt(
                message.text,
                index === recent.length - 1 ? LATEST_MESSAGE_CHARS : MESSAGE_CHARS,
              ),
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
        name: "list_branches",
        description:
          "Lists the local branches in a project's checkout, the current one first, to find the exact name of a branch the user mentions.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "From list_projects." },
            query: {
              type: "string",
              description:
                "Part of the name to narrow the list. Leave out to list them all, since a spoken name rarely matches exactly.",
            },
          },
          required: ["projectId"],
        },
      },
      run: async (args) => {
        const query =
          typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined;
        const branches = await workspace.listBranches(findProject(args), query);
        return JSON.stringify({
          current: branches.find((branch) => branch.current)?.name ?? null,
          branches: branches.map((branch) => branch.name),
        });
      },
    },
    {
      declaration: {
        name: "start_thread",
        description:
          "Starts a new thread in a project with the user's request as its first message, on the project's default model. Only after the user said yes to a read-back of the project, the task and where it runs.",
        parametersJsonSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "From list_projects." },
            message: {
              type: "string",
              description:
                "The task for the new thread's agent: the user's full request, in their words.",
            },
            dictationId: dictationIdSchema,
            worktree: {
              type: "boolean",
              description:
                "true for a new worktree, false for the project checkout. Leave out to use the project's default from plan_thread.",
            },
            baseBranch: {
              type: "string",
              description:
                "The exact name of a local branch, from list_branches, to start a new worktree off. Leave out for the checkout's current branch.",
            },
          },
          required: ["projectId"],
        },
      },
      run: async (args) => {
        const project = findProject(args);
        const { threadId, plan } = await workspace.startThread(project, messageArg(args), {
          ...(typeof args.worktree === "boolean" ? { worktree: args.worktree } : {}),
          ...(typeof args.baseBranch === "string" && args.baseBranch.trim()
            ? { baseBranch: args.baseBranch.trim() }
            : {}),
        });
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
          properties: {
            threadId: threadIdSchema,
            message: { type: "string" },
            dictationId: dictationIdSchema,
          },
          required: ["threadId"],
        },
      },
      run: async (args) => {
        await workspace.sendMessage(findThread(args), messageArg(args));
        return "Sent.";
      },
    },
    ...(dictation === undefined ? [] : dictationTools(dictation)),
    ...(setListeningMode === undefined
      ? []
      : [
          {
            declaration: {
              name: "set_listening_mode",
              description:
                'Switches how the user talks to you: "push-to-talk" (they hold a button while speaking, so you only hear them then) or "hands-free" (the microphone stays open). Use when they ask you to stop listening, or to listen again.',
              parametersJsonSchema: {
                type: "object",
                properties: { mode: { type: "string", enum: ["push-to-talk", "hands-free"] } },
                required: ["mode"],
              },
            },
            run: async (args: Record<string, unknown>) => {
              const mode = args.mode;
              if (mode !== "push-to-talk" && mode !== "hands-free") {
                throw new Error('mode must be "push-to-talk" or "hands-free".');
              }
              return setListeningMode(mode);
            },
          } satisfies VoiceAgentTool,
        ]),
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
        name: "settle_thread",
        description:
          "Settles a thread: moves finished work out of the active list, like Settle in the app. reopen_thread undoes it.",
        parametersJsonSchema: {
          type: "object",
          properties: { threadId: threadIdSchema },
          required: ["threadId"],
        },
      },
      run: async (args) => {
        const thread = findThread(args);
        if (isSettled(thread)) return "That thread is already settled.";
        if (threadRuntimeIsActive(thread.runtime)) {
          return "That thread is still working; stop it first if it should be settled.";
        }
        await workspace.setSettled(thread, true);
        return "Settled.";
      },
    },
    {
      declaration: {
        name: "reopen_thread",
        description: "Moves a settled thread back into the active list.",
        parametersJsonSchema: {
          type: "object",
          properties: { threadId: threadIdSchema },
          required: ["threadId"],
        },
      },
      run: async (args) => {
        const thread = findThread(args);
        if (!isSettled(thread)) return "That thread is not settled.";
        await workspace.setSettled(thread, false);
        return "Reopened.";
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

/** start_dictation and read_dictation, where the platform can dictate. */
function dictationTools(dictation: VoiceAgentDictationTools): ReadonlyArray<VoiceAgentTool> {
  return [
    {
      declaration: {
        name: "start_dictation",
        description:
          'Starts dictation: the user talks for as long as they like, unheard by you, until they press the button or say "stop dictation". The transcript then arrives as a [T3 dictation] message. Use when the user wants to dictate or say something long.',
        parametersJsonSchema: { type: "object", properties: {} },
      },
      run: async () => dictation.request(),
    },
    {
      declaration: {
        name: "read_dictation",
        description: "Reads a dictation's full text.",
        parametersJsonSchema: {
          type: "object",
          properties: { dictationId: dictationIdSchema },
          required: ["dictationId"],
        },
      },
      run: async (args) => {
        const saved = dictation.store.get(
          typeof args.dictationId === "string" ? args.dictationId : "",
        );
        if (!saved) return "There is no such dictation.";
        return JSON.stringify({ dictationId: saved.id, text: saved.text });
      },
    },
  ];
}
