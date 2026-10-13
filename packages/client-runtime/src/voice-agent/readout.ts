// @effect-diagnostics globalTimers:off - Playback pacing driven by the session's audio, outside an Effect runtime.
import type { SpeakableSentence } from "./speakable.ts";

/** Gemini speech is 16-bit mono PCM at 24 kHz. */
const SPEECH_RATE = 24_000;
/** The next stretch is queued this long before the current one ends, so there is no gap. */
const LEAD_MS = 250;
/**
 * Sentences of one paragraph are spoken from one request up to about this many characters:
 * fewer requests stay under the speech model's rate limit, and the voice flows across sentences.
 */
const GROUP_CHARS = 400;
/** Waits before retrying a refused request, such as a rate limit; then reading pauses. */
const RETRY_DELAYS_MS = [1500, 4000];

export type ReadoutPhase = "reading" | "paused" | "finished";

export interface ReadoutState {
  readonly phase: ReadoutPhase;
  readonly title: string;
  /** The sentence being read, or where reading resumes, counting from 0. */
  readonly index: number;
  /** Reading stops after this sentence. */
  readonly end: number;
  readonly count: number;
}

export interface ReadoutDependencies {
  /** Base64 PCM for some text: one sentence or a few. */
  readonly synthesize: (text: string) => Promise<string>;
  readonly play: (base64Pcm: string) => void;
  readonly clearPlayback: () => void;
  readonly onChange: (state: ReadoutState) => void;
  readonly onError: (message: string) => void;
}

const playMs = (base64Pcm: string) => (((base64Pcm.length * 3) / 4 / 2) * 1000) / SPEECH_RATE;

/**
 * Reads a message aloud a sentence at a time, so pausing, resuming and seeking land on sentence
 * boundaries. The audio for each sentence is fetched while the one before plays.
 */
export class Readout {
  readonly sentences: ReadonlyArray<SpeakableSentence>;
  private readonly deps: ReadoutDependencies;
  private state: ReadoutState;
  private readonly audio = new Map<string, Promise<string>>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  /** Bumped on every pause and seek, so audio for an abandoned position is not played. */
  private generation = 0;

  constructor(
    title: string,
    sentences: ReadonlyArray<SpeakableSentence>,
    deps: ReadoutDependencies,
  ) {
    this.sentences = sentences;
    this.deps = deps;
    this.state = {
      phase: "paused",
      title,
      index: 0,
      end: sentences.length - 1,
      count: sentences.length,
    };
  }

  getState(): ReadoutState {
    return this.state;
  }

  /** Reads sentences `start` through `end`, inclusive. */
  play(start = this.state.index, end = this.state.count - 1): void {
    this.halt();
    const first = Math.max(0, Math.min(start, this.state.count - 1));
    this.update({
      phase: "reading",
      index: first,
      end: Math.max(first, Math.min(end, this.state.count - 1)),
    });
    void this.speak(first, this.generation);
  }

  /** Stops where it is; `play()` picks up from the start of that sentence. */
  pause(): void {
    if (this.state.phase !== "reading") return;
    this.halt();
    this.update({ phase: "paused" });
  }

  stop(): void {
    this.halt();
    this.update({ phase: "finished" });
  }

  private halt(): void {
    this.generation += 1;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.deps.clearPlayback();
  }

  /** The last sentence spoken together with `index`: same block, within GROUP_CHARS and `end`. */
  private groupEnd(index: number): number {
    let last = index;
    let chars = this.sentences[index]!.text.length;
    while (
      last + 1 <= this.state.end &&
      this.sentences[last + 1]!.block === this.sentences[index]!.block &&
      chars + this.sentences[last + 1]!.text.length <= GROUP_CHARS
    ) {
      last += 1;
      chars += this.sentences[last]!.text.length;
    }
    return last;
  }

  private fetch(first: number, last: number): Promise<string> {
    const key = `${first}-${last}`;
    let audio = this.audio.get(key);
    if (audio === undefined) {
      const text = this.sentences
        .slice(first, last + 1)
        .map((sentence) => sentence.text)
        .join(" ");
      audio = this.synthesizeWithRetry(text);
      // A failed fetch is tried afresh next time it is needed.
      audio.catch(() => this.audio.delete(key));
      this.audio.set(key, audio);
    }
    return audio;
  }

  private async synthesizeWithRetry(text: string): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.deps.synthesize(text);
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async speak(index: number, generation: number): Promise<void> {
    const last = this.groupEnd(index);
    let pcm: string;
    try {
      pcm = await this.fetch(index, last);
    } catch (error) {
      if (generation !== this.generation) return;
      this.halt();
      this.update({ phase: "paused" });
      this.deps.onError(error instanceof Error ? error.message : "Could not read that aloud.");
      return;
    }
    if (generation !== this.generation) return;
    this.update({ index });
    this.deps.play(pcm);
    const ms = playMs(pcm);
    // Where each later sentence of the group starts, by its share of the text.
    const lengths = this.sentences.slice(index, last + 1).map((sentence) => sentence.text.length);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let elapsed = 0;
    for (let offset = 1; offset < lengths.length; offset += 1) {
      elapsed += lengths[offset - 1]!;
      const sentence = index + offset;
      this.timers.push(
        setTimeout(
          () => {
            if (generation === this.generation) this.update({ index: sentence });
          },
          (ms * elapsed) / total,
        ),
      );
    }
    const next = last + 1;
    if (next <= this.state.end) void this.fetch(next, this.groupEnd(next)).catch(() => {});
    this.timers.push(
      setTimeout(
        () => {
          if (generation !== this.generation) return;
          if (next > this.state.end) {
            this.update({ phase: "finished", index: this.state.end });
            return;
          }
          void this.speak(next, generation);
        },
        // The last stretch finishes when its audio does; others hand over a little early.
        Math.max(0, ms - (next > this.state.end ? 0 : LEAD_MS)),
      ),
    );
  }

  private update(patch: Partial<ReadoutState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }
}
