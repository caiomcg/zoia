/**
 * How loud each person's voice plays for you, by identity, remembered per
 * machine. Only ever yours: everyone hears everyone else at their own levels,
 * since the mix is made by each listener (ADR 0039).
 */

import { useSyncExternalStore } from 'react';

/** 0 is silent, 1 as sent, up to twice that for someone too quiet. */
export const VOLUME_MAX = 2;

const STORAGE_KEY = 'zoia.voice.volumes';

/** Only sensible entries survive: a hand-edited or old value is as never set. */
export function parseVolumes(raw: string | null): Record<string, number> {
  const volumes: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!parsed || typeof parsed !== 'object') return volumes;
    for (const [identity, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        volumes[identity] = Math.min(VOLUME_MAX, Math.max(0, value));
      }
    }
  } catch {
    // Unreadable is the same as never set.
  }
  return volumes;
}

function read(): Record<string, number> {
  try {
    return parseVolumes(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

let current = read();
const listeners = new Set<() => void>();

export function getVoiceVolume(identity: string): number {
  return current[identity] ?? 1;
}

export function setVoiceVolume(identity: string, volume: number) {
  const next = { ...current };
  // Back to as sent is the same as never changed, and keeps the list short.
  if (volume === 1) delete next[identity];
  else next[identity] = Math.min(VOLUME_MAX, Math.max(0, volume));
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Remembering is a convenience; the volume still applies this session.
  }
  for (const listener of listeners) listener();
}

export function subscribeVoiceVolumes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVoiceVolume(identity: string): number {
  return useSyncExternalStore(subscribeVoiceVolumes, () => getVoiceVolume(identity));
}
