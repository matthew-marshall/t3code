import { describe, expect, it, vi } from "vite-plus/test";

import { locateInReadout, synthesizeSpeech, wavToPcm } from "./geminiSpeech.ts";

const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("read-aloud Gemini calls", () => {
  it("asks for one voice's audio and returns the PCM", async () => {
    const fetchImpl = respond({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: "audio/L16", data: "UENN" } }] } },
      ],
    });
    await expect(synthesizeSpeech("key", "Hello there.", "Charon", fetchImpl)).resolves.toBe(
      "UENN",
    );
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("gemini-3.8-flash-lite-tts:generateContent");
    expect(JSON.parse(init.body as string)).toMatchObject({
      contents: [{ parts: [{ text: "Hello there." }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
      },
    });
  });

  it("turns the located 1-based range into sentence indexes, clamped to the message", async () => {
    const answer = (value: object) =>
      respond({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] });
    const sentences = ["One.", "Two.", "Three.", "Four."];
    await expect(
      locateInReadout("key", sentences, "the end", answer({ found: true, start: 3, end: 9 })),
    ).resolves.toEqual({ found: true, start: 2, end: 3 });
    await expect(
      locateInReadout("key", sentences, "the table", answer({ found: false, reason: "No table." })),
    ).resolves.toEqual({ found: false, reason: "No table." });
    await expect(
      locateInReadout("key", sentences, "x", answer({ found: true, start: 0 })),
    ).resolves.toMatchObject({ found: false });
  });

  it("keeps only the samples of a WAV response, so its header is not played as noise", () => {
    const samples = [1, 2, 3, 4, 5, 6];
    const header = [
      ..."RIFF".split("").map((c) => c.charCodeAt(0)),
      36 + samples.length,
      0,
      0,
      0,
      ..."WAVEfmt ".split("").map((c) => c.charCodeAt(0)),
      16,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      0xc0,
      0x5d,
      0,
      0,
      0x80,
      0xbb,
      0,
      0,
      2,
      0,
      16,
      0,
      ..."data".split("").map((c) => c.charCodeAt(0)),
      samples.length,
      0,
      0,
      0,
    ];
    const wav = btoa(String.fromCharCode(...header, ...samples));
    expect(atob(wavToPcm(wav))).toBe(String.fromCharCode(...samples));
    // Raw PCM is left alone.
    expect(wavToPcm("AAECAw==")).toBe("AAECAw==");
  });
});
