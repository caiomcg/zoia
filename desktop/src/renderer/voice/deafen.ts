/**
 * Whether you are deafened (ADR 0039): voices, the soundboard, entrance sounds
 * and cues are quiet here. Broadcasts are not: deafening leaves the voice
 * chat, never the lives you are watching, which have a mute of their own.
 *
 * Set by useVoice; read by whatever plays one of those sounds.
 */

import { useSyncExternalStore } from 'react';

let deafened = false;
const listeners = new Set<() => void>();

export function isDeafenedHere(): boolean {
  return deafened;
}

export function setDeafenedHere(next: boolean): void {
  if (next === deafened) return;
  deafened = next;
  for (const listener of listeners) listener();
}

export function subscribeDeafened(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDeafenedHere(): boolean {
  return useSyncExternalStore(subscribeDeafened, isDeafenedHere);
}
