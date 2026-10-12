import { describe, expect, it, vi } from "vite-plus/test";

import { GEMINI_LIVE_URL } from "./gemini.ts";
import type { VoiceAgentMode } from "./liveProtocol.ts";
import {
  VoiceAgentSessionController,
  type VoiceAgentSocket,
  type VoiceAgentSocketHandlers,
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
  const toolCalls: Array<Record<string, unknown>> = [];
  let tokens = 0;
  let onChunk: ((chunk: string) => void) | null = null;
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
  };
  const controller = new VoiceAgentSessionController(
    {
      requestToken: async () => `token-${++tokens}`,
      instructions: "Be brief.",
      tools: [
        {
          declaration: { name: "list_threads", description: "List", parametersJsonSchema: {} },
          run: async (args) => {
            toolCalls.push(args);
            return '{"threads":[]}';
          },
        },
        {
          declaration: { name: "open_thread", description: "Open", parametersJsonSchema: {} },
          run: async (args) => `opened ${String(args.title)}`,
        },
      ],
      describeContext: () => "Thread: Fix login",
      openSocket: (url, handlers) => {
        const socket = new FakeSocket(url, handlers);
        sockets.push(socket);
        return socket;
      },
      audio,
      onStateChange: (state) => states.push(state),
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
    toolCalls,
    audio,
    connect,
    speak: (chunk: string) => onChunk?.(chunk),
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
    expect(setup!.setup.systemInstruction.parts[0].text).toContain("Be brief.");
    expect(setup!.setup.systemInstruction.parts[0].text).toContain("Thread: Fix login");
    expect(setup!.setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(false);
    expect(h.controller.getState().phase).toBe("live");

    h.speak("pcm");
    expect(socket.sentOf("realtimeInput").at(-1)!.realtimeInput.audio.data).toBe("pcm");
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
        requestToken: async () => {
          throw new Error("Add a Gemini API key in Settings → Voice agent.");
        },
        instructions: "",
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
