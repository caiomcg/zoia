/**
 * The sound settings, remembered per machine. One store shared by the
 * settings pane and the cue player, so a change is heard on the next cue
 * without reopening anything.
 */

import { useSyncExternalStore } from 'react';
import { parseSoundSettings, type SoundSettings } from './cues';

const STORAGE_KEY = 'zoia.sounds';

function read(): SoundSettings {
  try {
    return parseSoundSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseSoundSettings(null);
  }
}

let current = read();
const listeners = new Set<() => void>();

export function getSoundSettings(): SoundSettings {
  return current;
}

export function setSoundSettings(next: SoundSettings): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Remembering is a convenience; the change still applies this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSoundSettings(): SoundSettings {
  return useSyncExternalStore(subscribe, getSoundSettings);
}
