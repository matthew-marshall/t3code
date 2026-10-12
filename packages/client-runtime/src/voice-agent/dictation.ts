/**
 * Dictation: the user talks for as long as they like, and only the button or saying "stop
 * dictation" finishes it. The transcript is kept under a short ID so the agent can use it as a
 * message without retyping it.
 */

/**
 * How dictation is transcribed. On-device speech always listens for the end phrase; then:
 * - "gemini-batch": the recording is transcribed by Gemini 3.5 Transcribe, which drops filler
 *   words, falling back to the on-device transcript if that fails.
 * - "on-device": the on-device transcript is kept. Free and offline, less accurate.
 */
export type VoiceDictationMode = "gemini-batch" | "on-device";

/**
 * What finishes a dictation when said last, before a pause. "Stop" is hard to mishear; "end" is
 * often heard as "and" or "in", which are too common to accept, so only the exact words count.
 */
export const STOP_DICTATION_PHRASES = ["stop dictation", "end dictation"] as const;

export interface VoiceDictation {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
}

const KEEP = 20;

/** Dictations from this app session, newest last; IDs are "d1", "d2", … */
export class VoiceDictationStore {
  private items: Array<VoiceDictation> = [];
  private next = 1;

  add(text: string, createdAt: number): VoiceDictation {
    const dictation = { id: `d${this.next++}`, text, createdAt };
    this.items = [...this.items, dictation].slice(-KEEP);
    return dictation;
  }

  /** By ID, or the newest for "latest" (also when the reference is empty). */
  get(reference: string): VoiceDictation | null {
    const ref = reference.trim().toLowerCase();
    if (ref === "" || ref === "latest") return this.items.at(-1) ?? null;
    return this.items.find((item) => item.id === ref) ?? null;
  }

  list(): ReadonlyArray<VoiceDictation> {
    return this.items;
  }
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Whether the transcript so far ends with a stop phrase, ignoring case and punctuation. */
export function endsWithStopPhrase(text: string): boolean {
  const last = words(text).slice(-2).join(" ");
  return STOP_DICTATION_PHRASES.some((phrase) => phrase === last);
}

/**
 * The transcript without the stop phrase at its end, and without earlier attempts that were
 * misheard ("And dictation. In dictation."). Those count only as sentences of their own, so
 * "…voice and dictation" before the stop phrase is kept.
 */
export function stripStopPhrases(text: string): string {
  const stop = /[\s,.;:!?-]*\b(?:stop|end)\W+dictation\W*$/iu;
  const attempt = /(^|[.!?])\s*(?:stop|end|and|in)(?:\s+of)?\s+(?:the\s+)?dictation\W*$/iu;
  let result = text.trim().replace(stop, "").trim();
  for (let next = result.replace(attempt, "$1").trim(); next !== result;) {
    result = next;
    next = result.replace(attempt, "$1").trim();
  }
  return result;
}
