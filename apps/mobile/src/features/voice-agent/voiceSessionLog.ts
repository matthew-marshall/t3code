import type { VoiceAgentLogEvent, VoiceFeedback } from "@t3tools/client-runtime/voice-agent";
import { Directory, File, Paths } from "expo-file-system";

import { type DictationRecord, dictationsInLog, parseVoiceLog } from "./voiceSessionHistory";

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
    if (starts) current = startFile();
    // A dictation kept as the session ended belongs in that session's log.
    const file =
      current ??
      (event.type === "dictation" ? voiceSessionLogs()[0] : undefined) ??
      (current = startFile());
    const at = new Date().toISOString();
    file.write(`${JSON.stringify({ at, ...event })}\n`, { append: true });
    if (event.type === "dictation") {
      const { id, text, seconds } = event;
      appendDictation({ at, id, text, seconds, sessionLog: file.name });
    }
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

/** A session log's contents, or null once it has been rotated out. */
export async function readVoiceSessionLog(name: string): Promise<string | null> {
  try {
    const file = new File(logDirectory(), name);
    return file.exists ? await file.text() : null;
  } catch {
    return null;
  }
}

const DICTATIONS_FILE = "dictations.jsonl";

function dictationsFile(): File {
  return new File(Paths.document, DICTATIONS_FILE);
}

function writeDictations(file: File, dictations: ReadonlyArray<DictationRecord>): void {
  file.write(dictations.map((dictation) => `${JSON.stringify(dictation)}\n`).join(""));
}

/**
 * Starts the history from the dictations in the session logs still kept, so dictations from
 * before it existed are not lost.
 */
async function seedDictations(file: File): Promise<void> {
  const seeded: Array<DictationRecord> = [];
  const logs = voiceSessionLogs();
  // Oldest first, as the history is written.
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index]!;
    try {
      seeded.push(...dictationsInLog(parseVoiceLog(await log.text()), log.name));
    } catch {
      // An unreadable log has nothing to recover.
    }
  }
  if (!file.exists) file.create();
  writeDictations(file, seeded);
}

/**
 * Keeps every dictation in Documents/dictations.jsonl, which is not rotated out like the
 * session logs, so a dictation the agent never used can still be copied.
 */
function appendDictation(dictation: DictationRecord): void {
  try {
    const file = dictationsFile();
    // Before the history exists, the seed reads this dictation from its session log.
    if (!file.exists) return;
    file.write(`${JSON.stringify(dictation)}\n`, { append: true });
  } catch {
    // The dictation is also in the session log.
  }
}

/** The history oldest first, as it is written. */
async function readDictations(): Promise<ReadonlyArray<DictationRecord>> {
  const file = dictationsFile();
  if (!file.exists) await seedDictations(file);
  return (await file.text()).split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as DictationRecord;
      return typeof value.text === "string" && typeof value.at === "string" ? [value] : [];
    } catch {
      return [];
    }
  });
}

/** Every dictation, newest first. */
export async function dictationHistory(): Promise<ReadonlyArray<DictationRecord>> {
  const dictations = await readDictations();
  const newestFirst: Array<DictationRecord> = [];
  for (let index = dictations.length - 1; index >= 0; index -= 1) {
    newestFirst.push(dictations[index]!);
  }
  return newestFirst;
}

export async function deleteDictation(at: string): Promise<void> {
  const kept = (await readDictations()).filter((dictation) => dictation.at !== at);
  writeDictations(dictationsFile(), kept);
}
