import type {
  EnvironmentId,
  ThreadId,
  VoiceAgentCallToolInput,
  VoiceAgentCallToolResult,
  VoiceAgentSession,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  describeVoiceThreadUpdates,
  snapshotVoiceThreads,
  type VoiceAgentLocalTool,
  type VoiceAgentMode,
  VoiceAgentSessionController,
  type VoiceAgentState,
} from "@t3tools/client-runtime/voice-agent";
import { useParams, useRouter } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { readThreadShells, subscribeThreadShells, useActiveEnvironmentId } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { createWebVoiceAudio } from "./webVoiceAudio";

const MODE_STORAGE_KEY = "t3code:voice-agent-mode";

function readStoredMode(): VoiceAgentMode {
  return localStorage.getItem(MODE_STORAGE_KEY) === "hands-free" ? "hands-free" : "push-to-talk";
}

function failureMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

interface VoiceAgentHandle {
  readonly controller: VoiceAgentSessionController;
  readonly subscribe: (listener: () => void) => () => void;
  /** Starts a session; call from the user's click so the browser lets audio play. */
  readonly start: () => void;
  readonly stop: () => void;
  readonly setMode: (mode: VoiceAgentMode) => void;
  readonly setLatest: (latest: VoiceAgentLatest) => void;
}

const VoiceAgentContext = createContext<VoiceAgentHandle | null>(null);

/** The voice session for this window, or null while the beta setting is off. */
export function useVoiceAgent(): {
  readonly handle: VoiceAgentHandle;
  readonly state: VoiceAgentState;
} | null {
  const handle = useContext(VoiceAgentContext);
  const state = useSyncExternalStore(
    handle?.subscribe ?? noopSubscribe,
    () => handle?.controller.getState() ?? null,
  );
  return handle === null || state === null ? null : { handle, state };
}

const noopSubscribe = () => () => {};

/** What the session reads from React each time it needs it. */
interface VoiceAgentLatest {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string | undefined;
  readonly router: ReturnType<typeof useRouter>;
  readonly createSession: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Record<string, never>;
  }) => Promise<AtomCommandResult<VoiceAgentSession, unknown>>;
  readonly callTool: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: VoiceAgentCallToolInput;
  }) => Promise<AtomCommandResult<VoiceAgentCallToolResult, unknown>>;
}

function createVoiceAgentHandle(): VoiceAgentHandle {
  // The session outlives renders; the provider keeps this current.
  const latest: { current: VoiceAgentLatest | null } = { current: null };
  const current = (): VoiceAgentLatest => {
    if (latest.current === null) throw new Error("Voice is not ready yet.");
    return latest.current;
  };
  const listeners = new Set<() => void>();
  const audio = createWebVoiceAudio();
  // Tool calls go to the environment the session started on, even if the user switches.
  let sessionEnvironmentId: EnvironmentId | null = null;
  let unsubscribeThreads: (() => void) | null = null;

  const requireEnvironment = (): EnvironmentId => {
    if (sessionEnvironmentId === null) {
      throw new Error("Connect to an environment to use voice.");
    }
    return sessionEnvironmentId;
  };

  const openThreadTool: VoiceAgentLocalTool = {
    declaration: {
      name: "open_thread",
      description: "Show a thread on the user's screen.",
      parametersJsonSchema: {
        type: "object",
        properties: { threadId: { type: "string" } },
        required: ["threadId"],
      },
    },
    run: async (args) => {
      const environmentId = requireEnvironment();
      const threadId = String(args.threadId) as ThreadId;
      await current().router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId }),
      });
      return "Opened.";
    },
  };

  const controller: VoiceAgentSessionController = new VoiceAgentSessionController(
    {
      createSession: async () => {
        const environmentId = requireEnvironment();
        const result = await current().createSession({ environmentId, input: {} });
        if (result._tag === "Failure") {
          throw new Error(failureMessage(result.cause, "Could not start voice."));
        }
        return result.value;
      },
      callTool: async (input) => {
        const result = await current().callTool({
          environmentId: requireEnvironment(),
          input,
        });
        return result._tag === "Success"
          ? result.value
          : { isError: true, output: failureMessage(result.cause, "The tool call failed.") };
      },
      localTools: [openThreadTool],
      describeContext: () => {
        const threadId = latest.current?.threadId;
        const shell =
          threadId === undefined
            ? undefined
            : readThreadShells().find((candidate) => candidate.id === threadId);
        return shell === undefined ? null : `the thread "${shell.title}" (threadId ${shell.id}).`;
      },
      openSocket: (url, handlers) => {
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", handlers.onOpen);
        socket.addEventListener("message", (event) => handlers.onMessage(event.data));
        socket.addEventListener("close", (event) => handlers.onClose(event.reason));
        return socket;
      },
      audio,
      onStateChange: (state) => {
        if (state.phase === "live" && unsubscribeThreads === null) {
          let snapshots = snapshotVoiceThreads(readThreadShells());
          unsubscribeThreads = subscribeThreadShells((shells) => {
            const scoped = shells.filter((shell) => shell.environmentId === sessionEnvironmentId);
            for (const update of describeVoiceThreadUpdates(snapshots, scoped)) {
              controller.sendUpdate(update);
            }
            snapshots = snapshotVoiceThreads(scoped);
          });
        } else if (state.phase !== "live" && state.phase !== "connecting") {
          unsubscribeThreads?.();
          unsubscribeThreads = null;
        }
        for (const listener of listeners) listener();
      },
    },
    readStoredMode(),
  );

  return {
    controller,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      sessionEnvironmentId = latest.current?.environmentId ?? null;
      audio.unlock();
      void controller.start();
    },
    stop: () => {
      void controller.stop();
    },
    setLatest: (next) => {
      latest.current = next;
    },
    setMode: (mode) => {
      localStorage.setItem(MODE_STORAGE_KEY, mode);
      void controller.setMode(mode);
    },
  };
}

/**
 * Owns the window's voice session above the router, so it survives navigation.
 * Audio goes straight to Gemini; the active environment issues tokens and runs
 * tool calls, and its thread updates are passed on to the agent.
 */
export function VoiceAgentProvider({ children }: { readonly children: ReactNode }) {
  const enabled = useClientSettings((settings) => settings.voiceAgentEnabled);
  const voice = useClientSettings((settings) => settings.voiceAgentVoice);
  const pace = useClientSettings((settings) => settings.voiceAgentPace);
  const environmentId = useActiveEnvironmentId();
  const routeParams = useParams({ strict: false });
  const router = useRouter();
  const createSession = useAtomCommand(serverEnvironment.createVoiceSession, {
    reportFailure: false,
  });
  const callTool = useAtomCommand(serverEnvironment.callVoiceTool, { reportFailure: false });

  const threadId = routeParams.threadId;
  const [handle] = useState(createVoiceAgentHandle);
  useEffect(() => {
    handle.setLatest({ environmentId, threadId, router, createSession, callTool });
  }, [handle, environmentId, threadId, router, createSession, callTool]);

  useEffect(() => {
    if (!enabled) handle.stop();
  }, [enabled, handle]);
  useEffect(() => {
    void handle.controller.setSpeech({ voice: voice === "" ? null : voice, pace });
  }, [handle, voice, pace]);
  useEffect(() => () => handle.stop(), [handle]);

  return (
    <VoiceAgentContext.Provider value={enabled ? handle : null}>
      {children}
    </VoiceAgentContext.Provider>
  );
}
