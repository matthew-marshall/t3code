import type { VoiceAgentProviderId } from "@t3tools/contracts";
import {
  createGeminiVoiceProvider,
  createOpenAIVoiceProvider,
  createVoiceAgentTools,
  createVoiceAgentWorkspace,
  describeVoiceThreadUpdates,
  snapshotVoiceThreads,
  VOICE_AGENT_INSTRUCTIONS,
  type VoiceAgentMode,
  type VoiceAgentProvider as VoiceAgentRealtimeProvider,
  VoiceAgentSessionController,
  type VoiceAgentState,
} from "@t3tools/client-runtime/voice-agent";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readT3ProjectFile } from "~/lib/t3ProjectFileDefaults";
import { randomUUID } from "~/lib/utils";
import { readThreadShells, subscribeThreadShells } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { environmentPresentations } from "~/state/presentation";
import { environmentProjects } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { environmentThreadShells, threadEnvironment } from "~/state/threads";
import { vcsEnvironment } from "~/state/vcs";
import { buildThreadRouteParams } from "~/threadRoutes";
import { readGeminiKey, readOpenAIKey } from "./voiceAgentKeys";
import { createWebVoiceAudio } from "./webVoiceAudio";

const MODE_STORAGE_KEY = "t3code:voice-agent-mode";

function readStoredMode(): VoiceAgentMode {
  return localStorage.getItem(MODE_STORAGE_KEY) === "hands-free" ? "hands-free" : "push-to-talk";
}

interface VoiceAgentHandle {
  readonly controller: VoiceAgentSessionController;
  readonly subscribe: (listener: () => void) => () => void;
  /** Starts a session; call from the user's click so the browser lets audio play. */
  readonly start: () => void;
  readonly stop: () => void;
  readonly setMode: (mode: VoiceAgentMode) => void;
  readonly setLatest: (latest: VoiceAgentLatest) => void;
  readonly setProvider: (provider: VoiceAgentProviderId) => void;
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
  readonly threadId: string | undefined;
  readonly router: ReturnType<typeof useRouter>;
}

function createVoiceAgentHandle(initialProvider: VoiceAgentProviderId): VoiceAgentHandle {
  // The session outlives renders; the provider keeps this current.
  const latest: { current: VoiceAgentLatest | null } = { current: null };
  const current = (): VoiceAgentLatest => {
    if (latest.current === null) throw new Error("Voice is not ready yet.");
    return latest.current;
  };
  const listeners = new Set<() => void>();
  const audio = createWebVoiceAudio();
  // Each provider exchanges this device's key for a short-lived credential per connection.
  const providers: Record<VoiceAgentProviderId, VoiceAgentRealtimeProvider> = {
    gemini: createGeminiVoiceProvider({ readApiKey: readGeminiKey }),
    openai: createOpenAIVoiceProvider({ readApiKey: readOpenAIKey }),
  };
  let unsubscribeThreads: (() => void) | null = null;

  const workspace = createVoiceAgentWorkspace({
    registry: appAtomRegistry,
    threadShellsAtom: environmentThreadShells.threadShellsAtom,
    projectsAtom: environmentProjects.projectsAtom,
    threadProjection: orchestrationEnvironment.v2.threadProjection,
    startTurn: threadEnvironment.startTurn,
    interruptTurn: threadEnvironment.interruptTurn,
    settle: threadEnvironment.settle,
    unsettle: threadEnvironment.unsettle,
    respondToApproval: threadEnvironment.respondToApproval,
    respondToUserInput: threadEnvironment.respondToUserInput,
    serverConfig: (environmentId) =>
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)) ?? null,
    readProjectFile: (project) => readT3ProjectFile(project.environmentId, project.workspaceRoot),
    vcsStatus: vcsEnvironment.status,
    vcsListRefs: vcsEnvironment.listRefs,
    environmentLabel: (environmentId) =>
      appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.entry
        .target.label ?? null,
    openThread: (thread) => {
      void current().router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      });
    },
    creationSource: "web",
    newId: randomUUID,
  });

  const controller: VoiceAgentSessionController = new VoiceAgentSessionController(
    {
      provider: providers[initialProvider],
      instructions: VOICE_AGENT_INSTRUCTIONS,
      language: navigator.language,
      tools: createVoiceAgentTools(workspace),
      describeContext: () => {
        const threadId = latest.current?.threadId;
        const shell =
          threadId === undefined
            ? undefined
            : readThreadShells().find((candidate) => candidate.id === threadId);
        return shell === undefined ? null : `the thread "${shell.title}" (threadId ${shell.id}).`;
      },
      openSocket: (url, protocols, handlers) => {
        const socket = new WebSocket(url, protocols.length > 0 ? [...protocols] : undefined);
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", handlers.onOpen);
        socket.addEventListener("message", (event) => handlers.onMessage(event.data));
        socket.addEventListener("close", (event) => handlers.onClose(event.reason));
        return socket;
      },
      audio,
      // Tool calls, results, transcripts and app updates, for reviewing a session in dev tools.
      onEvent: (event) => console.debug("[voice]", event),
      onStateChange: (state) => {
        if (state.phase === "live" && unsubscribeThreads === null) {
          let snapshots = snapshotVoiceThreads(readThreadShells());
          unsubscribeThreads = subscribeThreadShells((shells) => {
            for (const update of describeVoiceThreadUpdates(snapshots, shells)) {
              controller.sendUpdate(update);
            }
            snapshots = snapshotVoiceThreads(shells);
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
      audio.unlock();
      void controller.start();
    },
    stop: () => {
      void controller.stop();
    },
    setLatest: (next) => {
      latest.current = next;
    },
    setProvider: (provider) => {
      void controller.setProvider(providers[provider]);
    },
    setMode: (mode) => {
      localStorage.setItem(MODE_STORAGE_KEY, mode);
      void controller.setMode(mode);
    },
  };
}

/**
 * Owns the window's voice session above the router, so it survives navigation.
 * The key stays on this device and audio goes straight to the chosen provider
 * (Gemini Live or OpenAI Realtime); the tools act on every connected
 * environment through the app's own commands.
 */
export function VoiceAgentProvider({ children }: { readonly children: ReactNode }) {
  const enabled = useClientSettings((settings) => settings.voiceAgentEnabled);
  const provider = useClientSettings((settings) => settings.voiceAgentProvider);
  // Each provider has its own voices, so each keeps its own choice.
  const voice = useClientSettings((settings) =>
    settings.voiceAgentProvider === "openai"
      ? settings.voiceAgentOpenAIVoice
      : settings.voiceAgentVoice,
  );
  const pace = useClientSettings((settings) => settings.voiceAgentPace);
  const routeParams = useParams({ strict: false });
  const router = useRouter();

  const threadId = routeParams.threadId;
  const [handle] = useState(() => createVoiceAgentHandle(provider));
  useEffect(() => {
    handle.setLatest({ threadId, router });
  }, [handle, threadId, router]);

  useEffect(() => {
    if (!enabled) handle.stop();
  }, [enabled, handle]);
  useEffect(() => {
    handle.setProvider(provider);
  }, [handle, provider]);
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
