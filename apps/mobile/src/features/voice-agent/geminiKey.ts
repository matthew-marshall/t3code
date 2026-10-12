import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";

const STORAGE_KEY = "t3code.voice-agent.gemini-api-key";
// Live replaces its connection about every ten minutes, often with the phone
// locked in a pocket or a car mount; the default when-unlocked item could not
// be read then.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

let cached: string | null | undefined;
const listeners = new Set<() => void>();

/** The Gemini API key saved on this phone, or null. Never leaves the device except to Google. */
export async function readGeminiKey(): Promise<string | null> {
  if (cached === undefined) {
    cached = await SecureStore.getItemAsync(STORAGE_KEY, OPTIONS);
  }
  return cached;
}

/** Saves the key, or removes it when `key` is empty. */
export async function saveGeminiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    await SecureStore.deleteItemAsync(STORAGE_KEY, OPTIONS);
  } else {
    await SecureStore.setItemAsync(STORAGE_KEY, trimmed, OPTIONS);
  }
  cached = trimmed.length === 0 ? null : trimmed;
  for (const listener of listeners) listener();
}

export function subscribeGeminiKey(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a Gemini key is saved on this phone; null while the Keychain is read. */
export function useGeminiKeySaved(): boolean | null {
  const [saved, setSaved] = useState<boolean | null>(null);
  useEffect(() => {
    const refresh = () =>
      void readGeminiKey().then(
        (key) => setSaved(key !== null),
        () => setSaved(false),
      );
    refresh();
    return subscribeGeminiKey(refresh);
  }, []);
  return saved;
}
