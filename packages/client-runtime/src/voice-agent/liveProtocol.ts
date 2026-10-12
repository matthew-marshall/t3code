/**
 * The Gemini Live WebSocket messages the voice session sends and reads.
 * Only the fields the session uses are typed; see
 * https://ai.google.dev/api/live for the full protocol.
 */

export type VoiceAgentMode = "push-to-talk" | "hands-free";

/** A tool the model may call; `parametersJsonSchema` is the arguments' JSON Schema. */
export interface VoiceAgentFunctionDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parametersJsonSchema: unknown;
}

const LIVE_INPUT_SAMPLE_RATE = 16_000;
export const LIVE_OUTPUT_SAMPLE_RATE = 24_000;

export function liveSocketUrl(websocketUrl: string, token: string): string {
  return `${websocketUrl}?access_token=${encodeURIComponent(token)}`;
}

export function liveSetupMessage(input: {
  readonly model: string;
  readonly systemInstruction: string;
  readonly tools: ReadonlyArray<VoiceAgentFunctionDeclaration>;
  readonly mode: VoiceAgentMode;
  readonly voice: string | null;
  readonly resumptionHandle: string | null;
}) {
  return {
    setup: {
      model: input.model.startsWith("models/") ? input.model : `models/${input.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        ...(input.voice === null
          ? {}
          : { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } } } }),
      },
      systemInstruction: { parts: [{ text: input.systemInstruction }] },
      tools: [{ functionDeclarations: input.tools }],
      // Push-to-talk marks turns itself, so the server must not cut them on silence.
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: input.mode === "push-to-talk" },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Connections last about ten minutes; a handle carries the conversation to the next one.
      sessionResumption: input.resumptionHandle === null ? {} : { handle: input.resumptionHandle },
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

export function liveAudioMessage(base64Pcm: string) {
  return {
    realtimeInput: {
      audio: { data: base64Pcm, mimeType: `audio/pcm;rate=${LIVE_INPUT_SAMPLE_RATE}` },
    },
  };
}

export function liveTextMessage(text: string) {
  return { realtimeInput: { text } };
}

export const liveActivityStartMessage = { realtimeInput: { activityStart: {} } };
export const liveActivityEndMessage = { realtimeInput: { activityEnd: {} } };

export interface LiveFunctionResponse {
  readonly id: string;
  readonly name: string;
  readonly response: { readonly output: string } | { readonly error: string };
}

export function liveToolResponseMessage(functionResponses: ReadonlyArray<LiveFunctionResponse>) {
  return { toolResponse: { functionResponses } };
}

export interface LiveFunctionCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface LiveServerMessage {
  readonly setupComplete?: unknown;
  readonly serverContent?: {
    readonly modelTurn?: {
      readonly parts?: ReadonlyArray<{
        readonly inlineData?: { readonly data?: string; readonly mimeType?: string };
      }>;
    };
    readonly interrupted?: boolean;
    readonly turnComplete?: boolean;
    readonly inputTranscription?: { readonly text?: string };
    readonly outputTranscription?: { readonly text?: string };
  };
  readonly toolCall?: { readonly functionCalls?: ReadonlyArray<LiveFunctionCall> };
  readonly toolCallCancellation?: { readonly ids?: ReadonlyArray<string> };
  readonly goAway?: { readonly timeLeft?: string };
  readonly sessionResumptionUpdate?: {
    readonly newHandle?: string;
    readonly resumable?: boolean;
  };
}

const textDecoder = new TextDecoder();

/** Live sends JSON as text or binary frames depending on the platform's WebSocket. */
export function decodeLiveServerMessage(data: unknown): LiveServerMessage | null {
  const text =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? textDecoder.decode(data)
        : ArrayBuffer.isView(data)
          ? textDecoder.decode(data)
          : null;
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as LiveServerMessage) : null;
  } catch {
    return null;
  }
}
