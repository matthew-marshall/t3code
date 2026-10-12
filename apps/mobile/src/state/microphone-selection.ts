import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import {
  type MicrophoneInput,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../lib/microphonePriority";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";

/**
 * The connected input to record from by the user's microphone priority, or
 * null to leave the route to iOS. Remembers newly seen wired and Bluetooth
 * microphones so they can be ranked in Settings. Reads preferences when
 * called, so callers do not re-render on preference changes.
 */
export function selectPreferredMicrophone<Input extends MicrophoneInput>(
  registry: AtomRegistry.AtomRegistry,
  inputs: ReadonlyArray<Input>,
): Input | null {
  const preferences = registry.get(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences)) return null;
  const known = microphoneOrder(preferences.value.microphones);
  const order = rememberMicrophones(known, inputs);
  if (order !== known) {
    registry.set(updateMobilePreferencesAtom, {
      transform: (current) => ({
        microphones: rememberMicrophones(microphoneOrder(current.microphones), inputs),
      }),
    });
  }
  return preferredMicrophoneInput(inputs, order);
}
