import type { VoiceAgentPace } from "@t3tools/contracts";

import { GEMINI_LIVE_URL, VOICE_AGENT_MODEL } from "./gemini.ts";
import {
  type LiveFunctionCall,
  type LiveFunctionResponse,
  type LiveServerMessage,
  type VoiceAgentFunctionDeclaration,
  type VoiceAgentMode,
  decodeLiveServerMessage,
  liveActivityEndMessage,
  liveActivityStartMessage,
  liveAudioMessage,
  liveSetupMessage,
  liveSocketUrl,
  liveTextMessage,
  liveToolResponseMessage,
} from "./liveProtocol.ts";

export type VoiceAgentPhase = "idle" | "connecting" | "live" | "error";

export type VoiceTranscriptRole = "user" | "agent" | "tool" | "update";

export interface VoiceTranscriptEntry {
  readonly id: number;
  readonly role: VoiceTranscriptRole;
  readonly text: string;
}

export interface VoiceAgentState {
  readonly phase: VoiceAgentPhase;
  readonly mode: VoiceAgentMode;
  /** Push-to-talk is held; in hands-free mode the microphone is always open. */
  readonly talking: boolean;
  readonly agentSpeaking: boolean;
  /** Tools the agent is waiting on, by name. */
  readonly runningTools: ReadonlyArray<string>;
  readonly transcript: ReadonlyArray<VoiceTranscriptEntry>;
  readonly error: string | null;
}

/** An open WebSocket. Each platform wraps its own; message data may be text or binary. */
export interface VoiceAgentSocket {
  send(data: string): void;
  close(): void;
}

export interface VoiceAgentSocketHandlers {
  readonly onOpen: () => void;
  readonly onMessage: (data: unknown) => void;
  readonly onClose: (reason: string) => void;
}

/** Platform audio: 16 kHz PCM capture in, 24 kHz PCM playback out, both base64. */
export interface VoiceAgentAudio {
  /** `onError` reports a microphone lost after capture started; the session ends with it. */
  startCapture(
    onChunk: (base64Pcm: string) => void,
    onError: (message: string) => void,
  ): Promise<void>;
  stopCapture(): Promise<void>;
  play(base64Pcm: string): void;
  /** Drops queued speech when the user interrupts the agent. */
  clearPlayback(): void;
}

/** A tool the agent can call. `run` resolves with what the agent is told; a thrown error is reported as one. */
export interface VoiceAgentTool {
  readonly declaration: VoiceAgentFunctionDeclaration;
  readonly run: (args: Record<string, unknown>) => Promise<string>;
}

/** How the agent sounds. Both are fixed for a Gemini session, so changing them starts a new one. */
export interface VoiceAgentSpeech {
  /** A prebuilt Gemini voice, or null for Gemini's default. */
  readonly voice: string | null;
  readonly pace: VoiceAgentPace;
}

const PACE_INSTRUCTIONS: Record<VoiceAgentPace, string | null> = {
  slow: "Speak slowly and calmly.",
  normal: null,
  fast: "Speak quickly, at a brisk pace.",
};

export interface VoiceAgentSessionDependencies {
  /** A single-use Gemini Live token for each connection; see `requestLiveToken`. */
  readonly requestToken: () => Promise<string>;
  readonly instructions: string;
  readonly tools: ReadonlyArray<VoiceAgentTool>;
  /** What the user is looking at, added to the instructions when a connection opens. */
  readonly describeContext?: () => string | null;
  readonly openSocket: (url: string, handlers: VoiceAgentSocketHandlers) => VoiceAgentSocket;
  readonly audio: VoiceAgentAudio;
  readonly onStateChange: (state: VoiceAgentState) => void;
}

const TRANSCRIPT_LIMIT = 40;
const MAX_RECONNECTS = 3;

const initialVoiceAgentState = (mode: VoiceAgentMode): VoiceAgentState => ({
  phase: "idle",
  mode,
  talking: false,
  agentSpeaking: false,
  runningTools: [],
  transcript: [],
  error: null,
});

const RECAP_ENTRIES = 12;

const RECAP_SPEAKERS: Record<VoiceTranscriptRole, string | null> = {
  user: "User",
  agent: "You",
  update: "App update",
  tool: null,
};

function transcriptRecap(transcript: ReadonlyArray<VoiceTranscriptEntry>): string | null {
  const lines = transcript.slice(-RECAP_ENTRIES).flatMap((entry) => {
    const speaker = RECAP_SPEAKERS[entry.role];
    return speaker === null ? [] : [`${speaker}: ${entry.text.trim()}`];
  });
  return lines.length === 0 ? null : lines.join("\n");
}

const describeError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : "Voice session failed.";

/**
 * One live voice conversation with Gemini. The client holds the key, the
 * socket, the audio and the tools; nothing goes through a T3 environment
 * except the actions the tools take.
 * Connections are replaced transparently (Live closes them every ~10 minutes)
 * using the resumption handle the server keeps sending.
 */
export class VoiceAgentSessionController {
  private state: VoiceAgentState;
  private socket: VoiceAgentSocket | null = null;
  private resumptionHandle: string | null = null;
  private reconnects = 0;
  private capturing = false;
  /** Bumped whenever a connection is abandoned, so its late events are ignored. */
  private generation = 0;
  private nextTranscriptId = 1;
  private readonly cancelledCalls = new Set<string>();
  private readonly deps: VoiceAgentSessionDependencies;
  private speech: VoiceAgentSpeech = { voice: null, pace: "normal" };

  constructor(deps: VoiceAgentSessionDependencies, mode: VoiceAgentMode) {
    this.deps = deps;
    this.state = initialVoiceAgentState(mode);
  }

  getState(): VoiceAgentState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.phase === "connecting" || this.state.phase === "live") {
      return;
    }
    this.resumptionHandle = null;
    this.reconnects = 0;
    this.update({ phase: "connecting", error: null, transcript: [] });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.closeSocket();
    this.resumptionHandle = null;
    this.update({ phase: "idle", talking: false, agentSpeaking: false, runningTools: [] });
    this.deps.audio.clearPlayback();
    await this.stopCapture();
  }

  async setMode(mode: VoiceAgentMode): Promise<void> {
    if (mode === this.state.mode) {
      return;
    }
    this.update({ mode, talking: false });
    await this.restartFresh();
  }

  async setSpeech(speech: VoiceAgentSpeech): Promise<void> {
    if (speech.voice === this.speech.voice && speech.pace === this.speech.pace) {
      return;
    }
    this.speech = speech;
    await this.restartFresh();
  }

  /**
   * Mode, voice and pace need a new Gemini session: a resumed one keeps the
   * setup it was created with. The recent transcript goes into the new
   * session's instructions instead.
   */
  private async restartFresh(): Promise<void> {
    if (this.state.phase === "live" || this.state.phase === "connecting") {
      this.resumptionHandle = null;
      await this.reconnect();
    }
  }

  /** Push-to-talk pressed: interrupt any speech and open a user turn. */
  beginTalking(): void {
    if (this.state.mode !== "push-to-talk" || this.state.phase !== "live" || this.state.talking) {
      return;
    }
    this.deps.audio.clearPlayback();
    this.send(liveActivityStartMessage);
    this.update({ talking: true, agentSpeaking: false });
  }

  /** Push-to-talk released: the agent answers what was said. */
  endTalking(): void {
    if (!this.state.talking) {
      return;
    }
    this.send(liveActivityEndMessage);
    this.update({ talking: false });
  }

  /** Tells the agent about something that happened in the app, such as a thread finishing. */
  sendUpdate(text: string): void {
    if (this.state.phase !== "live") {
      return;
    }
    this.send(liveTextMessage(`[T3 update] ${text}`));
    this.appendTranscript("update", text);
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    let token: string;
    try {
      token = await this.deps.requestToken();
    } catch (error) {
      if (generation === this.generation) {
        this.fail(describeError(error));
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    // Every handler checks the generation: a replaced connection's late events are ignored.
    this.socket = this.deps.openSocket(liveSocketUrl(GEMINI_LIVE_URL, token), {
      onOpen: () => {
        if (generation !== this.generation) return;
        this.send(this.setupMessage());
      },
      onMessage: (data) => {
        if (generation !== this.generation) return;
        const message = decodeLiveServerMessage(data);
        if (message !== null) {
          this.handleMessage(message);
        }
      },
      onClose: (reason) => {
        if (generation !== this.generation) return;
        this.socket = null;
        const active = this.state.phase === "live" || this.state.phase === "connecting";
        if (active && this.reconnects < MAX_RECONNECTS) {
          this.reconnects += 1;
          void this.reconnect();
          return;
        }
        this.fail(reason.length > 0 ? reason : "The voice connection closed.");
      },
    });
  }

  private async reconnect(): Promise<void> {
    this.generation += 1;
    this.closeSocket();
    this.update({ phase: "connecting", talking: false, agentSpeaking: false, runningTools: [] });
    this.deps.audio.clearPlayback();
    await this.connect();
  }

  private setupMessage() {
    const context = this.deps.describeContext?.() ?? null;
    // A resumed session remembers the conversation; a fresh one mid-conversation is told it.
    const recap = this.resumptionHandle === null ? transcriptRecap(this.state.transcript) : null;
    const systemInstruction = [
      this.deps.instructions,
      PACE_INSTRUCTIONS[this.speech.pace],
      context === null ? null : `Currently on screen: ${context}`,
      recap === null ? null : `The conversation so far:\n${recap}`,
    ]
      .filter((part) => part !== null)
      .join("\n\n");
    return liveSetupMessage({
      model: VOICE_AGENT_MODEL,
      systemInstruction,
      tools: this.deps.tools.map((tool) => tool.declaration),
      mode: this.state.mode,
      voice: this.speech.voice,
      resumptionHandle: this.resumptionHandle,
    });
  }

  private handleMessage(message: LiveServerMessage): void {
    if (message.setupComplete !== undefined) {
      this.reconnects = 0;
      this.update({ phase: "live", error: null });
      void this.startCapture();
    }
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
    }
    const content = message.serverContent;
    if (content !== undefined) {
      if (content.interrupted) {
        this.deps.audio.clearPlayback();
        this.update({ agentSpeaking: false });
      }
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          this.deps.audio.play(part.inlineData.data);
          if (!this.state.agentSpeaking) this.update({ agentSpeaking: true });
        }
      }
      if (content.inputTranscription?.text) {
        this.appendTranscript("user", content.inputTranscription.text);
      }
      if (content.outputTranscription?.text) {
        this.appendTranscript("agent", content.outputTranscription.text);
      }
      if (content.turnComplete) {
        this.update({ agentSpeaking: false });
      }
    }
    for (const id of message.toolCallCancellation?.ids ?? []) {
      this.cancelledCalls.add(id);
    }
    const calls = message.toolCall?.functionCalls ?? [];
    if (calls.length > 0) {
      void this.runToolCalls(calls);
    }
    if (message.goAway !== undefined && this.resumptionHandle !== null) {
      void this.reconnect();
    }
  }

  private async runToolCalls(calls: ReadonlyArray<LiveFunctionCall>): Promise<void> {
    const generation = this.generation;
    this.update({ runningTools: [...this.state.runningTools, ...calls.map((call) => call.name)] });
    const responses = await Promise.all(calls.map((call) => this.runToolCall(call)));
    if (generation !== this.generation) {
      return;
    }
    const remaining = [...this.state.runningTools];
    for (const call of calls) {
      const index = remaining.indexOf(call.name);
      if (index >= 0) remaining.splice(index, 1);
    }
    this.update({ runningTools: remaining });
    const answered = responses.filter((response) => !this.cancelledCalls.delete(response.id));
    if (answered.length > 0) {
      this.send(liveToolResponseMessage(answered));
    }
  }

  private async runToolCall(call: LiveFunctionCall): Promise<LiveFunctionResponse> {
    this.appendTranscript("tool", call.name);
    const tool = this.deps.tools.find((candidate) => candidate.declaration.name === call.name);
    try {
      if (tool === undefined) {
        throw new Error(`There is no tool named ${call.name}.`);
      }
      return {
        id: call.id,
        name: call.name,
        response: { output: await tool.run(call.args ?? {}) },
      };
    } catch (error) {
      return { id: call.id, name: call.name, response: { error: describeError(error) } };
    }
  }

  private async startCapture(): Promise<void> {
    if (this.capturing) {
      return;
    }
    this.capturing = true;
    try {
      await this.deps.audio.startCapture(
        (chunk) => {
          if (this.state.phase !== "live") return;
          if (this.state.mode === "push-to-talk" && !this.state.talking) return;
          this.send(liveAudioMessage(chunk));
        },
        (message) => {
          if (this.capturing) this.captureFailed(message);
        },
      );
    } catch (error) {
      this.captureFailed(describeError(error));
    }
  }

  /** `fail` then releases whatever part of the microphone did start. */
  private captureFailed(message: string): void {
    this.generation += 1;
    this.closeSocket();
    this.fail(message);
  }

  private async stopCapture(): Promise<void> {
    if (!this.capturing) {
      return;
    }
    this.capturing = false;
    await this.deps.audio.stopCapture();
  }

  private send(message: object): void {
    this.socket?.send(JSON.stringify(message));
  }

  private closeSocket(): void {
    this.socket?.close();
    this.socket = null;
  }

  private fail(error: string): void {
    this.update({
      phase: "error",
      error,
      talking: false,
      agentSpeaking: false,
      runningTools: [],
    });
    this.deps.audio.clearPlayback();
    void this.stopCapture();
  }

  /** Transcription arrives in fragments; consecutive fragments from one speaker join one entry. */
  private appendTranscript(role: VoiceTranscriptRole, text: string): void {
    const transcript = [...this.state.transcript];
    const last = transcript.at(-1);
    if (last !== undefined && last.role === role && (role === "user" || role === "agent")) {
      transcript[transcript.length - 1] = { ...last, text: last.text + text };
    } else {
      transcript.push({ id: this.nextTranscriptId++, role, text: text.trimStart() });
    }
    this.update({ transcript: transcript.slice(-TRANSCRIPT_LIMIT) });
  }

  private update(patch: Partial<VoiceAgentState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onStateChange(this.state);
  }
}
