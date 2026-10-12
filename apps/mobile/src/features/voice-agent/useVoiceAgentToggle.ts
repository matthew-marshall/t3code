import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import { mobilePreferencesAtom } from "../../state/preferences";
import { isVoiceAgentAudioAvailable } from "./nativeVoiceAudio";
import {
  startVoiceAgent,
  stopVoiceAgent,
  subscribeVoiceAgent,
  voiceAgentController,
} from "./voiceAgentSession";

const readActive = () => {
  const { phase } = voiceAgentController.getState();
  return phase === "live" || phase === "connecting";
};

/** The header control that starts and ends voice; hidden until the beta is turned on. */
export function useVoiceAgentToggle() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  // Only on/off: the header should not re-render with every transcript fragment.
  const active = useSyncExternalStore(subscribeVoiceAgent, readActive);
  const visible =
    isVoiceAgentAudioAvailable &&
    AsyncResult.isSuccess(preferences) &&
    preferences.value.voiceAgentEnabled === true;
  return { visible, active, toggle: active ? stopVoiceAgent : startVoiceAgent } as const;
}
