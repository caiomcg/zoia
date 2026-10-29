/**
 * Plays soundboard sounds on this machine (ADR 0040), through a gain of their
 * own: the effects' volume, apart from voices and from the cues. Deafen
 * silences them with everything else Zoia plays, from main.
 *
 * One sound per person: a new one from someone cuts the one they were
 * playing. Every sound stops at MAX_SOUND_SECONDS, fading out.
 */

import { useSyncExternalStore } from 'react';
import { MAX_SOUND_SECONDS, type Sound } from '../../shared/soundboard';
import { soundboardSettings } from './library';
import { effectsGain } from './model';

/** Long enough not to click when a sound is cut, short enough not to be heard as a fade. */
const FADE_S = 0.15;

/** Decoded sounds kept for the next play, most recent last. */
const MAX_DECODED = 30;

let context: AudioContext | null = null;
let master: GainNode | null = null;

function output(): { context: AudioContext; master: GainNode } {
  if (!context || !master) {
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = effectsGain(soundboardSettings.get());
    master.connect(context.destination);
    soundboardSettings.subscribe(() => {
      if (master) master.gain.value = effectsGain(soundboardSettings.get());
    });
  }
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return { context, master };
}

const decoded = new Map<string, Promise<AudioBuffer | null>>();

function bufferFor(context: AudioContext, url: string): Promise<AudioBuffer | null> {
  let buffer = decoded.get(url);
  if (buffer) {
    // Played again: last to be forgotten.
    decoded.delete(url);
  } else {
    buffer = window.zoia.soundboard
      .sound(url)
      .then((bytes) => (bytes ? context.decodeAudioData(bytes.slice().buffer) : null))
      .catch(() => null);
    // A sound that could not be had is tried afresh next time.
    void buffer.then((b) => b ?? decoded.delete(url));
  }
  decoded.set(url, buffer);
  while (decoded.size > MAX_DECODED) {
    const oldest = decoded.keys().next().value;
    if (oldest === undefined) break;
    decoded.delete(oldest);
  }
  return buffer;
}

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Shown in the people list, for a sound someone else played. */
  shown: string | null;
}

const playing = new Map<string, Playing>();
// Each play by a person counts up, so one still loading when the next
// arrives is dropped rather than played over it.
const generation = new Map<string, number>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** Stops what `key` is playing, if anything. */
export function stopSound(key: string) {
  generation.set(key, (generation.get(key) ?? 0) + 1);
  const current = playing.get(key);
  if (!current) return;
  playing.delete(key);
  try {
    current.source.stop();
  } catch {
    // Already ended.
  }
  current.source.disconnect();
  current.gain.disconnect();
  if (current.shown) changed();
}

export function stopAllSounds() {
  for (const key of [...playing.keys()]) stopSound(key);
}

/**
 * Plays `sound` as `key`'s: an identity, or "preview" for your own preview.
 * With `show`, the people list shows it beside them while it plays. False if
 * the sound could not be loaded.
 */
export async function playSound(key: string, sound: Sound, show: boolean): Promise<boolean> {
  stopSound(key);
  const mine = generation.get(key) ?? 0;
  const { context, master } = output();
  const buffer = await bufferFor(context, sound.url);
  if (!buffer) return false;
  if (generation.get(key) !== mine) return true;

  const source = context.createBufferSource();
  source.buffer = buffer;
  const gain = context.createGain();
  source.connect(gain).connect(master);
  const start = context.currentTime;
  if (buffer.duration > MAX_SOUND_SECONDS) {
    gain.gain.setValueAtTime(1, start + MAX_SOUND_SECONDS - FADE_S);
    gain.gain.linearRampToValueAtTime(0, start + MAX_SOUND_SECONDS);
  }
  source.start(start, 0, Math.min(buffer.duration, MAX_SOUND_SECONDS));
  const entry: Playing = { source, gain, shown: show ? sound.name : null };
  playing.set(key, entry);
  source.onended = () => {
    if (playing.get(key) !== entry) return;
    playing.delete(key);
    source.disconnect();
    gain.disconnect();
    if (entry.shown) changed();
  };
  if (entry.shown) changed();
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The name of the sound `identity` is playing for you right now, or null. */
export function usePlayingSound(identity: string): string | null {
  return useSyncExternalStore(subscribe, () => playing.get(identity)?.shown ?? null);
}
