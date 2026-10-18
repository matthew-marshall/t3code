import { describe, expect, it } from "vite-plus/test";

import {
  dictationsInLog,
  parseVoiceLog,
  summarizeVoiceSession,
  voiceTimeline,
} from "./voiceSessionHistory";

const log = [
  { at: "2026-10-18T14:25:45.097Z", type: "session-start", mode: "hands-free" },
  { at: "2026-10-18T14:25:45.551Z", type: "setup", resumed: false, systemInstruction: "…" },
  { at: "2026-10-18T14:26:07.479Z", type: "heard", text: "Read the latest " },
  { at: "2026-10-18T14:26:07.500Z", type: "microphone", status: "paused" },
  { at: "2026-10-18T14:26:07.520Z", type: "heard", text: "message." },
  {
    at: "2026-10-18T14:26:07.600Z",
    type: "tool-call",
    id: "call_1",
    name: "list_threads",
    args: { query: "5583" },
  },
  { at: "2026-10-18T14:26:07.700Z", type: "turn-complete" },
  {
    at: "2026-10-18T14:26:07.900Z",
    type: "tool-result",
    id: "call_1",
    name: "list_threads",
    ms: 6,
    output: '{"total":0}',
  },
  { at: "2026-10-18T14:26:08.000Z", type: "said", text: "Go " },
  { at: "2026-10-18T14:26:08.100Z", type: "said", text: "ahead." },
  { at: "2026-10-18T14:26:09.700Z", type: "turn-complete" },
  { at: "2026-10-18T14:26:10.000Z", type: "said", text: "Anything else?" },
  {
    at: "2026-10-18T14:34:49.730Z",
    type: "dictation",
    id: "d2",
    text: "Look for visual pops on the home screen.",
    endedBy: "phrase",
    seconds: 85,
  },
  {
    at: "2026-10-18T14:35:46.046Z",
    type: "connection",
    status: "closed",
    detail: "The service is currently unavailable.",
  },
  { at: "2026-10-18T14:35:46.480Z", type: "connection", status: "live" },
  { at: "2026-10-18T14:46:32.169Z", type: "error", message: "Already connected" },
];

const text = `${log.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`;

describe("voice session history", () => {
  it("reads a session log as the conversation, with each tool call's result", () => {
    const entries = voiceTimeline(parseVoiceLog(text));
    expect(entries.map((entry) => [entry.kind, "text" in entry ? entry.text : entry.name])).toEqual(
      [
        ["note", "Started, hands-free"],
        // Fragments join across a microphone pause, but not across a turn.
        ["user", "Read the latest message."],
        ["tool", "list_threads"],
        ["agent", "Go ahead."],
        ["agent", "Anything else?"],
        ["dictation", "Look for visual pops on the home screen."],
        ["note", "Connection closed: The service is currently unavailable."],
        ["note", "Already connected"],
      ],
    );
    expect(entries[2]).toMatchObject({ result: '{"total":0}', failed: false, ms: 6 });
    expect(entries.at(-1)).toMatchObject({ error: true });
  });

  it("summarizes a session for the list", () => {
    expect(summarizeVoiceSession(parseVoiceLog(text))).toEqual({
      startedAt: "2026-10-18T14:25:45.097Z",
      endedAt: "2026-10-18T14:46:32.169Z",
      preview: "Read the latest",
      dictations: 1,
      tools: 1,
      errors: 1,
    });
    expect(summarizeVoiceSession([])).toBeNull();
  });

  it("finds the dictations in a log, to start the history from logs kept before it", () => {
    expect(dictationsInLog(parseVoiceLog(text), "voice-a.jsonl")).toEqual([
      {
        at: "2026-10-18T14:34:49.730Z",
        id: "d2",
        text: "Look for visual pops on the home screen.",
        seconds: 85,
        sessionLog: "voice-a.jsonl",
      },
    ]);
  });
});
