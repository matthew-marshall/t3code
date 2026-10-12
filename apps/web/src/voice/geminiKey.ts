const STORAGE_KEY = "t3code:voice-agent-gemini-key";

const listeners = new Set<() => void>();

/**
 * The voice agent's Gemini key, kept on this device only. The desktop app
 * encrypts it with the OS keychain; a browser keeps it in its own storage
 * entry, out of client settings. It is only ever sent to Google.
 */
export async function readGeminiKey(): Promise<string | null> {
  const bridge = window.desktopBridge;
  if (bridge?.getVoiceAgentKey) return bridge.getVoiceAgentKey();
  return localStorage.getItem(STORAGE_KEY);
}

/** Saves the key, or removes it when `key` is empty. */
export async function saveGeminiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  const bridge = window.desktopBridge;
  if (bridge?.setVoiceAgentKey) {
    await bridge.setVoiceAgentKey(trimmed);
  } else if (trimmed.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, trimmed);
  }
  for (const listener of listeners) listener();
}

export function subscribeGeminiKey(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
