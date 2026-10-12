import { useEffect, useState } from "react";

import { readGeminiKey, saveGeminiKey, subscribeGeminiKey } from "~/voice/geminiKey";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

/** Whether a key is saved on this device; the field never shows it. */
function useGeminiKeySaved(): boolean {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const refresh = () =>
      void readGeminiKey().then(
        (key) => setSaved(key !== null && key.length > 0),
        () => setSaved(false),
      );
    refresh();
    return subscribeGeminiKey(refresh);
  }, []);
  return saved;
}

const onSave = (apiKey: string) =>
  void saveGeminiKey(apiKey).catch((error: unknown) =>
    toastManager.add({
      type: "error",
      title: "Could not save the Gemini API key",
      description: error instanceof Error ? error.message : undefined,
    }),
  );

/** Saves the Gemini key on this device. It is only ever sent to Google. */
export function VoiceAgentApiKeyControl() {
  const saved = useGeminiKeySaved();
  const [draft, setDraft] = useState("");
  const apiKey = draft.trim();
  return (
    <form
      className="flex w-full items-center gap-2 sm:w-auto"
      onSubmit={(event) => {
        event.preventDefault();
        if (apiKey.length === 0) return;
        onSave(apiKey);
        setDraft("");
      }}
    >
      <Input
        type="password"
        autoComplete="off"
        size="sm"
        className="sm:w-56"
        aria-label="Gemini API key"
        placeholder={saved ? "Saved, enter a new key to replace" : "Not set"}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {saved && apiKey.length === 0 ? (
        <Button size="xs" variant="outline" onClick={() => onSave("")}>
          Remove
        </Button>
      ) : (
        <Button type="submit" size="xs" disabled={apiKey.length === 0}>
          Save
        </Button>
      )}
    </form>
  );
}
