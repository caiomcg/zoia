/**
 * The soundboard's settings, favourites and recent sounds, remembered per
 * machine (ADR 0040). One store each, shared by the panel, the settings, the
 * people list and the player, so a change shows everywhere at once.
 */

import { useSyncExternalStore } from 'react';
import { parseSoundList, type Sound } from '../../shared/soundboard';
import {
  MAX_FAVORITES,
  MAX_RECENTS,
  parseSoundboardSettings,
  type SoundboardSettings,
} from './model';

interface Store<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

function stored<T>(key: string, parse: (raw: string | null) => T): Store<T> {
  let current = (() => {
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return parse(null);
    }
  })();
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next) {
      current = next;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Remembering is a convenience; the change still applies this session.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const soundboardSettings = stored('zoia.soundboard', parseSoundboardSettings);
export const favorites = stored('zoia.soundboard.favorites', (raw) =>
  parseSoundList(raw, MAX_FAVORITES),
);
export const recents = stored('zoia.soundboard.recents', (raw) => parseSoundList(raw, MAX_RECENTS));

export function useSoundboardSettings(): SoundboardSettings {
  return useSyncExternalStore(soundboardSettings.subscribe, soundboardSettings.get);
}

export function useFavorites(): Sound[] {
  return useSyncExternalStore(favorites.subscribe, favorites.get);
}

export function useRecents(): Sound[] {
  return useSyncExternalStore(recents.subscribe, recents.get);
}

/** Whether you hear `identity`'s sounds. */
export function usePersonMuted(identity: string): boolean {
  return useSyncExternalStore(soundboardSettings.subscribe, () =>
    soundboardSettings.get().mutedPeople.includes(identity),
  );
}
