import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Readout, type ReadoutState } from "./readout.ts";

// One second of 24 kHz 16-bit audio.
const SECOND = "A".repeat(64_000);

function setup(count = 4) {
  const played: Array<string> = [];
  const states: Array<ReadoutState> = [];
  const synthesize = vi.fn(async (text: string) => `${text}|${SECOND}`);
  const readout = new Readout(
    "Fix login",
    Array.from({ length: count }, (_, index) => ({
      text: `S${index}`,
      block: index,
      kind: "text" as const,
    })),
    {
      synthesize,
      play: (pcm) => played.push(pcm.split("|")[0]!),
      clearPlayback: vi.fn(),
      onChange: (state) => states.push(state),
      onError: vi.fn(),
    },
  );
  return { readout, played, states, synthesize };
}

describe("reading a message aloud", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads sentence by sentence, fetching the next while one plays, then finishes", async () => {
    const { readout, played, synthesize } = setup(3);
    readout.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(played).toEqual(["S0"]);
    expect(synthesize).toHaveBeenCalledWith("S1");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(played).toEqual(["S0", "S1", "S2"]);
    expect(readout.getState()).toMatchObject({ phase: "finished", index: 2 });
  });

  it("pauses on the current sentence, resumes there, and plays just a range", async () => {
    const { readout, played } = setup(6);
    readout.play();
    await vi.advanceTimersByTimeAsync(1_000);
    readout.pause();
    expect(readout.getState()).toMatchObject({ phase: "paused", index: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(played).toEqual(["S0", "S1"]);

    readout.play();
    await vi.advanceTimersByTimeAsync(0);
    expect(played.at(-1)).toBe("S1");

    readout.play(3, 4);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(played.slice(-2)).toEqual(["S3", "S4"]);
    expect(readout.getState()).toMatchObject({ phase: "finished", index: 4 });
  });

  it("speaks a paragraph's sentences from one request, and retries a refused one", async () => {
    const played: Array<string> = [];
    const synthesize = vi
      .fn<(text: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Gemini could not do that (429)."))
      .mockImplementation(async (text) => `${text}|${SECOND}`);
    const readout = new Readout(
      "Notes",
      [
        { text: "One.", block: 0, kind: "text" as const },
        { text: "Two.", block: 0, kind: "text" as const },
        { text: "Three.", block: 1, kind: "text" as const },
      ],
      {
        synthesize,
        play: (pcm) => played.push(pcm.split("|")[0]!),
        clearPlayback: vi.fn(),
        onChange: vi.fn(),
        onError: vi.fn(),
      },
    );
    readout.play();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(played).toEqual(["One. Two."]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(played).toEqual(["One. Two.", "Three."]);
    expect(readout.getState()).toMatchObject({ phase: "finished" });
  });
});
