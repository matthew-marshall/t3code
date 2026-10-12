import type { VoiceAgentProviderId } from "@t3tools/contracts";

// The Gemini entry keeps its original name so keys saved before OpenAI support still load.
const STORAGE_KEYS: Record<VoiceAgentProviderId, string> = {
  gemini: "t3code:voice-agent-gemini-key",
  openai: "t3code:voice-agent-openai-key",
};

const listeners = new Set<() => void>();

/**
 * A voice provider's API key, kept on this device only. The desktop app
 * encrypts it with the OS keychain; a browser keeps it in its own storage
 * entry, out of client settings. It is only ever sent to that provider.
 */
export async function readVoiceAgentKey(provider: VoiceAgentProviderId): Promise<string | null> {
  const bridge = window.desktopBridge;
  if (bridge?.getVoiceAgentKey) return bridge.getVoiceAgentKey(provider);
  return localStorage.getItem(STORAGE_KEYS[provider]);
}

/** The Gemini key, which the voice agent and dictation share. */
export const readGeminiKey = () => readVoiceAgentKey("gemini");
export const readOpenAIKey = () => readVoiceAgentKey("openai");

/** Saves the key, or removes it when `key` is empty. */
export async function saveVoiceAgentKey(
  provider: VoiceAgentProviderId,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  const bridge = window.desktopBridge;
  if (bridge?.setVoiceAgentKey) {
    await bridge.setVoiceAgentKey(trimmed, provider);
  } else if (trimmed.length === 0) {
    localStorage.removeItem(STORAGE_KEYS[provider]);
  } else {
    localStorage.setItem(STORAGE_KEYS[provider], trimmed);
  }
  for (const listener of listeners) listener();
}

export function subscribeVoiceAgentKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
