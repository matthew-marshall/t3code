import * as DateTime from "effect/DateTime";

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
