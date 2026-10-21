import { describe, expect, it, vi } from "vite-plus/test";

import { createGeminiVoiceTranscriber } from "./geminiTranscriber.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

const completed = (text: string) => ({
  id: "interactions/1",
  status: "completed",
  steps: [{ id: "step_1", type: "model_output", content: [{ type: "text", text }] }],
});

function setup(
  response: { status: number; body: unknown },
  apiKey: string | null = "key-1",
  vocabulary?: () => ReadonlyArray<string>,
) {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify(response.body), { status: response.status }),
  );
  const transcriber = createGeminiVoiceTranscriber({
    readApiKey: async () => apiKey,
    readRecording: async () => ({ data: "QUFBQQ==", mimeType: "audio/m4a" }),
    locale: "en-US",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...(vocabulary ? { vocabulary } : {}),
  });
  const signal = new AbortController().signal;
  const run = async () =>
    (await transcriber.prepare({ signal })).transcribe("file:///a.m4a", { signal });
  return { fetchImpl, transcriber, run };
}

describe("createGeminiVoiceTranscriber", () => {
  it("sends the recording inline in smart mode and returns the transcript", async () => {
    const { fetchImpl, run } = setup({
      status: 200,
      body: completed("Add a retry to the upload."),
    });
    await expect(run()).resolves.toBe("Add a retry to the upload.");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("key-1");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gemini-3.5-transcribe",
      input: [{ type: "audio", data: "QUFBQQ==", mime_type: "audio/m4a" }],
      generation_config: { transcription_config: { mode: "smart" } },
    });
  });

  it("passes the vocabulary, so names are not misheard", async () => {
    const { fetchImpl, run } = setup(
      { status: 200, body: completed("Open halfos.") },
      "key-1",
      () => ["halfos", "Amlogic"],
    );
    await run();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).generation_config).toEqual({
      transcription_config: { mode: "smart", custom_vocabulary: ["halfos", "Amlogic"] },
    });
  });

  it("asks for a key before recording starts", async () => {
    const { transcriber, fetchImpl } = setup({ status: 200, body: completed("x") }, null);
    const error = await transcriber
      .prepare({ signal: new AbortController().signal })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({
      code: "unavailable",
      displayMessage: expect.stringContaining("Gemini API key"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains a rejected key, even when Google answers 400", async () => {
    const { run } = setup({ status: 400, body: { error: { message: "API key not valid." } } });
    await expect(run()).rejects.toMatchObject({
      code: "transcription-failed",
      displayMessage: "Gemini rejected the API key. Check it in Settings → Voice Agent.",
    });
  });

  it("passes on Google's reason for other failures", async () => {
    const { run } = setup({ status: 400, body: { error: { message: "Audio too long." } } });
    await expect(run()).rejects.toMatchObject({
      displayMessage: "Gemini could not transcribe this recording: Audio too long.",
    });
  });

  it("reports a cancelled transcription as cancelled", async () => {
    const { transcriber } = setup({ status: 200, body: completed("x") });
    const controller = new AbortController();
    const prepared = await transcriber.prepare({ signal: controller.signal });
    controller.abort();
    await expect(
      prepared.transcribe("file:///a.m4a", { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "cancelled",
    });
  });
});
