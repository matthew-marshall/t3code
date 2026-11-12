// @effect-diagnostics globalTimers:off - Timers driven by the session's socket callbacks, outside an Effect runtime.

/**
 * Short sounds that say what the voice session is doing when nothing is being said: a tool
 * running, the agent thinking, the connection dropping. Played by the platform's voice audio.
 */
export type VoiceAgentCue =
  | "start"
  | "end"
  | "tool"
  | "tool-start"
  | "tool-end"
  | "working"
  | "connection-lost"
  | "connection-back"
  | "error";

/** A tool call taking longer than this gets start and end cues instead of one blip. */
const SLOW_TOOL_MS = 400;
/** How often "working" repeats while a slow tool runs or a reply is awaited. */
const WORKING_EVERY_MS = 1500;
/** "Working" stops after this long without a reply, in case none is coming. */
const AWAIT_REPLY_MS = 12_000;

export interface VoiceAgentCueDependencies {
  readonly play: (cue: VoiceAgentCue) => void;
  /** Whether a cue may play now: nobody is talking and no dictation is recording. */
  readonly quiet: () => boolean;
  /** The user's sound cues setting, read before each cue. */
  readonly enabled: () => boolean;
  readonly now: () => number;
}

/**
 * Decides which cue plays when. Tool and progress cues never play over speech; connection cues
 * always play, since the agent cannot be speaking then.
 */
export class VoiceAgentCues {
  private readonly deps: VoiceAgentCueDependencies;
  private runningTools = 0;
  private slowTool = false;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private awaitingUntil = 0;
  private connectionLost = false;

  constructor(deps: VoiceAgentCueDependencies) {
    this.deps = deps;
  }

  toolStarted(): void {
    this.runningTools += 1;
    if (this.runningTools > 1) return;
    this.slowTimer = setTimeout(() => {
      this.slowTimer = null;
      this.slowTool = true;
      this.cue("tool-start");
      this.startTicker();
    }, SLOW_TOOL_MS);
  }

  toolFinished(): void {
    this.runningTools = Math.max(0, this.runningTools - 1);
    if (this.runningTools > 0) return;
    if (this.slowTimer !== null) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    this.cue(this.slowTool ? "tool-end" : "tool");
    this.slowTool = false;
    this.stopTickerIfIdle();
  }

  /** The agent heard the user; "working" plays until it answers, so silence means not heard. */
  awaitReply(): void {
    this.awaitingUntil = this.deps.now() + AWAIT_REPLY_MS;
    this.startTicker();
  }

  /** The agent spoke, called a tool or finished its turn. */
  replied(): void {
    this.awaitingUntil = 0;
    this.stopTickerIfIdle();
  }

  /** The connection dropped and is being replaced; said once per outage. */
  connectionDropped(): void {
    if (this.connectionLost) return;
    this.connectionLost = true;
    this.play("connection-lost");
  }

  connectionLive(): void {
    if (!this.connectionLost) return;
    this.connectionLost = false;
    this.play("connection-back");
  }

  failed(): void {
    this.reset();
    this.play("error");
  }

  reset(): void {
    if (this.slowTimer !== null) clearTimeout(this.slowTimer);
    if (this.ticker !== null) clearInterval(this.ticker);
    this.slowTimer = null;
    this.ticker = null;
    this.runningTools = 0;
    this.slowTool = false;
    this.awaitingUntil = 0;
    this.connectionLost = false;
  }

  private startTicker(): void {
    this.ticker ??= setInterval(() => {
      if (!this.stopTickerIfIdle()) this.cue("working");
    }, WORKING_EVERY_MS);
  }

  /** Stops "working" when there is nothing left to wait on; returns whether it stopped. */
  private stopTickerIfIdle(): boolean {
    const waiting =
      (this.runningTools > 0 && this.slowTool) || this.deps.now() < this.awaitingUntil;
    if (waiting || this.ticker === null) return !waiting;
    clearInterval(this.ticker);
    this.ticker = null;
    return true;
  }

  private cue(cue: VoiceAgentCue): void {
    if (this.deps.quiet()) this.play(cue);
  }

  private play(cue: VoiceAgentCue): void {
    if (this.deps.enabled()) this.deps.play(cue);
  }
}
