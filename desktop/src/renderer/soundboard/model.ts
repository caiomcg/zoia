/**
 * What the soundboard keeps and decides (ADR 0040), pure so it can be tested
 * without a room or an AudioContext: the settings, the recent sounds, and
 * how often one person may play. Your pad's are in shared/soundboard.ts.
 *
 * Only types are imported, so `node --test` can load it directly.
 */

import type { Sound } from '../../shared/soundboard';

/** Few enough to sit under the pad without pushing it away. */
export const MAX_RECENTS = 4;

/** One sound every two seconds, per person: the sender waits this long. */
export const SEND_INTERVAL_MS = 2000;

/**
 * What a listener allows between one person's sounds: the sender's two
 * seconds, less what the network may close up between two messages.
 */
export const RECEIVE_INTERVAL_MS = 1500;

export interface SoundboardSettings {
  /** 0–1, on top of the file's own level. */
  volume: number;
  /** Nothing from the soundboard plays, and you cannot play to others. */
  muted: boolean;
  /** Identities whose sounds you do not hear. */
  mutedPeople: string[];
}

export const DEFAULT_SOUNDBOARD_SETTINGS: SoundboardSettings = {
  volume: 0.5,
  muted: false,
  mutedPeople: [],
};

/** Settings from storage, field by field: whatever is unreadable is the default. */
export function parseSoundboardSettings(raw: string | null): SoundboardSettings {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
  } catch {
    // Unreadable is the same as never set.
  }
  const { volume, muted, mutedPeople } = stored;
  return {
    volume:
      typeof volume === 'number' && Number.isFinite(volume)
        ? Math.min(1, Math.max(0, volume))
        : DEFAULT_SOUNDBOARD_SETTINGS.volume,
    muted: muted === true,
    mutedPeople: Array.isArray(mutedPeople)
      ? [...new Set(mutedPeople.filter((p): p is string => typeof p === 'string' && !!p))]
      : [],
  };
}

/** How loud the soundboard plays: nothing while muted. */
export function effectsGain(settings: SoundboardSettings): number {
  return settings.muted ? 0 : settings.volume;
}

export function setPersonMuted(
  settings: SoundboardSettings,
  identity: string,
  muted: boolean,
): SoundboardSettings {
  const others = settings.mutedPeople.filter((p) => p !== identity);
  return { ...settings, mutedPeople: muted ? [...others, identity] : others };
}

/**
 * `sound` played just now: first, once, and the oldest past MAX_RECENTS gone.
 * A sound on your pad is not recent, it is kept: `kept` names the pad's.
 */
export function addRecent(
  recents: readonly Sound[],
  sound: Sound,
  kept: readonly { slug: string }[] = [],
): Sound[] {
  if (kept.some((k) => k.slug === sound.slug)) return [...recents];
  return [sound, ...recents.filter((s) => s.slug !== sound.slug)].slice(0, MAX_RECENTS);
}

export function removeRecent(recents: readonly Sound[], slug: string): Sound[] {
  return recents.filter((s) => s.slug !== slug);
}

/** Lets through one event per key every `interval` ms. */
export class Throttle {
  private last = new Map<string, number>();
  private readonly interval: number;

  constructor(interval: number) {
    this.interval = interval;
  }

  /** Whether `key` may go now; if so, it is counted. */
  take(key: string, now: number): boolean {
    const last = this.last.get(key);
    if (last !== undefined && now - last < this.interval) return false;
    this.last.set(key, now);
    return true;
  }
}

/** Why you cannot play to the channel right now, or null when you can. */
export type SendBlock = 'notInVoice' | 'micMuted' | 'effectsMuted';

export function sendBlock(
  voice: { inVoice: boolean; muted: boolean },
  settings: SoundboardSettings,
): SendBlock | null {
  if (!voice.inVoice) return 'notInVoice';
  if (voice.muted) return 'micMuted';
  if (settings.muted) return 'effectsMuted';
  return null;
}
