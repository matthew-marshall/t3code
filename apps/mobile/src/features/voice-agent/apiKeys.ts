import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";

// Live replaces its connection about every ten minutes, often with the phone
// locked in a pocket or a car mount; the default when-unlocked item could not
// be read then.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** An API key in this phone's Keychain. It never leaves the device except to its provider. */
function keychainKey(storageKey: string) {
  let cached: string | null | undefined;
  const listeners = new Set<() => void>();

  const read = async (): Promise<string | null> => {
    if (cached === undefined) {
      cached = await SecureStore.getItemAsync(storageKey, OPTIONS);
    }
    return cached;
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return {
    read,
    /** Saves the key, or removes it when `key` is empty. */
    save: async (key: string): Promise<void> => {
      const trimmed = key.trim();
      if (trimmed.length === 0) {
        await SecureStore.deleteItemAsync(storageKey, OPTIONS);
      } else {
        await SecureStore.setItemAsync(storageKey, trimmed, OPTIONS);
      }
      cached = trimmed.length === 0 ? null : trimmed;
      for (const listener of listeners) listener();
    },
    subscribe,
  };
}

export type KeychainKey = ReturnType<typeof keychainKey>;

/** Whether `key` is saved; null while the Keychain is read. */
export function useKeySaved(key: KeychainKey): boolean | null {
  const [saved, setSaved] = useState<boolean | null>(null);
  useEffect(() => {
    const refresh = () =>
      void key.read().then(
        (value) => setSaved(value !== null),
        () => setSaved(false),
      );
    refresh();
    return key.subscribe(refresh);
  }, [key]);
  return saved;
}

/** The voice agent's Gemini key, which dictation also uses. */
export const geminiKey = keychainKey("t3code.voice-agent.gemini-api-key");
/** The voice agent's OpenAI key, for OpenAI Realtime. */
export const openAIKey = keychainKey("t3code.voice-agent.openai-api-key");
