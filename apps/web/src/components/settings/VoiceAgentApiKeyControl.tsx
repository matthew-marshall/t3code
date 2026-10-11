import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * Saves the Gemini key on the environment. The server keeps it in its secret
 * store and only reports whether one is saved, so the field never shows it.
 */
export function VoiceAgentApiKeyControl({
  saved,
  onSave,
}: {
  readonly saved: boolean;
  readonly onSave: (apiKey: string) => void;
}) {
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
