import { createGeminiVoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import { AsyncResult, Atom } from "effect/reactivity";
import { File } from "expo-file-system";

import { mobilePreferencesAtom } from "../../state/preferences";
import { geminiKey } from "../voice-agent/apiKeys";

/** Dictation through Gemini, which removes filler words; it uses the voice agent's key. */
export const geminiVoiceTranscriber = createGeminiVoiceTranscriber({
  readApiKey: geminiKey.read,
  // RecordingPresets.HIGH_QUALITY records AAC in an .m4a container.
  readRecording: async (uri) => ({ data: await new File(uri).base64(), mimeType: "audio/m4a" }),
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
});

/** Whether dictation goes through Gemini; a boolean, so readers re-render only when it flips. */
export const geminiDictationEnabledAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  return (
    AsyncResult.isSuccess(preferences) && preferences.value.dictationRemovesFillerWords === true
  );
}).pipe(Atom.withLabel("mobile:gemini-dictation-enabled"));
