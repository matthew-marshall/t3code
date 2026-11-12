/**
 * Reads the voice session logs (see `voiceSessionLog.ts`) back as something to look at: a
 * conversation with its dictations and tool calls, and a one-line summary per session.
 */

/** One line of a session log: a `VoiceAgentLogEvent` or app event, with when it happened. */
export type VoiceLogLine = { readonly at: string; readonly type: string } & Record<string, unknown>;

export type VoiceTimelineEntry =
  | { readonly kind: "user" | "agent" | "update"; readonly at: string; readonly text: string }
  | {
      readonly kind: "dictation";
      readonly at: string;
      readonly id: string;
      readonly text: string;
      readonly seconds: number;
    }
  | {
      readonly kind: "tool";
      readonly at: string;
      readonly id: string;
      readonly name: string;
      readonly args: string;
      /** Null while the log has no result, as when the session ended first. */
      readonly result: string | null;
      readonly failed: boolean;
      readonly ms: number | null;
    }
  | { readonly kind: "feedback"; readonly at: string; readonly id: string; readonly text: string }
  /** Connection changes, errors and other app events, as one short line. */
  | { readonly kind: "note"; readonly at: string; readonly text: string; readonly error: boolean };

export interface VoiceSessionSummary {
  readonly startedAt: string;
  readonly endedAt: string;
  /** The first thing the user said. */
  readonly preview: string | null;
  readonly dictations: number;
  readonly tools: number;
  readonly errors: number;
}

/** A dictation as kept in the dictation history, which outlives the session logs. */
export interface DictationRecord {
  readonly at: string;
  readonly id: string;
  readonly text: string;
  readonly seconds: number;
  /** The session log it came from, while that is still kept. */
  readonly sessionLog: string | null;
}

const string = (value: unknown) => (typeof value === "string" ? value : "");

export function parseVoiceLog(text: string): ReadonlyArray<VoiceLogLine> {
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === "object" &&
        value !== null &&
        typeof (value as VoiceLogLine).at === "string" &&
        typeof (value as VoiceLogLine).type === "string"
        ? [value as VoiceLogLine]
        : [];
    } catch {
      return [];
    }
  });
}

/** One line per app event worth seeing; null for the rest. */
function note(line: VoiceLogLine): { readonly text: string; readonly error: boolean } | null {
  switch (line.type) {
    case "session-start":
      return { text: `Started, ${string(line.mode) || "hands-free"}`, error: false };
    case "session-end":
      return { text: "Ended", error: false };
    case "connection":
      if (line.status === "closed") {
        return { text: `Connection closed: ${string(line.detail) || "no reason"}`, error: false };
      }
      if (line.status === "unresponsive") {
        return { text: "The agent stopped answering; restarted fresh", error: true };
      }
      return null;
    case "error":
    case "provider-error":
      return { text: string(line.message), error: true };
    case "dictation-error":
      return { text: `Dictation: ${string(line.message)}`, error: true };
    case "readout":
      return { text: `Reading aloud: ${string(line.title)}`, error: false };
    case "readout-paused":
      return { text: "Reading paused: a sound might have been you talking", error: false };
    case "readout-resumed":
      return { text: "Reading resumed: no speech followed", error: false };
    default:
      return null;
  }
}

/**
 * The conversation in order. Transcription arrives in fragments, so consecutive fragments from
 * one speaker join one entry until the turn ends; each tool call carries its result.
 */
export function voiceTimeline(
  lines: ReadonlyArray<VoiceLogLine>,
): ReadonlyArray<VoiceTimelineEntry> {
  const entries: Array<VoiceTimelineEntry> = [];
  const tools = new Map<string, number>();
  // Whether the last entry is a speaker's fragments that the next fragment from them continues.
  let speaking = false;
  for (const line of lines) {
    const last = entries.at(-1);
    switch (line.type) {
      case "heard":
      case "said": {
        const kind = line.type === "heard" ? "user" : "agent";
        const text = string(line.text);
        if (speaking && last?.kind === kind) {
          entries[entries.length - 1] = { ...last, text: `${last.text}${text}` };
        } else if (text.trim() !== "") {
          entries.push({ kind, at: line.at, text });
          speaking = true;
        }
        continue;
      }
      case "turn-complete":
        break;
      case "update":
        entries.push({ kind: "update", at: line.at, text: string(line.text) });
        break;
      case "dictation":
        entries.push({
          kind: "dictation",
          at: line.at,
          id: string(line.id),
          text: string(line.text),
          seconds: typeof line.seconds === "number" ? line.seconds : 0,
        });
        break;
      case "feedback":
        entries.push({
          kind: "feedback",
          at: line.at,
          id: string(line.id),
          text: string(line.text),
        });
        break;
      case "tool-call":
        tools.set(string(line.id), entries.length);
        entries.push({
          kind: "tool",
          at: line.at,
          id: string(line.id),
          name: string(line.name),
          args: JSON.stringify(line.args ?? {}, null, 2),
          result: null,
          failed: false,
          ms: null,
        });
        break;
      case "tool-result": {
        const index = tools.get(string(line.id));
        if (index === undefined) break;
        const call = entries[index];
        if (call?.kind !== "tool") break;
        const failed = typeof line.error === "string";
        entries[index] = {
          ...call,
          result: failed ? string(line.error) : string(line.output),
          failed,
          ms: typeof line.ms === "number" ? line.ms : null,
        };
        break;
      }
      default: {
        const shown = note(line);
        if (shown !== null) entries.push({ kind: "note", at: line.at, ...shown });
      }
    }
    // A turn ending, or anything else in between, starts the next fragment afresh.
    if (line.type !== "microphone") speaking = false;
  }
  return entries;
}

export function summarizeVoiceSession(
  lines: ReadonlyArray<VoiceLogLine>,
): VoiceSessionSummary | null {
  const first = lines[0];
  const last = lines.at(-1);
  if (first === undefined || last === undefined) return null;
  const heard = lines.find((line) => line.type === "heard" && string(line.text).trim() !== "");
  return {
    startedAt: first.at,
    endedAt: last.at,
    preview: heard === undefined ? null : string(heard.text).trim(),
    dictations: lines.filter((line) => line.type === "dictation").length,
    tools: lines.filter((line) => line.type === "tool-call").length,
    errors: lines.filter((line) => line.type === "error").length,
  };
}

/** The dictations in one session log, for building the history from logs kept before it. */
export function dictationsInLog(
  lines: ReadonlyArray<VoiceLogLine>,
  sessionLog: string,
): ReadonlyArray<DictationRecord> {
  return lines.flatMap((line) =>
    line.type === "dictation" && string(line.text) !== ""
      ? [
          {
            at: line.at,
            id: string(line.id),
            text: string(line.text),
            seconds: typeof line.seconds === "number" ? line.seconds : 0,
            sessionLog,
          },
        ]
      : [],
  );
}
