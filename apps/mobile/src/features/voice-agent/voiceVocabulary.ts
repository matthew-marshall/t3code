import { parseVoiceVocabulary, voiceVocabulary } from "@t3tools/client-runtime/voice-agent";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";

/** The user's own terms from Settings → Voice Agent → Vocabulary. */
export function customVoiceVocabulary(): ReadonlyArray<string> {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? parseVoiceVocabulary(preferences.value.voiceVocabulary ?? "")
    : [];
}

const vocabularyWith = (custom: ReadonlyArray<string>) =>
  voiceVocabulary({
    custom,
    projects: appAtomRegistry.get(environmentProjects.projectsAtom),
    threads: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
  });

/**
 * Names voice and Gemini dictation should expect: the user's own terms, project names and words
 * from active thread titles, as of now.
 */
export function currentVoiceVocabulary(): ReadonlyArray<string> {
  return vocabularyWith(customVoiceVocabulary());
}

/** Project names and words from active thread titles alone, as of now. */
export function automaticVoiceVocabulary(): ReadonlyArray<string> {
  return vocabularyWith([]);
}
