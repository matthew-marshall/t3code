import { useRef, useState } from "react";

import { voiceAgentController } from "./voiceAgentSession";

/** A press shorter than this locks talking on; a longer one is a walkie-talkie hold. */
const LOCK_MS = 300;

/**
 * Push-to-talk on one button: hold it while speaking, or tap it to keep talking hands-off and
 * tap again to send. `locked` is whether a tap is holding talking on.
 */
export function useTalkGesture(talking: boolean) {
  const [lockedByTap, setLockedByTap] = useState(false);
  const pressedAt = useRef(0);
  const unlocking = useRef(false);
  // Talking can also stop elsewhere, such as the session reconnecting.
  const locked = lockedByTap && talking;

  return {
    locked,
    onPressIn: () => {
      unlocking.current = locked;
      if (locked) return;
      pressedAt.current = performance.now();
      voiceAgentController.beginTalking();
    },
    onPressOut: () => {
      if (unlocking.current) {
        unlocking.current = false;
        setLockedByTap(false);
        voiceAgentController.endTalking();
        return;
      }
      if (performance.now() - pressedAt.current < LOCK_MS) {
        setLockedByTap(true);
      } else {
        voiceAgentController.endTalking();
      }
    },
  };
}
