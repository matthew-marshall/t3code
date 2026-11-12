import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { mobilePreferencesAtom } from "../../state/preferences";
import { isVoiceAgentAudioAvailable } from "./nativeVoiceAudio";
import { subscribeVoiceAgent, toggleVoiceAgent, voiceAgentController } from "./voiceAgentSession";

const readActive = () => {
  const { phase } = voiceAgentController.getState();
  return phase === "live" || phase === "connecting";
};

/** Voice shows only on devices with its audio module, once the beta is turned on. */
export function isVoiceAgentVisible(preferences: Atom.Type<typeof mobilePreferencesAtom>): boolean {
  return (
    isVoiceAgentAudioAvailable &&
    AsyncResult.isSuccess(preferences) &&
    preferences.value.voiceAgentEnabled === true
  );
}

/** The header control that starts and ends voice; hidden until the beta is turned on. */
export function useVoiceAgentToggle() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  // Only on/off: the header should not re-render with every transcript fragment.
  const active = useSyncExternalStore(subscribeVoiceAgent, readActive);
  return { visible: isVoiceAgentVisible(preferences), active, toggle: toggleVoiceAgent } as const;
}
