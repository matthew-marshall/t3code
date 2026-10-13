import { useSyncExternalStore } from "react";

let shown = false;
const listeners = new Set<() => void>();

/** Set by the Drive tab while it is on screen; the floating voice panel hides meanwhile. */
export function setDriveScreenShown(next: boolean): void {
  if (next === shown) return;
  shown = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useDriveScreenShown(): boolean {
  return useSyncExternalStore(subscribe, () => shown);
}
