// @effect-diagnostics globalTimers:off - A plain class driven by socket callbacks, outside an Effect runtime.
import type { VoiceAgentPace, VoiceAgentProviderId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  LIVE_OUTPUT_SAMPLE_RATE,
  type VoiceAgentFunctionDeclaration,
  type VoiceAgentMode,
} from "./liveProtocol.ts";
import type {
  VoiceAgentProvider,
  VoiceProviderConnection,
  VoiceProviderEvent,
  VoiceToolCall,
  VoiceToolResult,
} from "./provider.ts";

export type VoiceAgentPhase = "idle" | "connecting" | "live" | "error";

/**
 * Everything the voice agent is told and does, in order, for reviewing a conversation that went
 * wrong: whether the model misheard, was given too little, or a tool fell short.
 */
export type VoiceAgentLogEvent =
  | { readonly type: "session-start"; readonly mode: VoiceAgentMode }
  | {
      readonly type: "setup";
      readonly provider: VoiceAgentProviderId;
      readonly model: string;
      readonly resumed: boolean;
      readonly systemInstruction: string;
      readonly tools: ReadonlyArray<string>;
    }
  | {
      readonly type: "connection";
      readonly status: "open" | "live" | "closed" | "go-away";
      readonly detail?: string;
    }
  | { readonly type: "heard"; readonly text: string }
  | { readonly type: "said"; readonly text: string }
  | { readonly type: "interrupted" }
  /** Hands-free: the microphone started sending at `level` dBFS, or paused after quiet. */
  | { readonly type: "microphone"; readonly status: "speech"; readonly level: number }
  | { readonly type: "microphone"; readonly status: "paused" }
  | { readonly type: "turn-complete" }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly args: Record<string, unknown>;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly ms: number;
      readonly output?: string;
      readonly error?: string;
    }
  | { readonly type: "tool-cancelled"; readonly ids: ReadonlyArray<string> }
  | { readonly type: "update"; readonly text: string }
  /** The provider rejected one request; the session went on. */
  | { readonly type: "provider-error"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "session-end" };

/** The step a starting session is on, so the control can show progress instead of a spinner. */
export type VoiceAgentProgress = "token" | "connecting" | "setup" | "microphone";

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
  readonly progress: VoiceAgentProgress | null;
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

/** Platform audio: 16-bit mono PCM capture in at the provider's rate, 24 kHz playback out, base64. */
export interface VoiceAgentAudio {
  /**
   * `onChunk` gets 100 ms of audio at `sampleRate` and its loudness in dBFS, measured after the
   * platform's echo cancellation. `onError` reports a microphone lost after capture started; the
   * session ends with it.
   */
  startCapture(
    onChunk: (base64Pcm: string, levelDbfs: number) => void,
    onError: (message: string) => void,
    sampleRate: number,
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

/** How the agent sounds. Both are fixed for a session, so changing them starts a new one. */
export interface VoiceAgentSpeech {
  /** One of the current provider's voices, or null for its default. */
  readonly voice: string | null;
  readonly pace: VoiceAgentPace;
}

export interface VoiceAgentSessionDependencies {
  /** The provider sessions start with; `setProvider` switches it. */
  readonly provider: VoiceAgentProvider;
  readonly instructions: string;
  /**
   * The device's language as a BCP 47 tag. Gemini otherwise guesses per phrase, and a clipped
   * phrase heard as German gets a German reply.
   */
  readonly language: string;
  readonly tools: ReadonlyArray<VoiceAgentTool>;
  /** What the user is looking at, added to the instructions when a connection opens. */
  readonly describeContext?: () => string | null;
  readonly openSocket: (
    url: string,
    protocols: ReadonlyArray<string>,
    handlers: VoiceAgentSocketHandlers,
  ) => VoiceAgentSocket;
  readonly audio: VoiceAgentAudio;
  readonly onStateChange: (state: VoiceAgentState) => void;
  /** Receives every `VoiceAgentLogEvent`; the client decides where the log goes. */
  readonly onEvent?: (event: VoiceAgentLogEvent) => void;
}

const TRANSCRIPT_LIMIT = 40;
const MAX_RECONNECTS = 3;
/** Covers the player's preroll and any pause while it buffers, beyond the speech itself. */
const PLAYBACK_MARGIN_MS = 500;
/** A tool still running after this is reported as unknown, so the agent never waits on it forever. */
const TOOL_TIMEOUT_MS = 30_000;
/** An update waits at most this long for a quiet moment, in case a turn never reports done. */
const UPDATE_MAX_WAIT_MS = 20_000;

/**
 * Hands-free sends the microphone only around speech. A chunk at least this loud counts as speech;
 * quieter is background left after the platform's noise suppression.
 */
const SPEECH_DBFS = -42;
/** Sent ahead of the chunk that crossed the threshold, so the start of a word is not clipped. */
const PRE_ROLL_CHUNKS = 5;
/** Quiet this long pauses sending; the provider still gets the silence it needs to end the turn. */
const PAUSE_AFTER_QUIET_CHUNKS = 15;

const nowMs = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

/** How long base64 16-bit mono speech at the output rate plays for. */
function speechMs(base64Pcm: string): number {
  const padding = base64Pcm.endsWith("==") ? 2 : base64Pcm.endsWith("=") ? 1 : 0;
  const bytes = (base64Pcm.length * 3) / 4 - padding;
  return (bytes / 2 / LIVE_OUTPUT_SAMPLE_RATE) * 1000;
}

const initialVoiceAgentState = (mode: VoiceAgentMode): VoiceAgentState => ({
  phase: "idle",
  mode,
  talking: false,
  agentSpeaking: false,
  runningTools: [],
  transcript: [],
  error: null,
  progress: null,
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
 * One live voice conversation with a realtime voice API (see `VoiceAgentProvider`). The client
 * holds the key, the socket, the audio and the tools; nothing goes through a T3 environment
 * except the actions the tools take.
 * Connections are replaced transparently when the provider ends one, resuming the conversation
 * when the provider offers that and otherwise telling the new one what was said.
 */
export class VoiceAgentSessionController {
  private state: VoiceAgentState;
  private provider: VoiceAgentProvider;
  private socket: VoiceAgentSocket | null = null;
  private connection: VoiceProviderConnection | null = null;
  private resumptionHandle: string | null = null;
  private reconnects = 0;
  private capturing = false;
  /** Bumped whenever a connection is abandoned, so its late events are ignored. */
  private generation = 0;
  private nextTranscriptId = 1;
  private readonly cancelledCalls = new Set<string>();
  private readonly deps: VoiceAgentSessionDependencies;
  private speech: VoiceAgentSpeech = { voice: null, pace: "normal" };
  private pendingRestart: Promise<void> | null = null;
  /**
   * Text sent to Live counts as the user speaking and cuts off a reply, so updates wait until
   * no turn is underway: from the user speaking or a tool call until the agent's turn completes.
   */
  private turnUnderway = false;
  /** When the speech handed to the player should have finished playing. */
  private speechEndsAt = 0;
  private queuedUpdates: Array<string> = [];
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private updateDeadline: ReturnType<typeof setTimeout> | null = null;
  /** Hands-free: whether the microphone is being sent, and what was held back while it is not. */
  private sendingSpeech = false;
  private preRoll: Array<string> = [];
  private quietChunks = 0;

  constructor(deps: VoiceAgentSessionDependencies, mode: VoiceAgentMode) {
    this.deps = deps;
    this.provider = deps.provider;
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
    this.log({ type: "session-start", mode: this.state.mode });
    await this.connect();
  }

  async stop(): Promise<void> {
    if (this.state.phase !== "idle") this.log({ type: "session-end" });
    this.generation += 1;
    this.closeSocket();
    this.resumptionHandle = null;
    this.dropQueuedUpdates();
    this.update({
      phase: "idle",
      talking: false,
      agentSpeaking: false,
      runningTools: [],
      progress: null,
    });
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

  /** Switches provider; a live conversation continues on a fresh session with the new one. */
  async setProvider(provider: VoiceAgentProvider): Promise<void> {
    if (provider.id === this.provider.id) {
      return;
    }
    const rateChanged = provider.inputSampleRate !== this.provider.inputSampleRate;
    this.provider = provider;
    // The microphone restarts at the new provider's rate once the new session is ready.
    if (rateChanged) await this.stopCapture();
    await this.restartFresh();
  }

  /**
   * Provider, mode, voice and pace need a new session: a resumed one keeps the setup it was
   * created with. The recent transcript goes into the new session's instructions instead.
   */
  private restartFresh(): Promise<void> {
    if (this.state.phase !== "live" && this.state.phase !== "connecting") {
      return Promise.resolve();
    }
    // Settings that change together, such as a provider and its voice, restart once.
    this.pendingRestart ??= Promise.resolve().then(async () => {
      this.pendingRestart = null;
      if (this.state.phase === "live" || this.state.phase === "connecting") {
        this.resumptionHandle = null;
        await this.reconnect();
      }
    });
    return this.pendingRestart;
  }

  /** Push-to-talk pressed: interrupt any speech and open a user turn. */
  beginTalking(): void {
    if (this.state.mode !== "push-to-talk" || this.state.phase !== "live" || this.state.talking) {
      return;
    }
    this.deps.audio.clearPlayback();
    this.connection?.beginTalking();
    this.update({ talking: true, agentSpeaking: false });
  }

  /** Push-to-talk released: the agent answers what was said. */
  endTalking(): void {
    if (!this.state.talking) {
      return;
    }
    this.connection?.endTalking();
    this.turnUnderway = true;
    this.update({ talking: false });
  }

  /**
   * Tells the agent about something that happened in the app, such as a thread finishing. Held
   * until the agent is quiet, so an update never cuts off what it is saying.
   */
  sendUpdate(text: string): void {
    if (this.state.phase !== "live") {
      return;
    }
    this.queuedUpdates.push(text);
    this.updateDeadline ??= setTimeout(() => this.deliverUpdates(), UPDATE_MAX_WAIT_MS);
    this.deliverUpdatesWhenQuiet();
  }

  private deliverUpdatesWhenQuiet(): void {
    if (this.updateTimer !== null) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    if (this.queuedUpdates.length === 0) return;
    // Each of these ends with a call back here: the turn completing, `endTalking`, or the tools.
    if (this.turnUnderway || this.state.talking || this.state.runningTools.length > 0) return;
    const playing = this.speechEndsAt - nowMs();
    if (playing > 0) {
      this.updateTimer = setTimeout(() => this.deliverUpdatesWhenQuiet(), playing);
      return;
    }
    this.deliverUpdates();
  }

  private deliverUpdates(): void {
    const updates = this.queuedUpdates;
    this.dropQueuedUpdates();
    if (this.state.phase !== "live" || updates.length === 0) return;
    this.connection?.sendText(updates.map((text) => `[T3 update] ${text}`).join("\n"));
    for (const text of updates) {
      this.log({ type: "update", text });
      this.appendTranscript("update", text);
    }
  }

  private dropQueuedUpdates(): void {
    this.queuedUpdates = [];
    if (this.updateTimer !== null) clearTimeout(this.updateTimer);
    if (this.updateDeadline !== null) clearTimeout(this.updateDeadline);
    this.updateTimer = null;
    this.updateDeadline = null;
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.update({ progress: "token" });
    let connection: VoiceProviderConnection;
    try {
      connection = await this.provider.connect((message) => {
        if (generation === this.generation) this.send(message);
      });
    } catch (error) {
      if (generation === this.generation) {
        this.fail(describeError(error));
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.connection = connection;
    this.update({ progress: "connecting" });
    // Every handler checks the generation: a replaced connection's late events are ignored.
    this.socket = this.deps.openSocket(connection.url, connection.protocols, {
      onOpen: () => {
        if (generation !== this.generation) return;
        this.update({ progress: "setup" });
        this.log({ type: "connection", status: "open" });
        connection.setup(this.sessionSetup());
      },
      onMessage: (data) => {
        if (generation !== this.generation) return;
        for (const event of connection.receive(data)) {
          if (generation !== this.generation) return;
          this.handleEvent(event);
        }
      },
      onClose: (reason) => {
        if (generation !== this.generation) return;
        this.log({ type: "connection", status: "closed", detail: reason });
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

  private sessionSetup() {
    const context = this.deps.describeContext?.() ?? null;
    // A resumed session remembers the conversation; a fresh one mid-conversation is told it.
    const recap = this.resumptionHandle === null ? transcriptRecap(this.state.transcript) : null;
    const systemInstruction = [
      this.deps.instructions,
      this.provider.instructions,
      `The user speaks the language with the tag "${this.deps.language}". Always reply in it, and understand everything they say as that language: a phrase that sounds like another language was misheard.`,
      context === null ? null : `Currently on screen: ${context}`,
      recap === null ? null : `The conversation so far:\n${recap}`,
    ]
      .filter((part) => part !== null)
      .join("\n\n");
    this.log({
      type: "setup",
      provider: this.provider.id,
      model: this.provider.model,
      resumed: this.resumptionHandle !== null,
      systemInstruction,
      tools: this.deps.tools.map((tool) => tool.declaration.name),
    });
    return {
      instructions: systemInstruction,
      tools: this.deps.tools.map((tool) => tool.declaration),
      mode: this.state.mode,
      voice: this.speech.voice,
      pace: this.speech.pace,
      language: this.deps.language,
      resumptionHandle: this.resumptionHandle,
    };
  }

  private handleEvent(event: VoiceProviderEvent): void {
    switch (event.type) {
      case "ready":
        this.sessionReady();
        return;
      case "resumable":
        this.resumptionHandle = event.handle;
        return;
      case "interrupted":
        // The user is talking, and the agent will answer.
        this.turnUnderway = true;
        if (!this.state.agentSpeaking && this.speechEndsAt <= nowMs()) return;
        this.log({ type: "interrupted" });
        this.deps.audio.clearPlayback();
        this.speechEndsAt = 0;
        this.update({ agentSpeaking: false });
        return;
      case "audio":
        this.turnUnderway = true;
        this.deps.audio.play(event.data);
        this.speechEndsAt =
          Math.max(this.speechEndsAt, nowMs() + PLAYBACK_MARGIN_MS) + speechMs(event.data);
        if (!this.state.agentSpeaking) this.update({ agentSpeaking: true });
        return;
      case "heard":
        this.turnUnderway = true;
        this.log({ type: "heard", text: event.text });
        this.appendTranscript("user", event.text);
        return;
      case "said":
        this.log({ type: "said", text: event.text });
        this.appendTranscript("agent", event.text);
        return;
      case "turn-complete":
        this.log({ type: "turn-complete" });
        this.turnUnderway = false;
        this.update({ agentSpeaking: false });
        this.deliverUpdatesWhenQuiet();
        return;
      case "tool-cancelled":
        this.log({ type: "tool-cancelled", ids: event.ids });
        for (const id of event.ids) this.cancelledCalls.add(id);
        return;
      case "tool-calls":
        this.turnUnderway = true;
        void this.runToolCalls(event.calls);
        return;
      case "go-away":
        this.log({ type: "connection", status: "go-away" });
        if (this.resumptionHandle !== null) void this.reconnect();
        return;
      case "error":
        this.log({ type: "provider-error", message: event.message });
        return;
    }
  }

  private sessionReady(): void {
    this.reconnects = 0;
    this.log({ type: "connection", status: "live" });
    this.turnUnderway = false;
    this.speechEndsAt = 0;
    this.sendingSpeech = false;
    this.preRoll = [];
    this.quietChunks = 0;
    this.update({
      phase: "live",
      error: null,
      progress: this.capturing ? null : "microphone",
    });
    void this.startCapture();
    // Updates that came in while reconnecting.
    this.deliverUpdatesWhenQuiet();
  }

  private async runToolCalls(calls: ReadonlyArray<VoiceToolCall>): Promise<void> {
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
      this.connection?.sendToolResults(answered);
      // The agent answers with what the tools returned.
      this.turnUnderway = true;
    }
    this.deliverUpdatesWhenQuiet();
  }

  private async runToolCall(call: VoiceToolCall): Promise<VoiceToolResult> {
    this.log({ type: "tool-call", id: call.id, name: call.name, args: call.args });
    const startedAt = nowMs();
    const result = await this.callTool(call);
    this.log({
      type: "tool-result",
      id: call.id,
      name: call.name,
      ms: nowMs() - startedAt,
      ...("output" in result ? { output: result.output } : { error: result.error }),
    });
    return result;
  }

  private async callTool(call: VoiceToolCall): Promise<VoiceToolResult> {
    this.appendTranscript("tool", call.name);
    const tool = this.deps.tools.find((candidate) => candidate.declaration.name === call.name);
    try {
      if (tool === undefined) {
        throw new Error(`There is no tool named ${call.name}.`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${call.name} has not finished after ${TOOL_TIMEOUT_MS / 1000} seconds, so whether it worked is unknown.`,
              ),
            ),
          TOOL_TIMEOUT_MS,
        );
      });
      try {
        const output = await Promise.race([tool.run(call.args), timedOut]);
        return { id: call.id, name: call.name, output };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return { id: call.id, name: call.name, error: describeError(error) };
    }
  }

  private async startCapture(): Promise<void> {
    if (this.capturing) {
      return;
    }
    this.capturing = true;
    try {
      await this.deps.audio.startCapture(
        (chunk, level) => this.captured(chunk, level),
        (message) => {
          if (this.capturing) this.captureFailed(message);
        },
        this.provider.inputSampleRate,
      );
      if (this.state.progress === "microphone") this.update({ progress: null });
    } catch (error) {
      this.captureFailed(describeError(error));
    }
  }

  private captured(chunk: string, level: number): void {
    if (this.state.phase !== "live") return;
    if (this.state.mode === "push-to-talk") {
      if (this.state.talking) this.connection?.sendAudio(chunk);
      return;
    }
    const loud = level >= SPEECH_DBFS;
    if (!this.sendingSpeech) {
      if (!loud) {
        this.preRoll.push(chunk);
        if (this.preRoll.length > PRE_ROLL_CHUNKS) this.preRoll.shift();
        return;
      }
      this.sendingSpeech = true;
      this.log({ type: "microphone", status: "speech", level: Math.round(level) });
      for (const held of this.preRoll) this.connection?.sendAudio(held);
      this.preRoll = [];
    }
    this.connection?.sendAudio(chunk);
    this.quietChunks = loud ? 0 : this.quietChunks + 1;
    if (this.quietChunks >= PAUSE_AFTER_QUIET_CHUNKS) {
      this.sendingSpeech = false;
      this.quietChunks = 0;
      this.connection?.pauseAudio();
      this.log({ type: "microphone", status: "paused" });
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
    this.connection = null;
  }

  private fail(error: string): void {
    this.log({ type: "error", message: error });
    this.dropQueuedUpdates();
    this.update({
      phase: "error",
      error,
      talking: false,
      agentSpeaking: false,
      runningTools: [],
      progress: null,
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

  private log(event: VoiceAgentLogEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch {
      // A broken log must never break the conversation.
    }
  }

  private update(patch: Partial<VoiceAgentState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onStateChange(this.state);
  }
}
