import type { VoiceAgentPace } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  decodeLiveServerMessage,
  type LiveServerMessage,
  liveActivityEndMessage,
  liveActivityStartMessage,
  liveAudioMessage,
  liveAudioStreamEndMessage,
  liveSetupMessage,
  liveSocketUrl,
  liveTextMessage,
  liveToolResponseMessage,
} from "./liveProtocol.ts";
import type { VoiceAgentProvider, VoiceProviderEvent } from "./provider.ts";

/**
 * Gemini Live endpoints. The client keeps the API key and trades it for a
 * single-use token per connection, so the key never goes into a socket URL
 * and a leaked token opens one session at most.
 */
export const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";

export const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

export const VOICE_AGENT_MODEL = "gemini-3.8-live";

const TOKEN_LIFETIME_MINUTES = 30;
/** The token has to open its connection this soon after it is issued. */
const TOKEN_START_WINDOW_MINUTES = 1;

export const MISSING_GEMINI_KEY_MESSAGE = "Add a Gemini API key in Settings → Voice agent.";

/** Exchanges the API key for a token that opens one Live connection. */
export async function requestLiveToken(
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const key = apiKey?.trim() ?? "";
  if (key.length === 0) {
    throw new Error(MISSING_GEMINI_KEY_MESSAGE);
  }
  const now = DateTime.nowUnsafe();
  let response: Response;
  try {
    response = await fetchImpl(`${GEMINI_API_ORIGIN}/v1beta/auth_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        uses: 1,
        expireTime: DateTime.formatIso(DateTime.add(now, { minutes: TOKEN_LIFETIME_MINUTES })),
        newSessionExpireTime: DateTime.formatIso(
          DateTime.add(now, { minutes: TOKEN_START_WINDOW_MINUTES }),
        ),
      }),
    });
  } catch {
    throw new Error("Could not reach Gemini. Check your connection.");
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new Error("Gemini rejected the API key. Check it in Settings → Voice agent.");
  }
  if (!response.ok) {
    throw new Error(`Could not start a voice session with Gemini (${response.status}).`);
  }
  const body: unknown = await response.json().catch(() => null);
  const name = typeof body === "object" && body !== null && "name" in body ? body.name : undefined;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Gemini returned no session token.");
  }
  return name;
}

/** Gemini Live has no speaking-rate setting, so pace is asked for in the instructions. */
const PACE_INSTRUCTIONS: Record<VoiceAgentPace, string | null> = {
  slow: "Speak slowly and calmly.",
  normal: null,
  fast: "Speak quickly, at a brisk pace.",
};

/**
 * Gemini Live. Connections last about ten minutes and the server says when one is ending; a
 * resumption handle carries the conversation to the next. Google Search runs inside Live.
 */
export function createGeminiVoiceProvider(deps: {
  readonly readApiKey: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}): VoiceAgentProvider {
  return {
    id: "gemini",
    model: VOICE_AGENT_MODEL,
    inputSampleRate: 16_000,
    instructions:
      "For anything outside T3 Code, such as news, documentation or facts, use Google Search rather than answering from memory. Mention a source by name when it helps.",
    async connect(send) {
      const token = await requestLiveToken(await deps.readApiKey(), deps.fetchImpl);
      return {
        url: liveSocketUrl(GEMINI_LIVE_URL, token),
        protocols: [],
        setup: (setup) => {
          const pace = PACE_INSTRUCTIONS[setup.pace];
          send(
            liveSetupMessage({
              model: VOICE_AGENT_MODEL,
              systemInstruction:
                pace === null ? setup.instructions : `${setup.instructions}\n\n${pace}`,
              tools: setup.tools,
              mode: setup.mode,
              voice: setup.voice,
              resumptionHandle: setup.resumptionHandle,
            }),
          );
        },
        receive: (data) => {
          const message = decodeLiveServerMessage(data);
          return message === null ? [] : geminiEvents(message);
        },
        sendAudio: (base64Pcm) => send(liveAudioMessage(base64Pcm)),
        // Otherwise Gemini's own detection waits through the pause as more silence.
        pauseAudio: () => send(liveAudioStreamEndMessage),
        sendText: (text) => send(liveTextMessage(text)),
        sendToolResults: (results) =>
          send(
            liveToolResponseMessage(
              results.map((result) => ({
                id: result.id,
                name: result.name,
                response: "output" in result ? { output: result.output } : { error: result.error },
              })),
            ),
          ),
        beginTalking: () => send(liveActivityStartMessage),
        endTalking: () => send(liveActivityEndMessage),
      };
    },
  };
}

function geminiEvents(message: LiveServerMessage): ReadonlyArray<VoiceProviderEvent> {
  const events: Array<VoiceProviderEvent> = [];
  if (message.setupComplete !== undefined) events.push({ type: "ready" });
  const resumption = message.sessionResumptionUpdate;
  if (resumption?.resumable && resumption.newHandle) {
    events.push({ type: "resumable", handle: resumption.newHandle });
  }
  const content = message.serverContent;
  if (content?.interrupted) events.push({ type: "interrupted" });
  for (const part of content?.modelTurn?.parts ?? []) {
    if (part.inlineData?.data) events.push({ type: "audio", data: part.inlineData.data });
  }
  if (content?.inputTranscription?.text) {
    events.push({ type: "heard", text: content.inputTranscription.text });
  }
  if (content?.outputTranscription?.text) {
    events.push({ type: "said", text: content.outputTranscription.text });
  }
  if (content?.turnComplete) events.push({ type: "turn-complete" });
  const cancelled = message.toolCallCancellation?.ids ?? [];
  if (cancelled.length > 0) events.push({ type: "tool-cancelled", ids: cancelled });
  const calls = message.toolCall?.functionCalls ?? [];
  if (calls.length > 0) {
    events.push({
      type: "tool-calls",
      calls: calls.map((call) => ({ id: call.id, name: call.name, args: call.args ?? {} })),
    });
  }
  if (message.goAway !== undefined) events.push({ type: "go-away" });
  return events;
}
