import { describe, expect, it, vi } from "vite-plus/test";

import { createOpenAIVoiceProvider } from "./openaiRealtime.ts";

async function connect(apiKey: string | null = "sk-1", status = 200) {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ value: "ek_secret" }), { status }),
  );
  const sent: Array<Record<string, any>> = [];
  const provider = createOpenAIVoiceProvider({
    readApiKey: async () => apiKey,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const connection = await provider.connect((message) => sent.push(message as never));
  const receive = (event: Record<string, unknown>) => connection.receive(JSON.stringify(event));
  return { fetchImpl, sent, connection, receive, provider };
}

const setup = {
  instructions: "Be brief.",
  tools: [{ name: "list_threads", description: "List", parametersJsonSchema: { type: "object" } }],
  voice: "marin",
  pace: "fast" as const,
  language: "en-US",
  resumptionHandle: null,
  vocabulary: [],
};

describe("OpenAI Realtime provider", () => {
  it("opens with a client secret from the key, passed as a WebSocket subprotocol", async () => {
    const { fetchImpl, connection, provider } = await connect();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-1");
    expect(connection.url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1");
    expect(connection.protocols).toEqual(["realtime", "openai-insecure-api-key.ek_secret"]);
    expect(provider.inputSampleRate).toBe(24_000);
  });

  it("hints the transcription at names the user may say", async () => {
    const { sent, connection } = await connect();
    connection.setup({ ...setup, mode: "hands-free", vocabulary: ["halfos", "Amlogic"] });
    expect(sent[0]!.session.audio.input.transcription.prompt).toBe(
      "Names that may come up: halfos, Amlogic.",
    );
  });

  it("explains a missing or rejected key", async () => {
    await expect(connect(null)).rejects.toThrow("OpenAI API key");
    await expect(connect("sk-bad", 401)).rejects.toThrow("OpenAI rejected the API key");
  });

  it("sets up the session with the tools, voice and turn handling for the mode", async () => {
    const { sent, connection, receive } = await connect();
    connection.setup({ ...setup, mode: "hands-free" });
    expect(sent[0]).toMatchObject({
      type: "session.update",
      session: {
        instructions: "Be brief.",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { language: "en" },
            turn_detection: { type: "semantic_vad" },
          },
          output: { voice: "marin", speed: 1.2 },
        },
        tools: [{ type: "function", name: "list_threads", parameters: { type: "object" } }],
      },
    });
    expect(receive({ type: "session.created" })).toEqual([]);
    expect(receive({ type: "session.updated" })).toEqual([{ type: "ready" }]);
    expect(receive({ type: "session.updated" })).toEqual([]);

    const pushToTalk = await connect();
    pushToTalk.connection.setup({ ...setup, mode: "push-to-talk" });
    expect(pushToTalk.sent[0]!.session.audio.input.turn_detection).toBeNull();
  });

  it("translates speech, transcripts and tool calls into session events", async () => {
    const { receive } = await connect();
    expect(receive({ type: "input_audio_buffer.speech_started" })).toEqual([
      { type: "interrupted" },
    ]);
    expect(
      receive({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: " list my threads ",
      }),
    ).toEqual([{ type: "heard", text: "list my threads" }]);
    expect(receive({ type: "response.output_audio.delta", delta: "pcm" })).toEqual([
      { type: "audio", data: "pcm" },
    ]);
    expect(receive({ type: "response.output_audio_transcript.delta", delta: "Sure" })).toEqual([
      { type: "said", text: "Sure" },
    ]);
    expect(
      receive({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "list_threads",
          arguments: '{"query":"login"}',
        },
      }),
    ).toEqual([
      {
        type: "tool-calls",
        calls: [{ id: "call_1", name: "list_threads", args: { query: "login" } }],
      },
    ]);
    expect(receive({ type: "error", error: { message: "Bad item" } })).toEqual([
      { type: "error", message: "Bad item" },
    ]);
  });

  it("asks for the next response only once the current one is done", async () => {
    const { sent, connection, receive } = await connect();
    receive({ type: "response.created" });
    // A fast tool answers before the response that called it has ended.
    connection.sendToolResults([{ id: "call_1", name: "list_threads", output: "[]" }]);
    expect(sent.map((message) => message.type)).toEqual(["conversation.item.create"]);
    expect(sent[0]!.item).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "[]",
    });

    expect(receive({ type: "response.done" })).toEqual([{ type: "turn-complete" }]);
    expect(sent.at(-1)).toEqual({ type: "response.create" });

    // Nothing running: an app update gets its response right away.
    receive({ type: "response.done" });
    connection.sendText("[T3 update] Fix login finished.");
    expect(sent.slice(-2)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "[T3 update] Fix login finished." }],
        },
      },
      { type: "response.create" },
    ]);
  });
});
