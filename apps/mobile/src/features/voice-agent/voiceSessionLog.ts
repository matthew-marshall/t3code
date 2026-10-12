import type { VoiceAgentLogEvent } from "@t3tools/client-runtime/voice-agent";
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
