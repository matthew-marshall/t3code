import type { VoiceAgentLogEvent, VoiceFeedback } from "@t3tools/client-runtime/voice-agent";
import { Directory, File, Paths } from "expo-file-system";

const DIRECTORY = "voice-logs";
const KEEP = 20;

/** What the app itself did, beside what the voice session logged. */
type VoiceControlEvent = { readonly type: "control"; readonly action: string };

let current: File | null = null;

function logDirectory(): Directory {
  const directory = new Directory(Paths.document, DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

/** Newest first. */
export function voiceSessionLogs(): ReadonlyArray<File> {
  try {
    return logDirectory()
      .list()
      .filter((entry): entry is File => entry instanceof File && entry.name.endsWith(".jsonl"))
      .sort((left, right) => right.name.localeCompare(left.name));
  } catch {
    return [];
  }
}

function startFile(): File {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = new File(logDirectory(), `voice-${stamp}.jsonl`);
  file.create({ overwrite: true });
  for (const old of voiceSessionLogs().slice(KEEP)) {
    try {
      old.delete();
    } catch {
      // A log that cannot be deleted is left for the next session.
    }
  }
  return file;
}

/**
 * Appends one event to the current session's log: a JSON line in Documents/voice-logs, kept for
 * the last 20 sessions. Each session (or start request) gets its own file. Holds the whole
 * conversation, including tool arguments and results, so it stays on the device unless shared.
 */
export function logVoiceEvent(event: VoiceAgentLogEvent | VoiceControlEvent): void {
  try {
    const starts =
      (event.type === "control" && event.action === "start requested") ||
      (event.type === "session-start" && current === null);
    if (starts || current === null) current = startFile();
    current.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, {
      append: true,
    });
    if (event.type === "session-end") current = null;
  } catch {
    // Logging must never break voice.
  }
}

const FEEDBACK_FILE = "feedback.jsonl";

/**
 * Keeps feedback in Documents/feedback.jsonl, which is never rotated out like the session logs,
 * with the session log it was given in, so its context can be found later.
 */
export function appendFeedback(feedback: VoiceFeedback): void {
  try {
    const file = new File(Paths.document, FEEDBACK_FILE);
    if (!file.exists) file.create();
    const line = {
      ...feedback,
      at: new Date(feedback.at).toISOString(),
      sessionLog: current?.name ?? null,
    };
    file.write(`${JSON.stringify(line)}\n`, { append: true });
  } catch {
    // Feedback is also in the session log.
  }
}
