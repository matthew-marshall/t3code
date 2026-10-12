import type { VoiceAgentProviderId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  readVoiceAgentKey,
  saveVoiceAgentKey,
  subscribeVoiceAgentKeys,
} from "~/voice/voiceAgentKeys";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

const KEY_LABELS: Record<VoiceAgentProviderId, string> = {
  gemini: "Gemini API key",
  openai: "OpenAI API key",
};

/** Whether a key is saved on this device; the field never shows it. */
function useKeySaved(provider: VoiceAgentProviderId): boolean {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let current = true;
    const refresh = () =>
      void readVoiceAgentKey(provider).then(
        (key) => current && setSaved(key !== null && key.length > 0),
        () => current && setSaved(false),
      );
    refresh();
    const unsubscribe = subscribeVoiceAgentKeys(refresh);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [provider]);
  return saved;
}

const onSave = (provider: VoiceAgentProviderId, apiKey: string) =>
  void saveVoiceAgentKey(provider, apiKey).catch((error: unknown) =>
    toastManager.add({
      type: "error",
      title: `Could not save the ${KEY_LABELS[provider]}`,
      description: error instanceof Error ? error.message : undefined,
    }),
  );

/** Saves a provider's key on this device. It is only ever sent to that provider. */
export function VoiceAgentApiKeyControl({ provider }: { readonly provider: VoiceAgentProviderId }) {
  const saved = useKeySaved(provider);
  const [draft, setDraft] = useState("");
  const apiKey = draft.trim();
  return (
    <form
      className="flex w-full items-center gap-2 sm:w-auto"
      onSubmit={(event) => {
        event.preventDefault();
        if (apiKey.length === 0) return;
        onSave(provider, apiKey);
        setDraft("");
      }}
    >
      <Input
        type="password"
        autoComplete="off"
        size="sm"
        className="sm:w-56"
        aria-label={KEY_LABELS[provider]}
        placeholder={saved ? "Saved, enter a new key to replace" : "Not set"}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {saved && apiKey.length === 0 ? (
        <Button size="xs" variant="outline" onClick={() => onSave(provider, "")}>
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
