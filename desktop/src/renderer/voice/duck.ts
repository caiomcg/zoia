/**
 * Whether you are hearing yourself (Settings › Voice), which is deafen: from
 * turning it on until it is off, voices, broadcasts, cues and the soundboard
 * are quiet here, so what you hear is you alone, and in a call you are
 * deafened for everyone (useVoice's setHearingSelf).
 */

import { useSyncExternalStore } from 'react';

let ducked = false;
const listeners = new Set<() => void>();

export function isDucked(): boolean {
  return ducked;
}

export function setDucked(next: boolean): void {
  if (next === ducked) return;
  ducked = next;
  for (const listener of listeners) listener();
}

export function subscribeDucked(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDucked(): boolean {
  return useSyncExternalStore(subscribeDucked, isDucked);
}
