// @effect-diagnostics globalTimers:off - A plain class driven by socket callbacks, outside an Effect runtime.
import type { VoiceAgentPace, VoiceAgentProviderId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { type VoiceAgentCue, VoiceAgentCues } from "./cues.ts";
import { Readout, type ReadoutState } from "./readout.ts";
import type { SpeakableSentence } from "./speakable.ts";
import {
  endsWithStopPhrase,
  stripStopPhrases,
  type VoiceDictationMode,
  type VoiceDictationStore,
} from "./dictation.ts";
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
      readonly status: "open" | "live" | "closed" | "go-away" | "unresponsive";
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
  | {
      readonly type: "dictation-start";
      readonly origin: "button" | "agent";
      readonly mode: VoiceDictationMode;
    }
  | {
      readonly type: "dictation";
      readonly id: string;
      readonly text: string;
      readonly endedBy: VoiceDictationEnd;
      readonly seconds: number;
      /** What on-device speech heard, kept when Gemini transcribed the recording. */
      readonly onDevice?: string;
    }
  | { readonly type: "dictation-error"; readonly message: string }
  | ({ readonly type: "feedback" } & Omit<VoiceFeedback, "at">)
  | { readonly type: "readout"; readonly title: string; readonly sentences: number }
  /** The provider rejected one request; the session went on. */
  | { readonly type: "provider-error"; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "session-end" };

/** The step a starting session is on, so the control can show progress instead of a spinner. */
export type VoiceAgentProgress = "token" | "connecting" | "setup" | "microphone";

export type VoiceTranscriptRole = "user" | "agent" | "tool" | "update" | "dictation";

/** "remote" is a play/pause button: a steering wheel, headphones or the lock screen. */
/** A message the agent will act on, or feedback that only goes to the logs. */
export type VoiceDictationPurpose = "message" | "feedback";

/** Feedback about the app, saved beside the session log for the developer. */
export interface VoiceFeedback {
  readonly id: string;
  readonly text: string;
  readonly source: "dictation" | "flag";
  readonly at: number;
}

/** "session-end": the session ended or failed mid-dictation, and what was said was kept. */
export type VoiceDictationEnd = "button" | "phrase" | "remote" | "limit" | "session-end";

/** A dictation in progress: recording until the button or "stop dictation", then transcribing. */
export interface VoiceDictationState {
  readonly phase: "recording" | "transcribing";
  /** The phrase on-device speech is hearing now. */
  readonly heard: string;
}

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
  /** Hands-free with the microphone muted: nothing is sent until it is unmuted. */
  readonly muted: boolean;
  readonly agentSpeaking: boolean;
  /** Tools the agent is waiting on, by name. */
  readonly runningTools: ReadonlyArray<string>;
  readonly transcript: ReadonlyArray<VoiceTranscriptEntry>;
  readonly error: string | null;
  readonly progress: VoiceAgentProgress | null;
  readonly dictation: VoiceDictationState | null;
  /** A message being read aloud, or the last one read, so it can be read again. */
  readonly readout: ReadoutState | null;
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
  /** Dictation needs these; a platform without them cannot dictate. */
  /** A sound cue on the session's output; dictation needs "start" and "end". */
  playChime?(cue: VoiceAgentCue): void;
  /**
   * On-device speech over the captured microphone. `onText` gets the phrase being spoken, as it
   * changes; a pause starts a new one.
   */
  startPhraseListener?(
    locale: string,
    onText: (text: string, isFinal: boolean) => void,
  ): Promise<void>;
  /** Stops listening and resolves with the full on-device transcript. */
  stopPhraseListener?(): Promise<string>;
  /**
   * Routes play/pause presses (steering wheel, headphones, lock screen) to `onPress` while a
   * dictation runs; null hands them back.
   */
  setRemoteControl?(onPress: (() => void) | null): void;
  /** Records the captured microphone to a compressed file. */
  startRecordingFile?(): Promise<void>;
  stopRecordingFile?(): Promise<VoiceRecording | null>;
}

export interface VoiceRecording {
  readonly uri: string;
  readonly mimeType: string;
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
  /** Speech for reading messages aloud, in a voice unlike the agent's; see `synthesizeSpeech`. */
  readonly readAloud?: { readonly synthesize: (text: string) => Promise<string> };
  /** Keeps feedback somewhere it outlives the session logs, and marks it in the device log. */
  readonly onFeedback?: (feedback: VoiceFeedback) => void;
  /** Saves a listening mode the agent switched to, as the client saves the user's own choice. */
  readonly onModeChange?: (mode: VoiceAgentMode) => void;
  /** The user's sound cues setting (tool, progress and connection sounds); on when absent. */
  readonly soundCues?: () => boolean;
  readonly dictation?: {
    readonly store: VoiceDictationStore;
    /** Read when each dictation starts. */
    readonly mode: () => VoiceDictationMode;
    /** Gemini 3.5 Transcribe for "gemini-batch"; the recording can be deleted afterwards. */
    readonly transcribeRecording: (recording: VoiceRecording) => Promise<string>;
  };
}

const TRANSCRIPT_LIMIT = 40;
const MAX_RECONNECTS = 3;
/** Covers the player's preroll and any pause while it buffers, beyond the speech itself. */
const PLAYBACK_MARGIN_MS = 500;
/** A tool still running after this is reported as unknown, so the agent never waits on it forever. */
const TOOL_TIMEOUT_MS = 30_000;
/** "Stop dictation" counts once nothing follows it for this long, so it can be said mid-sentence. */
const STOP_PHRASE_PAUSE_MS = 750;
/** Dictation finishes by itself after this long, in case the end was missed. */
const DICTATION_LIMIT_MS = 30 * 60 * 1000;
/** An update waits at most this long for a quiet moment, in case a turn never reports done. */
const UPDATE_MAX_WAIT_MS = 20_000;
/**
 * The agent answers within this long of being spoken to. A session that does not has been seen to
 * stay silent for good after resuming, so it is replaced by a fresh one.
 */
const REPLY_TIMEOUT_MS = 15_000;

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
  muted: false,
  agentSpeaking: false,
  runningTools: [],
  transcript: [],
  error: null,
  progress: null,
  dictation: null,
  readout: null,
});

const RECAP_ENTRIES = 12;

const RECAP_SPEAKERS: Record<VoiceTranscriptRole, string | null> = {
  user: "User",
  agent: "You",
  update: "App update",
  dictation: "User (dictated)",
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
  /** The agent asked for dictation; it starts once the agent is quiet. */
  private dictationRequested = false;
  /** The agent asked to switch listening mode; it switches once the agent is quiet. */
  private requestedMode: VoiceAgentMode | null = null;
  private readout: Readout | null = null;
  /** A read-aloud the agent asked for; it starts once the agent is quiet. */
  private readoutRequest: {
    readonly title: string;
    readonly sentences: ReadonlyArray<SpeakableSentence>;
    readonly start: number;
    readonly end: number;
  } | null = null;
  private dictationStartedAt = 0;
  private dictationLimit: ReturnType<typeof setTimeout> | null = null;
  private dictationPurpose: VoiceDictationPurpose = "message";
  private nextFeedbackId = 1;
  private stopPhraseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cues: VoiceAgentCues;
  /** Whether the agent has answered since the user last started speaking. */
  private repliedSinceSpeech = true;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fresh sessions started in a row because the agent stopped answering. */
  private stalls = 0;
  /** Whether the current connection got as far as live. */
  private connectionLive = false;

  constructor(deps: VoiceAgentSessionDependencies, mode: VoiceAgentMode) {
    this.deps = deps;
    this.provider = deps.provider;
    this.state = initialVoiceAgentState(mode);
    this.cues = new VoiceAgentCues({
      play: (cue) => deps.audio.playChime?.(cue),
      quiet: () =>
        this.state.dictation === null &&
        this.state.readout?.phase !== "reading" &&
        !this.state.talking &&
        !this.sendingSpeech &&
        !this.state.agentSpeaking &&
        this.speechEndsAt <= nowMs(),
      enabled: () => deps.soundCues?.() ?? true,
      now: nowMs,
    });
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
    this.stalls = 0;
    this.update({ phase: "connecting", error: null, transcript: [] });
    this.log({ type: "session-start", mode: this.state.mode });
    await this.connect();
  }

  async stop(): Promise<void> {
    if (this.state.phase !== "idle") this.log({ type: "session-end" });
    this.generation += 1;
    this.closeSocket();
    this.clearReplyTimer();
    this.resumptionHandle = null;
    this.dropQueuedUpdates();
    void this.keepDictation();
    this.cues.reset();
    this.readoutRequest = null;
    this.readout?.stop();
    this.readout = null;
    this.update({
      readout: null,
      phase: "idle",
      talking: false,
      muted: false,
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
    this.update({ mode, talking: false, muted: false });
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

  /** Hands-free: stops (or resumes) sending the microphone without ending the session. */
  setMuted(muted: boolean): void {
    if (muted === this.state.muted) return;
    if (muted && this.sendingSpeech) {
      // End what was being said, so the agent does not wait for more of it.
      this.sendingSpeech = false;
      this.quietChunks = 0;
      this.connection?.pauseAudio();
    }
    this.preRoll = [];
    this.update({ muted });
  }

  /** Push-to-talk pressed: interrupt any speech and open a user turn. */
  beginTalking(): void {
    if (this.state.mode !== "push-to-talk" || this.state.phase !== "live" || this.state.talking) {
      return;
    }
    this.deps.audio.clearPlayback();
    this.pauseReadoutForUser();
    this.connection?.beginTalking();
    this.repliedSinceSpeech = false;
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
    if (
      this.queuedUpdates.length === 0 &&
      !this.dictationRequested &&
      this.requestedMode === null &&
      this.readoutRequest === null
    ) {
      return;
    }
    // Nothing interrupts a message being read aloud; it all follows once reading stops.
    if (this.state.readout?.phase === "reading") return;
    // Each of these ends with a call back here: the turn completing, `endTalking`, the tools, or
    // a dictation finishing.
    if (this.state.dictation !== null) return;
    if (this.turnUnderway || this.state.talking || this.state.runningTools.length > 0) return;
    const playing = this.speechEndsAt - nowMs();
    if (playing > 0) {
      this.updateTimer = setTimeout(() => this.deliverUpdatesWhenQuiet(), playing);
      return;
    }
    if (this.requestedMode !== null) {
      const mode = this.requestedMode;
      this.requestedMode = null;
      // A new mode needs a new connection; the conversation carries over in its instructions.
      void this.setMode(mode).then(() => this.deps.onModeChange?.(mode));
      return;
    }
    if (this.dictationRequested) {
      void this.beginDictation("agent");
      return;
    }
    if (this.readoutRequest !== null) {
      this.beginReadout();
      return;
    }
    this.deliverUpdates();
  }

  /**
   * The agent's read_aloud tool: reads sentences `start` through `end` once the agent stops
   * speaking. Returns what the agent is told.
   */
  requestReadout(
    title: string,
    sentences: ReadonlyArray<SpeakableSentence>,
    start = 0,
    end = sentences.length - 1,
  ): string {
    if (this.deps.readAloud === undefined) return "Reading aloud is not available here.";
    if (sentences.length === 0) return "There is nothing to read in that message.";
    this.readoutRequest = { title, sentences, start, end };
    this.deliverUpdatesWhenQuiet();
    return `Reading ${end - start + 1} of ${sentences.length} sentences aloud once you stop speaking: say nothing more now. It pauses if the user speaks; use readout_control then.`;
  }

  /** The current or last read-aloud, for readout_control. */
  currentReadout(): Readout | null {
    return this.readout;
  }

  /** Plays part of the current read-aloud now, with the start chime. */
  playReadout(start?: number, end?: number): void {
    if (this.readout === null) return;
    this.deps.audio.playChime?.("start");
    this.readout.play(start, end);
  }

  private beginReadout(): void {
    const request = this.readoutRequest;
    const readAloud = this.deps.readAloud;
    this.readoutRequest = null;
    if (request === null || readAloud === undefined) return;
    this.readout?.stop();
    const readout: Readout = new Readout(request.title, request.sentences, {
      synthesize: readAloud.synthesize,
      play: (pcm) => this.deps.audio.play(pcm),
      clearPlayback: () => this.deps.audio.clearPlayback(),
      onChange: (state) => {
        if (this.readout !== readout) return;
        const finishing = state.phase === "finished" && this.state.readout?.phase === "reading";
        this.update({ readout: state });
        if (finishing) {
          this.deps.audio.playChime?.("end");
          this.sendUpdate("Finished reading aloud.");
        }
        if (state.phase !== "reading") this.deliverUpdatesWhenQuiet();
      },
      onError: (message) => this.sendUpdate(`Reading aloud stopped: ${message}`),
    });
    this.readout = readout;
    this.log({ type: "readout", title: request.title, sentences: request.sentences.length });
    this.playReadout(request.start, request.end);
  }

  /** The user started talking: reading pauses where it is, and the agent listens. */
  private pauseReadoutForUser(): void {
    if (this.state.readout?.phase === "reading") this.readout?.pause();
  }

  /**
   * The agent's set_listening_mode tool: switches once the agent has finished speaking, so its
   * confirmation is heard. Returns what the agent is told.
   */
  requestMode(mode: VoiceAgentMode): string {
    if (mode === this.state.mode && this.requestedMode === null) {
      return mode === "push-to-talk" ? "It is already push-to-talk." : "It is already hands-free.";
    }
    this.requestedMode = mode;
    this.deliverUpdatesWhenQuiet();
    return mode === "push-to-talk"
      ? "Switching to push-to-talk once you stop speaking: confirm in a few words. After that the user holds the talk button to speak."
      : "Switching to hands-free once you stop speaking: confirm in a few words. After that the microphone stays open.";
  }

  /** Whether this platform can dictate: on-device speech and recording are both needed. */
  canDictate(): boolean {
    const audio = this.deps.audio;
    return (
      this.deps.dictation !== undefined &&
      audio.startPhraseListener !== undefined &&
      audio.stopPhraseListener !== undefined &&
      audio.startRecordingFile !== undefined &&
      audio.stopRecordingFile !== undefined
    );
  }

  /** The dictation button: starts now, cutting off the agent if it is talking. */
  startDictation(): void {
    if (this.state.phase !== "live" || this.state.dictation !== null || !this.canDictate()) return;
    void this.beginDictation("button");
  }

  /**
   * The agent's start_dictation tool: starts once the agent has finished speaking, so its "go
   * ahead" is not cut off. Returns what the agent is told.
   */
  requestDictation(purpose: VoiceDictationPurpose = "message"): string {
    if (!this.canDictate()) return "Dictation is not available on this device.";
    if (this.state.dictation !== null) return "A dictation is already in progress.";
    this.dictationRequested = true;
    this.dictationPurpose = purpose;
    this.deliverUpdatesWhenQuiet();
    return purpose === "feedback"
      ? 'Feedback dictation starts with a chime once you stop speaking: say "Go ahead" or similar, briefly, then stay silent. It is saved to the logs for the developer; you will only be told it was saved.'
      : 'Dictation starts with a chime once you stop speaking: say "Go ahead" or similar, briefly. Do not speak again until a [T3 dictation] message arrives.';
  }

  /**
   * Saves feedback about the app to the logs, beside what just happened, for the developer to
   * review later; the agent does not act on it. Returns its ID.
   */
  recordFeedback(text: string, source: "dictation" | "flag"): string {
    const feedback = { id: `f${this.nextFeedbackId++}`, text, source, at: nowMs() };
    // The log entry has its own timestamp.
    this.log({ type: "feedback", id: feedback.id, text, source });
    try {
      this.deps.onFeedback?.(feedback);
    } catch {
      // Saving feedback must never break the conversation.
    }
    return feedback.id;
  }

  /** The dictation button again, or "stop dictation": stops recording and transcribes. */
  finishDictation(endedBy: VoiceDictationEnd = "button"): void {
    if (this.state.dictation?.phase !== "recording") return;
    void this.completeDictation(endedBy);
  }

  private async beginDictation(origin: "button" | "agent"): Promise<void> {
    // The button always dictates a message; the agent's request says what it is for.
    if (origin === "button") this.dictationPurpose = "message";
    const dictation = this.deps.dictation;
    const audio = this.deps.audio;
    this.dictationRequested = false;
    if (!dictation || !audio.startPhraseListener || !audio.startRecordingFile) return;
    const mode = dictation.mode();
    // The agent stays silent while the user dictates.
    audio.clearPlayback();
    this.speechEndsAt = 0;
    this.update({ agentSpeaking: false, dictation: { phase: "recording", heard: "" } });
    this.log({ type: "dictation-start", origin, mode });
    audio.playChime?.("start");
    this.dictationStartedAt = nowMs();
    this.dictationLimit = setTimeout(() => this.finishDictation("limit"), DICTATION_LIMIT_MS);
    audio.setRemoteControl?.(() => this.finishDictation("remote"));
    try {
      await audio.startPhraseListener(this.deps.language, (text) => {
        if (this.state.dictation?.phase !== "recording") return;
        this.update({ dictation: { phase: "recording", heard: text } });
        // Any new words cancel a pending stop: the phrase was part of a sentence.
        this.clearStopPhraseTimer();
        if (endsWithStopPhrase(text)) {
          this.stopPhraseTimer = setTimeout(
            () => this.finishDictation("phrase"),
            STOP_PHRASE_PAUSE_MS,
          );
        }
      });
      if (mode === "gemini-batch") await audio.startRecordingFile();
    } catch (error) {
      await this.abandonDictation();
      this.dictationFailed(describeError(error));
    }
  }

  private async completeDictation(endedBy: VoiceDictationEnd): Promise<void> {
    const dictation = this.deps.dictation;
    const audio = this.deps.audio;
    if (!dictation) return;
    this.clearDictationLimit();
    audio.setRemoteControl?.(null);
    const heard = this.state.dictation?.heard ?? "";
    this.update({ dictation: { phase: "transcribing", heard } });
    audio.playChime?.("end");
    const mode = dictation.mode();
    let transcript: { readonly text: string; readonly onDevice: string };
    try {
      transcript = await this.transcribeDictation(dictation, mode, heard);
    } catch (error) {
      this.update({ dictation: null });
      this.dictationFailed(describeError(error));
      return;
    }
    const { text, onDevice } = transcript;
    const seconds = Math.round((nowMs() - this.dictationStartedAt) / 1000);
    this.update({ dictation: null });
    // Recording resumes on the next chunk; the hands-free gate starts over.
    this.sendingSpeech = false;
    this.preRoll = [];
    this.quietChunks = 0;
    if (text === "") {
      this.dictationFailed("Nothing was heard in the dictation.");
      return;
    }
    if (this.dictationPurpose === "feedback") {
      this.dictationPurpose = "message";
      const id = this.recordFeedback(text, "dictation");
      this.connection?.sendText(
        `[T3 update] The user's feedback was saved to the logs as ${id}. Confirm in a few words; do not act on it.`,
      );
      this.expectReply();
      this.deliverUpdatesWhenQuiet();
      return;
    }
    const saved = dictation.store.add(text, nowMs());
    this.log({
      type: "dictation",
      id: saved.id,
      text,
      endedBy,
      seconds,
      ...(mode === "gemini-batch" ? { onDevice } : {}),
    });
    this.appendTranscript("dictation", text);
    this.connection?.sendText(
      [
        `[T3 dictation ${saved.id}] The user dictated:`,
        `"""${text}"""`,
        `Unless it is already clear what to do with it, briefly ask. To send it as a message or start a thread with it, pass dictationId "${saved.id}" instead of retyping it.`,
      ].join("\n"),
    );
    this.expectReply();
    this.deliverUpdatesWhenQuiet();
  }

  /**
   * Stops listening and recording, and returns the transcript without its stop phrase: Gemini's
   * for "gemini-batch", or the on-device one when that is the mode or Gemini fails.
   */
  private async transcribeDictation(
    dictation: NonNullable<VoiceAgentSessionDependencies["dictation"]>,
    mode: VoiceDictationMode,
    heard: string,
  ): Promise<{ readonly text: string; readonly onDevice: string }> {
    const audio = this.deps.audio;
    const onDevice = (await audio.stopPhraseListener?.()) || heard;
    const recording = await audio.stopRecordingFile?.();
    let text = onDevice;
    if (mode === "gemini-batch" && recording) {
      try {
        text = await dictation.transcribeRecording(recording);
      } catch (error) {
        // The on-device transcript is less polished, but it is what the user said.
        this.log({
          type: "dictation-error",
          message: `Gemini could not transcribe the dictation; kept the on-device transcript. ${describeError(error)}`,
        });
      }
    }
    return { text: stripStopPhrases(text), onDevice: stripStopPhrases(onDevice) };
  }

  /**
   * The session is ending mid-dictation. What was said is still transcribed and saved, so it can
   * be found in the dictation history, but nothing is sent.
   */
  private async keepDictation(): Promise<void> {
    const dictation = this.deps.dictation;
    if (this.state.dictation?.phase !== "recording" || !dictation) {
      await this.abandonDictation();
      return;
    }
    const heard = this.state.dictation.heard;
    const purpose = this.dictationPurpose;
    const seconds = Math.round((nowMs() - this.dictationStartedAt) / 1000);
    this.dictationRequested = false;
    this.dictationPurpose = "message";
    this.clearDictationLimit();
    this.deps.audio.setRemoteControl?.(null);
    this.update({ dictation: null });
    const mode = dictation.mode();
    let text: string;
    let onDevice: string;
    try {
      ({ text, onDevice } = await this.transcribeDictation(dictation, mode, heard));
    } catch {
      return;
    }
    if (text === "") return;
    if (purpose === "feedback") {
      this.recordFeedback(text, "dictation");
      return;
    }
    const saved = dictation.store.add(text, nowMs());
    this.log({
      type: "dictation",
      id: saved.id,
      text,
      endedBy: "session-end",
      seconds,
      ...(mode === "gemini-batch" ? { onDevice } : {}),
    });
  }

  /** Tells the agent a dictation failed, so it can say so. */
  private dictationFailed(message: string): void {
    this.log({ type: "dictation-error", message });
    this.connection?.sendText(`[T3 update] The dictation failed: ${message}`);
    this.expectReply();
    this.deliverUpdatesWhenQuiet();
  }

  /** Stops listening and recording without keeping anything. */
  private async abandonDictation(): Promise<void> {
    this.dictationRequested = false;
    this.clearDictationLimit();
    this.deps.audio.setRemoteControl?.(null);
    if (this.state.dictation === null) return;
    this.update({ dictation: null });
    await this.deps.audio.stopPhraseListener?.().catch(() => "");
    await this.deps.audio.stopRecordingFile?.().catch(() => null);
  }

  private clearDictationLimit(): void {
    if (this.dictationLimit !== null) clearTimeout(this.dictationLimit);
    this.dictationLimit = null;
    this.clearStopPhraseTimer();
  }

  private clearStopPhraseTimer(): void {
    if (this.stopPhraseTimer !== null) clearTimeout(this.stopPhraseTimer);
    this.stopPhraseTimer = null;
  }

  private deliverUpdates(): void {
    const updates = this.queuedUpdates;
    this.dropQueuedUpdates();
    if (this.state.phase !== "live" || updates.length === 0) return;
    this.connection?.sendText(updates.map((text) => `[T3 update] ${text}`).join("\n"));
    this.expectReply();
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
    this.connectionLive = false;
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
        if (this.state.phase === "live" || this.state.phase === "connecting") {
          this.cues.connectionDropped();
        }
        this.socket = null;
        // Resuming failed, as when the provider still holds the dropped connection's session.
        if (!this.connectionLive) this.resumptionHandle = null;
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
    this.clearReplyTimer();
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
        // The agent stays silent while the user dictates or a message is read aloud.
        if (this.state.dictation !== null || this.state.readout?.phase === "reading") return;
        this.turnUnderway = true;
        this.agentReplied();
        this.deps.audio.play(event.data);
        this.speechEndsAt =
          Math.max(this.speechEndsAt, nowMs() + PLAYBACK_MARGIN_MS) + speechMs(event.data);
        if (!this.state.agentSpeaking) this.update({ agentSpeaking: true });
        return;
      case "heard":
        this.turnUnderway = true;
        // Heard and not yet answered: "working" plays until it is, so silence means unheard.
        if (!this.repliedSinceSpeech) this.cues.awaitReply();
        this.expectReply();
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
        this.agentReplied();
        this.update({ agentSpeaking: false });
        this.deliverUpdatesWhenQuiet();
        return;
      case "tool-cancelled":
        this.log({ type: "tool-cancelled", ids: event.ids });
        for (const id of event.ids) this.cancelledCalls.add(id);
        return;
      case "tool-calls":
        this.turnUnderway = true;
        this.agentReplied();
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

  private agentReplied(): void {
    this.repliedSinceSpeech = true;
    this.stalls = 0;
    this.clearReplyTimer();
    this.cues.replied();
  }

  /** Something went to the agent that it answers; see `REPLY_TIMEOUT_MS`. */
  private expectReply(): void {
    this.clearReplyTimer();
    this.replyTimer = setTimeout(() => this.replyOverdue(), REPLY_TIMEOUT_MS);
  }

  private clearReplyTimer(): void {
    if (this.replyTimer !== null) clearTimeout(this.replyTimer);
    this.replyTimer = null;
  }

  private replyOverdue(): void {
    this.replyTimer = null;
    if (this.state.phase !== "live") return;
    // The agent cannot answer yet: the user or the app still has the turn.
    if (
      this.sendingSpeech ||
      this.state.talking ||
      this.state.dictation !== null ||
      this.state.runningTools.length > 0 ||
      this.state.readout?.phase === "reading"
    ) {
      this.expectReply();
      return;
    }
    this.log({ type: "connection", status: "unresponsive" });
    this.stalls += 1;
    if (this.stalls > 1) {
      this.fail("The voice agent stopped answering. Try again in a little while.");
      return;
    }
    // The fresh session is told the conversation so far, then prompted to carry on from it.
    this.resumptionHandle = null;
    this.queuedUpdates.push(
      "The voice connection was restarted because you had stopped answering. Answer the user's last request now.",
    );
    void this.reconnect();
  }

  private sessionReady(): void {
    this.reconnects = 0;
    this.connectionLive = true;
    this.cues.connectionLive();
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
      this.expectReply();
      // The agent answers with what the tools returned.
      this.turnUnderway = true;
    }
    this.deliverUpdatesWhenQuiet();
  }

  private async runToolCall(call: VoiceToolCall): Promise<VoiceToolResult> {
    this.log({ type: "tool-call", id: call.id, name: call.name, args: call.args });
    const startedAt = nowMs();
    this.cues.toolStarted();
    const result = await this.callTool(call);
    this.cues.toolFinished();
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
    // Dictation listens and records natively; none of it reaches the agent.
    if (this.state.dictation !== null || this.state.muted) return;
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
      this.repliedSinceSpeech = false;
      this.pauseReadoutForUser();
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
    this.clearReplyTimer();
    this.cues.failed();
    this.dropQueuedUpdates();
    void this.keepDictation();
    this.readoutRequest = null;
    this.readout?.stop();
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
