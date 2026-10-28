/**
 * Who is speaking, for the green ring, worked out here rather than taken from
 * LiveKit's active speakers: those are smoothed on the server and arrive a
 * few times a second, late for a word and deaf to a short one. Here it is the
 * sound itself, every few tens of milliseconds: what you send (pipeline.ts)
 * and what you hear of everyone else (VoiceAudio).
 */

import { useSyncExternalStore } from 'react';
import { levelToDb } from './settings';

/**
 * Louder than this, at the peak, is sound being sent: the ring shows whatever
 * goes over the network, noise included, not only what sounds like speech.
 * Opus's DTX sends next to nothing only below about this, and RNNoise's
 * silence sits well under it, so a quiet room stays dark.
 */
export const SPEAKING_DB = -60;

/** How long the ring stays after the voice stops, so it does not flicker between words. */
export const SPEAKING_HOLD_MS = 250;

/** How often a level is read. */
export const SPEAKING_TICK_MS = 50;

let speaking: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function setSpeaking(identity: string, on: boolean) {
  if (speaking.has(identity) === on) return;
  const next = new Set(speaking);
  if (on) next.add(identity);
  else next.delete(identity);
  speaking = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSpeaking(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => speaking);
}

/**
 * Follows one voice: `read` gives its peak, 0 to 1, and the result is held
 * a little past the last loud moment. Returns the stop, which clears it.
 */
export function watchSpeaking(identity: string, read: () => number): () => void {
  let until = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    if (levelToDb(read()) >= SPEAKING_DB) until = now + SPEAKING_HOLD_MS;
    setSpeaking(identity, now < until);
  }, SPEAKING_TICK_MS);
  return () => {
    clearInterval(timer);
    setSpeaking(identity, false);
  };
}
