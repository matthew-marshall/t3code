import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { type VoiceAgentCue, VoiceAgentCues } from "./cues.ts";

function setup() {
  const played: Array<VoiceAgentCue> = [];
  let quiet = true;
  let enabled = true;
  const cues = new VoiceAgentCues({
    play: (cue) => played.push(cue),
    quiet: () => quiet,
    enabled: () => enabled,
    now: () => DateTime.toEpochMillis(DateTime.nowUnsafe()),
  });
  return {
    cues,
    played,
    setQuiet: (value: boolean) => {
      quiet = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

describe("voice agent sound cues", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("blips once for a quick tool, and marks a slow one's start, progress and end", () => {
    const { cues, played } = setup();
    cues.toolStarted();
    vi.advanceTimersByTime(100);
    cues.toolFinished();
    expect(played).toEqual(["tool"]);

    played.length = 0;
    cues.toolStarted();
    vi.advanceTimersByTime(400 + 1500 * 2);
    cues.toolFinished();
    vi.advanceTimersByTime(5000);
    expect(played).toEqual(["tool-start", "working", "working", "tool-end"]);
  });

  it("ticks while a heard turn awaits a reply, and stops when the agent answers", () => {
    const { cues, played } = setup();
    cues.awaitReply();
    vi.advanceTimersByTime(3000);
    cues.replied();
    vi.advanceTimersByTime(5000);
    expect(played).toEqual(["working", "working"]);

    // No reply at all: it gives up rather than tick forever.
    played.length = 0;
    cues.awaitReply();
    vi.advanceTimersByTime(30_000);
    expect(played.length).toBeLessThanOrEqual(8);
  });

  it("stays silent over speech and when turned off, but always reports the connection", () => {
    const { cues, played, setQuiet, setEnabled } = setup();
    setQuiet(false);
    cues.toolStarted();
    cues.toolFinished();
    cues.connectionDropped();
    cues.connectionDropped();
    cues.connectionLive();
    expect(played).toEqual(["connection-lost", "connection-back"]);

    setQuiet(true);
    setEnabled(false);
    cues.connectionDropped();
    cues.failed();
    expect(played).toEqual(["connection-lost", "connection-back"]);
  });
});
