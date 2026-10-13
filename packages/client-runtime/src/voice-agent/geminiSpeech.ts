import { GEMINI_API_ORIGIN, MISSING_GEMINI_KEY_MESSAGE } from "./gemini.ts";

/** Gemini text-to-speech for reading messages aloud: 16-bit mono PCM at 24 kHz. */
export const READ_ALOUD_MODEL = "gemini-3.8-flash-lite-tts";
/** A voice unlike the agent's default, so reading is clearly not the agent talking. */
export const READ_ALOUD_VOICE = "Charon";
/** Finds parts of a message by description; small and quick. */
export const READOUT_LOCATOR_MODEL = "gemini-3.5-flash-lite";

const failure = (status: number) =>
  status === 400 || status === 401 || status === 403
    ? "Gemini rejected the API key. Check it in Settings → Voice agent."
    : `Gemini could not do that (${status}).`;

async function generate(
  apiKey: string | null,
  model: string,
  body: object,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const key = apiKey?.trim() ?? "";
  if (key === "") throw new Error(MISSING_GEMINI_KEY_MESSAGE);
  let response: Response;
  try {
    response = await fetchImpl(`${GEMINI_API_ORIGIN}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach Gemini. Check your connection.");
  }
  if (!response.ok) throw new Error(failure(response.status));
  return response.json().catch(() => null);
}

type Part = { readonly text?: string; readonly inlineData?: { readonly data?: string } };

const parts = (body: unknown): ReadonlyArray<Part> => {
  const candidates = (body as { candidates?: ReadonlyArray<{ content?: { parts?: Part[] } }> })
    ?.candidates;
  return candidates?.[0]?.content?.parts ?? [];
};

/**
 * Gemini returns speech as a WAV file: a RIFF header, then the PCM. The header played as audio is
 * a burst of noise, so only the samples of its "data" chunk are kept. Raw PCM passes through.
 */
export function wavToPcm(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return base64;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size =
      bytes[offset + 4]! |
      (bytes[offset + 5]! << 8) |
      (bytes[offset + 6]! << 16) |
      (bytes[offset + 7]! << 24);
    if (tag(offset) === "data") {
      const samples = bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + (size >>> 0)));
      let binary = "";
      for (let index = 0; index < samples.length; index += 0x8000) {
        binary += String.fromCharCode(...samples.subarray(index, index + 0x8000));
      }
      return btoa(binary);
    }
    // Chunks are padded to an even size.
    offset += 8 + (size >>> 0) + ((size >>> 0) % 2);
  }
  return base64;
}

/** The spoken text as base64 PCM. */
export async function synthesizeSpeech(
  apiKey: string | null,
  text: string,
  voice: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = await generate(
    apiKey,
    READ_ALOUD_MODEL,
    {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    },
    fetchImpl,
  );
  const audio = parts(body).find((part) => part.inlineData?.data)?.inlineData?.data;
  if (!audio) throw new Error("Gemini returned no speech.");
  return wavToPcm(audio);
}

export type ReadoutLocation =
  | { readonly found: true; readonly start: number; readonly end: number }
  | { readonly found: false; readonly reason: string };

/**
 * Which sentences match a description such as "the conclusion" or "the data table". The model
 * sees the numbered sentences and answers with a range, or why it found nothing.
 */
export async function locateInReadout(
  apiKey: string | null,
  sentences: ReadonlyArray<string>,
  description: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadoutLocation> {
  const numbered = sentences.map((sentence, index) => `${index + 1}. ${sentence}`).join("\n");
  const body = await generate(
    apiKey,
    READOUT_LOCATOR_MODEL,
    {
      systemInstruction: {
        parts: [
          {
            text: "You find parts of a message for someone listening to it read aloud. Given its numbered sentences and a description of a part, answer with the first and last sentence numbers of that part, inclusive. If no part matches, set found to false and say briefly why.",
          },
        ],
      },
      contents: [{ parts: [{ text: `Sentences:\n${numbered}\n\nFind: ${description}` }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            found: { type: "BOOLEAN" },
            start: { type: "INTEGER" },
            end: { type: "INTEGER" },
            reason: { type: "STRING" },
          },
          required: ["found"],
        },
      },
    },
    fetchImpl,
  );
  const text = parts(body).find((part) => part.text)?.text ?? "";
  let answer: { found?: unknown; start?: unknown; end?: unknown; reason?: unknown };
  try {
    answer = JSON.parse(text);
  } catch {
    return { found: false, reason: "The search gave no usable answer." };
  }
  const start = typeof answer.start === "number" ? answer.start : NaN;
  const end = typeof answer.end === "number" ? answer.end : start;
  if (answer.found !== true || !Number.isInteger(start) || start < 1 || start > sentences.length) {
    return {
      found: false,
      reason: typeof answer.reason === "string" ? answer.reason : "No part of it matches.",
    };
  }
  // Back to 0-based, clamped to the message.
  return {
    found: true,
    start: start - 1,
    end: Math.min(Math.max(end, start), sentences.length) - 1,
  };
}
