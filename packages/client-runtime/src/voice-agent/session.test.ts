import { describe, expect, it, vi } from "vite-plus/test";

import { createGeminiVoiceProvider, GEMINI_LIVE_URL } from "./gemini.ts";
import { voiceAgentStatus } from "./presentation.ts";
import type { VoiceAgentMode } from "./liveProtocol.ts";
import { type VoiceDictationMode, VoiceDictationStore } from "./dictation.ts";
import {
  VoiceAgentSessionController,
  type VoiceAgentSocket,
  type VoiceAgentSocketHandlers,
  type VoiceAgentLogEvent,
  type VoiceAgentState,
} from "./session.ts";

class FakeSocket implements VoiceAgentSocket {
  readonly sent: Array<Record<string, any>> = [];
  closed = false;

  readonly url: string;
  private readonly handlers: VoiceAgentSocketHandlers;

  constructor(url: string, handlers: VoiceAgentSocketHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  open(): void {
    this.handlers.onOpen();
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  receive(message: object): void {
    this.handlers.onMessage(new TextEncoder().encode(JSON.stringify(message)).buffer);
  }
  sentOf(key: string): Array<Record<string, any>> {
    return this.sent.filter((message) => key in message);
  }
}

// Settles the controller's promise chains; nothing here waits on real time.
const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

function harness(mode: VoiceAgentMode = "hands-free") {
  const sockets: Array<FakeSocket> = [];
  const states: Array<VoiceAgentState> = [];
  const events: Array<VoiceAgentLogEvent> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  let listThreadsHangs = false;
  let tokens = 0;
  let onChunk: ((chunk: string, level: number) => void) | null = null;
  let onCaptureError: ((message: string) => void) | null = null;
  const audio = {
    startCapture: vi.fn(
      async (listener: (chunk: string) => void, onError: (message: string) => void) => {
        onChunk = listener;
        onCaptureError = onError;
      },
    ),
    stopCapture: vi.fn(async () => {
      onChunk = null;
      onCaptureError = null;
    }),
    play: vi.fn(),
    clearPlayback: vi.fn(),
    playChime: vi.fn(),
    startPhraseListener: vi.fn(
      async (_locale: string, listener: (text: string, isFinal: boolean) => void) => {
        onSpeech = listener;
      },
    ),
    stopPhraseListener: vi.fn(async () => heard),
    startRecordingFile: vi.fn(async () => {}),
    stopRecordingFile: vi.fn(async () => ({ uri: "file:///dictation.m4a", mimeType: "audio/mp4" })),
    setRemoteControl: vi.fn((onPress: (() => void) | null) => {
      remotePress = onPress;
    }),
  };
  let onSpeech: ((text: string, isFinal: boolean) => void) | null = null;
  let remotePress: (() => void) | null = null;
  let heard = "";
  const dictations = new VoiceDictationStore();
  const dictation = {
    store: dictations,
    mode: vi.fn((): VoiceDictationMode => "gemini-batch"),
    transcribeRecording: vi.fn(async () => "Add a retry to the upload, stop dictation."),
  };
  const controller = new VoiceAgentSessionController(
    {
      provider: createGeminiVoiceProvider({
        readApiKey: async () => "key",
        fetchImpl: (async () =>
          new Response(JSON.stringify({ name: `token-${++tokens}` }))) as unknown as typeof fetch,
      }),
      instructions: "Be brief.",
      language: "en-US",
      tools: [
        {
          declaration: { name: "list_threads", description: "List", parametersJsonSchema: {} },
          run: async (args) => {
            toolCalls.push(args);
            if (listThreadsHangs) await new Promise(() => {});
            return '{"threads":[]}';
          },
        },
        {
          declaration: { name: "open_thread", description: "Open", parametersJsonSchema: {} },
          run: async (args) => `opened ${String(args.title)}`,
        },
      ],
      describeContext: () => "Thread: Fix login",
      openSocket: (url, _protocols, handlers) => {
        const socket = new FakeSocket(url, handlers);
        sockets.push(socket);
        return socket;
      },
      audio,
      dictation,
      onStateChange: (state) => states.push(state),
      onEvent: (event) => events.push(event),
    },
    mode,
  );
  const connect = async () => {
    const socket = sockets.at(-1)!;
    socket.open();
    socket.receive({ setupComplete: {} });
    await flush();
    return socket;
  };
  return {
    controller,
    sockets,
    states,
    events,
    toolCalls,
    hangListThreads: () => {
      listThreadsHangs = true;
    },
    audio,
    dictation,
    dictations,
    /** A steering-wheel or headphone play/pause press. */
    pressRemote: () => remotePress?.(),
    /** On-device speech hears `text` so far during dictation. */
    hear: (text: string) => {
      heard = text;
      onSpeech?.(text, false);
    },
    connect,
    // Speech is well above the hands-free threshold unless a test says otherwise.
    speak: (chunk: string, level = -20) => onChunk?.(chunk, level),
    loseMicrophone: (message: string) => onCaptureError?.(message),
  };
}

describe("VoiceAgentSessionController", () => {
  it("opens the connection with the tools, instructions and screen context", async () => {
    const h = harness();
    await h.controller.start();
    const socket = await h.connect();

    expect(socket.url).toBe(`${GEMINI_LIVE_URL}?access_token=token-1`);
    const [setup] = socket.sentOf("setup");
    expect(setup!.setup.model).toBe("models/gemini-3.8-live");
    expect(setup!.setup.tools[0].functionDeclarations.map((tool: any) => tool.name)).toEqual([
      "list_threads",
      "open_thread",
    ]);
    expect(setup!.setup.tools[1]).toEqual({ googleSearch: {} });
    expect(setup!.setup.systemInstruction.parts[0].text).toContain("Be brief.");
    expect(setup!.setup.systemInstruction.parts[0].text).toContain("Thread: Fix login");
    expect(setup!.setup.systemInstruction.parts[0].text).toContain('"en-US". Always reply in it');
    expect(setup!.setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(false);
    expect(h.controller.getState().phase).toBe("live");

    h.speak("pcm");
    expect(socket.sentOf("realtimeInput").at(-1)!.realtimeInput.audio.data).toBe("pcm");
  });

  it("reports each step of starting, so the control can show progress", async () => {
    const h = harness();
    await h.controller.start();
    expect(h.controller.getState()).toMatchObject({ phase: "connecting", progress: "connecting" });
    await h.connect();

    const steps = h.states
      .map((state) => `${state.phase}:${state.progress}`)
      .filter((step, index, all) => step !== all[index - 1]);
    expect(steps).toEqual([
      "connecting:null",
      "connecting:token",
      "connecting:connecting",
      "connecting:setup",
      "live:microphone",
      "live:null",
    ]);
    expect(voiceAgentStatus(h.controller.getState())).toBe("Listening");
  });

  it("logs what the agent was told, heard, called and got back", async () => {
    const h = harness();
    await h.controller.start();
    const socket = await h.connect();
    socket.receive({ serverContent: { inputTranscription: { text: "list my threads" } } });
    socket.receive({
      toolCall: { functionCalls: [{ id: "a", name: "list_threads", args: { query: "login" } }] },
    });
    await flush();
    socket.receive({ serverContent: { turnComplete: true } });
    h.controller.sendUpdate("Fix login finished.");
    await h.controller.stop();

    const types = h.events.map((event) => event.type);
    expect(types).toEqual([
      "session-start",
      "connection",
      "setup",
      "connection",
      "heard",
      "tool-call",
      "tool-result",
      "turn-complete",
      "update",
      "session-end",
    ]);
    expect(h.events.find((event) => event.type === "setup")).toMatchObject({
      systemInstruction: expect.stringContaining("Be brief."),
      tools: ["list_threads", "open_thread"],
    });
    expect(h.events.find((event) => event.type === "tool-call")).toMatchObject({
      name: "list_threads",
      args: { query: "login" },
    });
    expect(h.events.find((event) => event.type === "tool-result")).toMatchObject({
      output: '{"threads":[]}',
    });
  });

  it("answers tool calls, and reports an unknown tool as an error", async () => {
    const h = harness();
    await h.controller.start();
    const socket = await h.connect();

    socket.receive({
      toolCall: {
        functionCalls: [
          { id: "a", name: "list_threads", args: { limit: 3 } },
          { id: "b", name: "open_thread", args: { title: "Fix login" } },
          { id: "c", name: "delete_everything", args: {} },
        ],
      },
    });
    await flush();

    expect(h.toolCalls).toEqual([{ limit: 3 }]);
    expect(socket.sentOf("toolResponse")[0]!.toolResponse.functionResponses).toEqual([
      { id: "a", name: "list_threads", response: { output: '{"threads":[]}' } },
      { id: "b", name: "open_thread", response: { output: "opened Fix login" } },
      {
        id: "c",
        name: "delete_everything",
        response: { error: "There is no tool named delete_everything." },
      },
    ]);
    expect(h.controller.getState().runningTools).toEqual([]);
  });

  it("reports a tool that never finishes as unknown instead of leaving the agent waiting", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.hangListThreads();
      await h.controller.start();
      const socket = await h.connect();
      socket.receive({ toolCall: { functionCalls: [{ id: "a", name: "list_threads" }] } });
      await vi.advanceTimersByTimeAsync(30_000);

      const [response] = socket.sentOf("toolResponse");
      expect(response!.toolResponse.functionResponses[0].response.error).toContain(
        "whether it worked is unknown",
      );
      expect(h.controller.getState().runningTools).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not answer a tool call the server cancelled", async () => {
    const h = harness();
    await h.controller.start();
    const socket = await h.connect();

    socket.receive({
      toolCall: { functionCalls: [{ id: "a", name: "list_threads", args: {} }] },
    });
    socket.receive({ toolCallCancellation: { ids: ["a"] } });
    await flush();

    expect(socket.sentOf("toolResponse")).toEqual([]);
  });

  it("sends audio only while push-to-talk is held, and interrupts the agent on press", async () => {
    const h = harness("push-to-talk");
    await h.controller.start();
    const socket = await h.connect();
    expect(socket.sentOf("setup")[0]!.setup.realtimeInputConfig).toEqual({
      automaticActivityDetection: { disabled: true },
    });

    h.speak("ignored");
    h.controller.beginTalking();
    h.speak("heard");
    h.controller.endTalking();
    h.speak("ignored-again");

    expect(socket.sentOf("realtimeInput").map((message) => message.realtimeInput)).toEqual([
      { activityStart: {} },
      { audio: { data: "heard", mimeType: "audio/pcm;rate=16000" } },
      { activityEnd: {} },
    ]);
    expect(h.audio.clearPlayback).toHaveBeenCalled();
  });

  it("plays speech and drops it when the agent is interrupted", async () => {
    const h = harness();
    await h.controller.start();
    const socket = await h.connect();

    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "pcm" } }] } } });
    expect(h.audio.play).toHaveBeenCalledWith("pcm");
    expect(h.controller.getState().agentSpeaking).toBe(true);

    socket.receive({ serverContent: { interrupted: true } });
    expect(h.audio.clearPlayback).toHaveBeenCalled();
    expect(h.controller.getState().agentSpeaking).toBe(false);
  });

  it("hands-free, sends the microphone only around speech, starting just before it", async () => {
    const h = harness();
    await h.controller.start();
    const socket = await h.connect();
    const sent = () => socket.sentOf("realtimeInput").map((message) => message.realtimeInput);

    for (let index = 1; index <= 7; index += 1) h.speak(`quiet-${index}`, -60);
    expect(sent()).toEqual([]);

    h.speak("hello", -25);
    // The half second before speech goes first, so the start of the word is not clipped.
    expect(sent().map((input) => input.audio.data)).toEqual([
      "quiet-3",
      "quiet-4",
      "quiet-5",
      "quiet-6",
      "quiet-7",
      "hello",
    ]);

    // Pauses inside speech keep sending; a second and a half of quiet ends it.
    for (let index = 0; index < 14; index += 1) h.speak("pause", -60);
    expect(sent().at(-1)).toMatchObject({ audio: { data: "pause" } });
    h.speak("pause", -60);
    expect(sent().at(-1)).toEqual({ audioStreamEnd: true });
    h.speak("after", -60);
    expect(sent()).toHaveLength(6 + 15 + 1);
    expect(h.events.filter((event) => event.type === "microphone")).toEqual([
      { type: "microphone", status: "speech", level: -25 },
      { type: "microphone", status: "paused" },
    ]);
  });

  describe("dictation", () => {
    const texts = (socket: FakeSocket) =>
      socket
        .sentOf("realtimeInput")
        .filter((message) => "text" in message.realtimeInput)
        .map((message) => message.realtimeInput.text as string);

    it("keeps the microphone from the agent until the user says stop dictation, then hands it the transcript", async () => {
      vi.useFakeTimers();
      const h = harness();
      await h.controller.start();
      const socket = await h.connect();
      h.controller.startDictation();
      await flush();
      expect(h.audio.playChime).toHaveBeenLastCalledWith("start");
      expect(h.audio.startRecordingFile).toHaveBeenCalled();
      expect(h.controller.getState().dictation).toMatchObject({ phase: "recording" });

      const audioBefore = socket.sentOf("realtimeInput").length;
      h.speak("pcm");
      // The agent neither hears the dictation nor speaks over it.
      socket.receive({
        serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } },
      });
      expect(socket.sentOf("realtimeInput")).toHaveLength(audioBefore);
      expect(h.audio.play).not.toHaveBeenCalled();
      h.controller.sendUpdate("Fix login finished.");

      h.hear("add a retry to the upload stop dictation");
      // It waits for a pause after the phrase.
      expect(h.audio.playChime).toHaveBeenLastCalledWith("start");
      await vi.advanceTimersByTimeAsync(800);
      expect(h.audio.playChime).toHaveBeenLastCalledWith("end");
      expect(h.dictation.transcribeRecording).toHaveBeenCalledWith({
        uri: "file:///dictation.m4a",
        mimeType: "audio/mp4",
      });
      expect(h.dictations.get("latest")).toMatchObject({
        id: "d1",
        text: "Add a retry to the upload",
      });
      const [dictated, update] = texts(socket);
      expect(dictated).toContain("[T3 dictation d1]");
      expect(dictated).toContain('"""Add a retry to the upload"""');
      // The held update follows once the dictation is in.
      expect(update).toBe("[T3 update] Fix login finished.");
      expect(h.controller.getState().dictation).toBeNull();
      vi.useRealTimers();
    });

    it("ignores stop dictation said mid-sentence, and finishes on a play/pause press", async () => {
      vi.useFakeTimers();
      try {
        const h = harness();
        await h.controller.start();
        await h.connect();
        h.controller.startDictation();
        await vi.advanceTimersByTimeAsync(0);
        h.hear("we should stop dictation");
        await vi.advanceTimersByTimeAsync(300);
        h.hear("we should stop dictation from cutting off");
        await vi.advanceTimersByTimeAsync(2_000);
        expect(h.controller.getState().dictation).toMatchObject({ phase: "recording" });

        h.pressRemote();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.dictations.get("latest")).toBeTruthy();
        expect(h.events.find((event) => event.type === "dictation")).toMatchObject({
          endedBy: "remote",
        });
        expect(h.audio.setRemoteControl).toHaveBeenLastCalledWith(null);
      } finally {
        vi.useRealTimers();
      }
    });

    it("starts an agent-requested dictation only once the agent has finished speaking", async () => {
      vi.useFakeTimers();
      try {
        const h = harness();
        await h.controller.start();
        const socket = await h.connect();
        socket.receive({
          serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] } },
        });
        expect(h.controller.requestDictation()).toContain("Go ahead");
        expect(h.audio.startPhraseListener).not.toHaveBeenCalled();
        socket.receive({ serverContent: { turnComplete: true } });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(h.audio.startPhraseListener).toHaveBeenCalled();
        expect(h.audio.playChime).toHaveBeenLastCalledWith("start");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the on-device transcript when Gemini cannot transcribe the recording", async () => {
      const h = harness();
      await h.controller.start();
      await h.connect();
      h.dictation.transcribeRecording.mockRejectedValueOnce(new Error("rate limited"));
      h.controller.startDictation();
      await flush();
      h.hear("um call the client tomorrow");
      h.controller.finishDictation();
      await flush();
      expect(h.dictations.get("d1")?.text).toBe("um call the client tomorrow");
      expect(h.events.some((event) => event.type === "dictation-error")).toBe(true);
    });
  });

  it("holds app updates until the agent has finished speaking, so they never cut it off", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      await h.controller.start();
      const socket = await h.connect();
      const updates = () =>
        socket.sentOf("realtimeInput").filter((message) => "text" in message.realtimeInput);
      // One second of 24 kHz 16-bit speech.
      const second = "A".repeat(64_000);

      socket.receive({
        serverContent: { modelTurn: { parts: [{ inlineData: { data: second } }] } },
      });
      h.controller.sendUpdate("Fix login finished.");
      h.controller.sendUpdate("Billing needs approval.");
      socket.receive({ serverContent: { turnComplete: true } });
      // The turn is done, but its speech is still playing.
      expect(updates()).toEqual([]);

      vi.advanceTimersByTime(1_600);
      expect(updates().map((message) => message.realtimeInput.text)).toEqual([
        "[T3 update] Fix login finished.\n[T3 update] Billing needs approval.",
      ]);

      // A turn that never reports done still lets the update through eventually.
      socket.receive({ serverContent: { inputTranscription: { text: "hmm" } } });
      h.controller.sendUpdate("Docs finished.");
      expect(updates()).toHaveLength(1);
      vi.advanceTimersByTime(20_000);
      expect(updates().at(-1)!.realtimeInput.text).toBe("[T3 update] Docs finished.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins transcription fragments per speaker", async () => {
    const h = harness();
    await h.controller.start();
    const socket = await h.connect();

    socket.receive({ serverContent: { inputTranscription: { text: "What is " } } });
    socket.receive({ serverContent: { inputTranscription: { text: "running?" } } });
    socket.receive({ serverContent: { outputTranscription: { text: "Two threads." } } });

    expect(h.controller.getState().transcript.map(({ role, text }) => [role, text])).toEqual([
      ["user", "What is running?"],
      ["agent", "Two threads."],
    ]);
  });

  it("moves the conversation to a new connection with a fresh token when told to go away", async () => {
    const h = harness();
    await h.controller.start();
    const first = await h.connect();

    first.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "handle-1" } });
    first.receive({ goAway: { timeLeft: "5s" } });
    await flush();

    expect(first.closed).toBe(true);
    const second = h.sockets[1]!;
    expect(second.url).toBe(`${GEMINI_LIVE_URL}?access_token=token-2`);
    second.open();
    expect(second.sentOf("setup")[0]!.setup.sessionResumption).toEqual({ handle: "handle-1" });
    second.receive({ setupComplete: {} });
    expect(h.controller.getState().phase).toBe("live");
    expect(h.audio.startCapture).toHaveBeenCalledTimes(1);
  });

  it("switches modes on a fresh session that is told the conversation so far", async () => {
    const h = harness("push-to-talk");
    await h.controller.start();
    const first = await h.connect();
    first.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "handle-1" } });
    first.receive({ serverContent: { inputTranscription: { text: "What is running?" } } });
    first.receive({ serverContent: { outputTranscription: { text: "Two threads." } } });

    await h.controller.setMode("hands-free");
    await flush();

    expect(first.closed).toBe(true);
    const second = h.sockets[1]!;
    second.open();
    const { setup } = second.sentOf("setup")[0]!;
    expect(setup.sessionResumption).toEqual({});
    expect(setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(false);
    expect(setup.systemInstruction.parts[0].text).toContain(
      "The conversation so far:\nUser: What is running?\nYou: Two threads.",
    );
  });

  it("speaks with the chosen voice and pace, starting fresh when they change", async () => {
    const h = harness();
    await h.controller.setSpeech({ voice: "Puck", pace: "fast" });
    await h.controller.start();
    const first = await h.connect();
    const { setup } = first.sentOf("setup")[0]!;
    expect(setup.generationConfig.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
    });
    expect(setup.systemInstruction.parts[0].text).toContain("Speak quickly");

    first.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "handle-1" } });
    await h.controller.setSpeech({ voice: null, pace: "normal" });
    await flush();
    const second = h.sockets[1]!;
    second.open();
    const next = second.sentOf("setup")[0]!.setup;
    expect(next.sessionResumption).toEqual({});
    expect(next.generationConfig.speechConfig).toBeUndefined();
    expect(next.systemInstruction.parts[0].text).not.toContain("Speak quickly");
  });

  it("restarts once when several settings change together", async () => {
    const h = harness();
    await h.controller.start();
    await h.connect();
    await Promise.all([
      h.controller.setProvider(
        createGeminiVoiceProvider({ readApiKey: async () => "key" }) as never,
      ),
      h.controller.setSpeech({ voice: "Puck", pace: "normal" }),
      h.controller.setMode("push-to-talk"),
    ]);
    await flush();
    // The provider id did not change, so only voice and mode asked for a restart: one socket.
    expect(h.sockets).toHaveLength(2);
  });

  it("ends the session when the microphone is lost mid-conversation", async () => {
    const h = harness();
    await h.controller.start();
    const socket = await h.connect();
    h.loseMicrophone("Lost the microphone.");
    await flush();
    expect(h.controller.getState()).toMatchObject({
      phase: "error",
      error: "Lost the microphone.",
    });
    expect(socket.closed).toBe(true);
    expect(h.audio.stopCapture).toHaveBeenCalled();
  });

  it("reports a failure to start and releases the microphone on stop", async () => {
    const h = harness();
    await h.controller.start();
    await h.connect();
    await h.controller.stop();
    expect(h.audio.stopCapture).toHaveBeenCalled();
    expect(h.controller.getState().phase).toBe("idle");

    const failing = new VoiceAgentSessionController(
      {
        provider: createGeminiVoiceProvider({ readApiKey: async () => null }),
        instructions: "",
        language: "en-US",
        tools: [],
        openSocket: () => {
          throw new Error("unused");
        },
        audio: h.audio,
        onStateChange: () => {},
      },
      "hands-free",
    );
    await failing.start();
    expect(failing.getState()).toMatchObject({
      phase: "error",
      error: "Add a Gemini API key in Settings → Voice agent.",
    });
  });
});
