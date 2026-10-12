import {
  type EnvironmentId,
  T3_PROJECT_FILE_NAME,
  type ThreadId,
  type VoiceAgentProviderId,
} from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import {
  createGeminiVoiceProvider,
  createOpenAIVoiceProvider,
  createVoiceAgentTools,
  createVoiceAgentWorkspace,
  describeVoiceThreadUpdates,
  snapshotVoiceThreads,
  VOICE_AGENT_INSTRUCTIONS,
  type VoiceAgentMode,
  VoiceAgentSessionController,
} from "@t3tools/client-runtime/voice-agent";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { selectPreferredMicrophone } from "../../state/microphone-selection";
import { orchestrationEnvironment } from "../../state/orchestration";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { geminiKey, openAIKey } from "./apiKeys";
import { createNativeVoiceAudio } from "./nativeVoiceAudio";
import { logVoiceEvent } from "./voiceSessionLog";

/** What the session needs from the navigator; `VoiceAgentHost` keeps it current. */
export interface VoiceAgentHost {
  readonly threadOnScreen: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  } | null;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly openThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}

let host: VoiceAgentHost | null = null;
let unsubscribeThreads: (() => void) | null = null;
const listeners = new Set<() => void>();

const readShells = () => appAtomRegistry.get(environmentThreadShells.threadShellsAtom);

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
  readProjectFile: async (project) => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.readFile({
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot, relativePath: T3_PROJECT_FILE_NAME },
      }),
      { reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Failure" || result.value === null || result.value.truncated) return null;
    return parseT3ProjectFile(result.value.contents);
  },
  vcsStatus: vcsEnvironment.status,
  vcsListRefs: vcsEnvironment.listRefs,
  environmentLabel: (environmentId) => host?.environmentLabel(environmentId) ?? null,
  openThread: (thread) => {
    if (host === null) throw new Error("The app is not ready to open threads.");
    host.openThread(thread.environmentId, thread.id);
  },
  creationSource: "mobile",
  newId: uuidv4,
});

/** Tells the agent when any thread finishes or starts waiting on the user. */
const watchThreads = () => {
  let snapshots = snapshotVoiceThreads(readShells());
  unsubscribeThreads = appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, () => {
    const shells = readShells();
    for (const update of describeVoiceThreadUpdates(snapshots, shells)) {
      voiceAgentController.sendUpdate(update);
    }
    snapshots = snapshotVoiceThreads(shells);
  });
};

const providers = {
  gemini: createGeminiVoiceProvider({ readApiKey: geminiKey.read }),
  openai: createOpenAIVoiceProvider({ readApiKey: openAIKey.read }),
};

export const voiceAgentController: VoiceAgentSessionController = new VoiceAgentSessionController(
  {
    provider: providers.gemini,
    instructions: VOICE_AGENT_INSTRUCTIONS,
    language: Intl.DateTimeFormat().resolvedOptions().locale,
    tools: createVoiceAgentTools(workspace),
    describeContext: () => {
      const onScreen = host?.threadOnScreen;
      if (!onScreen) return null;
      const shell = readShells().find(
        (candidate) =>
          candidate.environmentId === onScreen.environmentId && candidate.id === onScreen.threadId,
      );
      return shell === undefined ? null : `the thread "${shell.title}" (threadId ${shell.id}).`;
    },
    openSocket: (url, protocols, handlers) => {
      const socket = new WebSocket(url, protocols.length > 0 ? [...protocols] : undefined);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => handlers.onOpen());
      socket.addEventListener("message", (event) => handlers.onMessage(event.data));
      socket.addEventListener("close", (event) => handlers.onClose(event.reason));
      return socket;
    },
    audio: createNativeVoiceAudio((inputs) => {
      const preferred = selectPreferredMicrophone(appAtomRegistry, inputs);
      // iOS plays a conversation where its microphone is: the iPhone's own would move the agent's
      // voice off the car speakers, so in a CarPlay car the car's microphone wins over the order.
      return inputs.find((input) => input.type === "CarAudio") ?? preferred;
    }),
    onEvent: logVoiceEvent,
    onStateChange: (state) => {
      if (state.phase === "live" && unsubscribeThreads === null) {
        watchThreads();
      } else if (state.phase !== "live" && state.phase !== "connecting") {
        unsubscribeThreads?.();
        unsubscribeThreads = null;
      }
      for (const listener of listeners) listener();
    },
  },
  "push-to-talk",
);

export function setVoiceAgentHost(next: VoiceAgentHost | null): void {
  host = next;
}

export function subscribeVoiceAgent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startVoiceAgent(): void {
  void voiceAgentController.start();
}

export function stopVoiceAgent(): void {
  void voiceAgentController.stop();
}

/**
 * Starts voice, or ends a session that is starting or live. Decided when pressed, not when the
 * control rendered: a native toolbar can keep an older handler, which made taps do nothing.
 */
export function toggleVoiceAgent(): void {
  const { phase } = voiceAgentController.getState();
  // Logged so a tap that seemed to do nothing can be told apart from one that never arrived.
  if (phase === "live" || phase === "connecting") {
    logVoiceEvent({ type: "control", action: "stop requested" });
    stopVoiceAgent();
  } else {
    logVoiceEvent({ type: "control", action: "start requested" });
    startVoiceAgent();
  }
}

export function setVoiceAgentProvider(provider: VoiceAgentProviderId): void {
  void voiceAgentController.setProvider(providers[provider]);
}

export function setVoiceAgentMode(mode: VoiceAgentMode): void {
  appAtomRegistry.set(updateMobilePreferencesAtom, { voiceAgentMode: mode });
  void voiceAgentController.setMode(mode);
}
