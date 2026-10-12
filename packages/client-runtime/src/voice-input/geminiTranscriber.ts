import { GEMINI_API_ORIGIN, MISSING_GEMINI_KEY_MESSAGE } from "../voice-agent/gemini.ts";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from "./transcription.ts";

export const GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

export interface GeminiVoiceTranscriberOptions {
  /** The Gemini API key the voice agent uses; read when dictation starts. */
  readonly readApiKey: () => Promise<string | null>;
  /** The recording's bytes, base64 encoded, and its Gemini audio type, such as `audio/m4a`. */
  readonly readRecording: (
    uri: string,
  ) => Promise<{ readonly data: string; readonly mimeType: string }>;
  /** Only used to space the transcript into the draft; Gemini detects the spoken language itself. */
  readonly locale: string;
  readonly fetchImpl?: typeof fetch;
}

const failed = (displayMessage: string, cause?: unknown) =>
  new VoiceTranscriptionError("transcription-failed", displayMessage, { cause, displayMessage });

function errorDetail(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const error = body.error;
  if (typeof error !== "object" || error === null || !("message" in error)) return null;
  return typeof error.message === "string" ? error.message : null;
}

/** The transcript text in an interaction: every text block the model output. */
export function geminiTranscriptText(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("steps" in body)) return null;
  if (!Array.isArray(body.steps)) return null;
  const texts: string[] = [];
  for (const step of body.steps) {
    if (typeof step !== "object" || step === null || step.type !== "model_output") continue;
    for (const content of Array.isArray(step.content) ? step.content : []) {
      if (content?.type === "text" && typeof content.text === "string") texts.push(content.text);
    }
  }
  return texts.length === 0 ? null : texts.join(" ").trim();
}

/**
 * Dictation through Gemini 3.5 Transcribe in smart mode, which drops filler
 * words, stutters and false starts. The recording goes straight from the
 * device to Google with the user's own key.
 */
export function createGeminiVoiceTranscriber(
  options: GeminiVoiceTranscriberOptions,
): VoiceTranscriber {
  const fetchImpl = options.fetchImpl ?? fetch;

  const transcribe = async (apiKey: string, uri: string, signal: AbortSignal) => {
    throwIfVoiceTranscriptionAborted(signal);
    const recording = await options.readRecording(uri);
    throwIfVoiceTranscriptionAborted(signal);
    let response: Response;
    try {
      response = await fetchImpl(`${GEMINI_API_ORIGIN}/v1beta/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          model: GEMINI_TRANSCRIBE_MODEL,
          input: [{ type: "audio", data: recording.data, mime_type: recording.mimeType }],
          generation_config: { transcription_config: { mode: "smart" } },
        }),
        signal,
      });
    } catch (error) {
      throwIfVoiceTranscriptionAborted(signal);
      throw failed("Could not reach Gemini. Check your connection and try again.", error);
    }
    const body: unknown = await response.json().catch(() => null);
    throwIfVoiceTranscriptionAborted(signal);
    if (!response.ok) {
      const detail = errorDetail(body);
      // Google answers a bad key with 400 as well as 401/403.
      if (response.status === 401 || response.status === 403 || /api key/i.test(detail ?? "")) {
        throw failed("Gemini rejected the API key. Check it in Settings → Voice Agent.");
      }
      if (response.status === 429) {
        throw failed("Gemini is rate limiting this key. Try again in a moment.");
      }
      throw failed(
        detail === null
          ? `Gemini could not transcribe this recording (${response.status}).`
          : `Gemini could not transcribe this recording: ${detail}`,
      );
    }
    const text = geminiTranscriptText(body);
    if (text === null) {
      throw failed("Gemini returned no transcript.");
    }
    return text;
  };

  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      const apiKey = (await options.readApiKey())?.trim() ?? "";
      throwIfVoiceTranscriptionAborted(signal);
      if (apiKey.length === 0) {
        throw new VoiceTranscriptionError("unavailable", MISSING_GEMINI_KEY_MESSAGE, {
          displayMessage: MISSING_GEMINI_KEY_MESSAGE,
        });
      }
      return {
        locale: options.locale,
        transcribe: (uri, { signal: transcribeSignal }) =>
          transcribe(apiKey, uri, transcribeSignal),
      };
    },
  };
}
