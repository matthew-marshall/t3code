import type { VoiceAgentPace } from "@t3tools/contracts";

import {
  decodeJsonFrame,
  type VoiceAgentProvider,
  type VoiceProviderEvent,
  type VoiceToolCall,
} from "./provider.ts";

/**
 * OpenAI Realtime, as a comparison to Gemini Live. The device trades its API key for a client
 * secret per connection, which a WebSocket passes as a subprotocol since browsers cannot set
 * headers. See https://developers.openai.com/api/docs/guides/realtime-websocket.
 */
export const OPENAI_API_ORIGIN = "https://api.openai.com";
export const OPENAI_REALTIME_MODEL = "gpt-realtime-2.1";
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
/** Realtime takes 16-bit PCM only at 24 kHz, in and out. */
const SAMPLE_RATE = 24_000;
/** The secret only has to open its connection; the session then lasts on its own. */
const SECRET_LIFETIME_SECONDS = 60;

export const MISSING_OPENAI_KEY_MESSAGE = "Add an OpenAI API key in Settings → Voice agent.";

const SPEED: Record<VoiceAgentPace, number> = { slow: 0.85, normal: 1, fast: 1.2 };

/** Exchanges the API key for a client secret that opens one Realtime connection. */
export async function requestRealtimeSecret(
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const key = apiKey?.trim() ?? "";
  if (key.length === 0) throw new Error(MISSING_OPENAI_KEY_MESSAGE);
  let response: Response;
  try {
    response = await fetchImpl(`${OPENAI_API_ORIGIN}/v1/realtime/client_secrets`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: SECRET_LIFETIME_SECONDS },
        session: { type: "realtime", model: OPENAI_REALTIME_MODEL },
      }),
    });
  } catch {
    throw new Error("Could not reach OpenAI. Check your connection.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("OpenAI rejected the API key. Check it in Settings → Voice agent.");
  }
  if (!response.ok) {
    throw new Error(`Could not start a voice session with OpenAI (${response.status}).`);
  }
  const body: unknown = await response.json().catch(() => null);
  const value =
    typeof body === "object" && body !== null && "value" in body ? body.value : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("OpenAI returned no session secret.");
  }
  return value;
}

const stringField = (event: Record<string, unknown>, key: string): string =>
  typeof event[key] === "string" ? event[key] : "";

function functionCall(item: unknown): VoiceToolCall | null {
  if (typeof item !== "object" || item === null) return null;
  const call = item as Record<string, unknown>;
  if (call.type !== "function_call") return null;
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stringField(call, "arguments") || "{}");
    if (typeof parsed === "object" && parsed !== null) args = parsed as Record<string, unknown>;
  } catch {
    // Malformed arguments reach the tool as none; it reports what is missing.
  }
  return { id: stringField(call, "call_id"), name: stringField(call, "name"), args };
}

export function createOpenAIVoiceProvider(deps: {
  readonly readApiKey: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}): VoiceAgentProvider {
  return {
    id: "openai",
    model: OPENAI_REALTIME_MODEL,
    inputSampleRate: SAMPLE_RATE,
    instructions: null,
    async connect(send) {
      const secret = await requestRealtimeSecret(await deps.readApiKey(), deps.fetchImpl);
      let ready = false;
      // Realtime runs one response at a time and rejects `response.create` during another, so
      // one asked for then (after a fast tool or an update) waits for the current one to end.
      let responding = false;
      let responseWanted = false;
      const requestResponse = () => {
        if (responding) {
          responseWanted = true;
          return;
        }
        responding = true;
        send({ type: "response.create" });
      };

      return {
        url: `${OPENAI_REALTIME_URL}?model=${OPENAI_REALTIME_MODEL}`,
        protocols: ["realtime", `openai-insecure-api-key.${secret}`],
        setup: (setup) => {
          send({
            type: "session.update",
            session: {
              type: "realtime",
              instructions: setup.instructions,
              output_modalities: ["audio"],
              audio: {
                input: {
                  format: { type: "audio/pcm", rate: SAMPLE_RATE },
                  transcription: {
                    model: TRANSCRIPTION_MODEL,
                    language: setup.language.split("-")[0],
                    // Its prompt biases recognition towards the words in it.
                    ...(setup.vocabulary.length > 0
                      ? { prompt: `Names that may come up: ${setup.vocabulary.join(", ")}.` }
                      : {}),
                  },
                  // Push-to-talk marks turns itself.
                  turn_detection:
                    setup.mode === "push-to-talk"
                      ? null
                      : { type: "semantic_vad", create_response: true, interrupt_response: true },
                },
                output: {
                  format: { type: "audio/pcm", rate: SAMPLE_RATE },
                  speed: SPEED[setup.pace],
                  ...(setup.voice === null ? {} : { voice: setup.voice }),
                },
              },
              tools: setup.tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.parametersJsonSchema,
              })),
              tool_choice: "auto",
            },
          });
        },
        receive: (data) => {
          const event = decodeJsonFrame(data);
          if (event === null) return [];
          return openAIEvents(event, {
            ready: () => {
              if (ready) return false;
              ready = true;
              return true;
            },
            responseStarted: () => {
              responding = true;
            },
            responseEnded: () => {
              responding = false;
              if (responseWanted) {
                responseWanted = false;
                requestResponse();
              }
            },
          });
        },
        sendAudio: (base64Pcm) => send({ type: "input_audio_buffer.append", audio: base64Pcm }),
        // Its turn detection hears the silence sent before the pause; nothing more is needed.
        pauseAudio: () => {},
        sendText: (text) => {
          send({
            type: "conversation.item.create",
            item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
          });
          requestResponse();
        },
        sendToolResults: (results) => {
          for (const result of results) {
            send({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: result.id,
                output:
                  "output" in result ? result.output : JSON.stringify({ error: result.error }),
              },
            });
          }
          requestResponse();
        },
        beginTalking: () => {
          if (responding) send({ type: "response.cancel" });
          send({ type: "input_audio_buffer.clear" });
        },
        endTalking: () => {
          send({ type: "input_audio_buffer.commit" });
          requestResponse();
        },
      };
    },
  };
}

function openAIEvents(
  event: Record<string, unknown>,
  connection: {
    readonly ready: () => boolean;
    readonly responseStarted: () => void;
    readonly responseEnded: () => void;
  },
): ReadonlyArray<VoiceProviderEvent> {
  switch (event.type) {
    // The first update confirms the session; later ones are only echoes.
    case "session.updated":
      return connection.ready() ? [{ type: "ready" }] : [];
    case "input_audio_buffer.speech_started":
      return [{ type: "interrupted" }];
    case "conversation.item.input_audio_transcription.completed": {
      const text = stringField(event, "transcript").trim();
      return text.length === 0 ? [] : [{ type: "heard", text }];
    }
    case "response.created":
      connection.responseStarted();
      return [];
    case "response.output_audio.delta": {
      const data = stringField(event, "delta");
      return data.length === 0 ? [] : [{ type: "audio", data }];
    }
    case "response.output_audio_transcript.delta": {
      const text = stringField(event, "delta");
      return text.length === 0 ? [] : [{ type: "said", text }];
    }
    case "response.output_item.done": {
      const call = functionCall(event.item);
      return call === null ? [] : [{ type: "tool-calls", calls: [call] }];
    }
    case "response.done":
      connection.responseEnded();
      return [{ type: "turn-complete" }];
    case "error": {
      const error = event.error;
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : "OpenAI rejected a request.";
      return [{ type: "error", message }];
    }
    default:
      return [];
  }
}
