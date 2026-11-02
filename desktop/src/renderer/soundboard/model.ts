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

/**
 * Playing locks you out for exactly as long as the sound you played lasts,
 * from when it starts playing to when it ends, so sounds cannot be sent in a
 * burst. The longest is MAX_SOUND_SECONDS, where every sound is cut.
 */
export const MAX_LOCK_MS = 10_000;

/**
 * What a listener forgives of a sender's lock: what the network may close up
 * between two of their messages.
 */
export const NETWORK_SLACK_MS = 500;

/** How long a sound of `seconds` plays, so how long it locks the player out, in ms. */
export function lockMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(MAX_LOCK_MS, Math.round(seconds * 1000));
}

/**
 * The least time between two of one person's entrance sounds (ADR 0046), so
 * hopping between channels or dropping off and back is not a soundboard.
 */
export const ENTRANCE_COOLDOWN_MS = 60_000;

/**
 * How long after someone arrives their sound and their microphone may still
 * come: whether the microphone is on decides whether the sound plays. Past
 * it, they have arrived, and nothing more is played for it.
 */
export const ENTRANCE_WAIT_MS = 8_000;

/** What a sound is, which sets how loud it plays and which mutes silence it. */
export type SoundKind = 'effect' | 'entrance';

export interface SoundboardSettings {
  /** 0–1, on top of the file's own level. */
  volume: number;
  /** Nothing from the soundboard plays, and you cannot play to others. */
  muted: boolean;
  /** Identities whose sounds you do not hear. */
  mutedPeople: string[];
  /** Entrance sounds' volume, 0–1, apart from the effects'. */
  entranceVolume: number;
  /** No entrance sound plays for you. Yours still plays for everyone else. */
  entrancesMuted: boolean;
  /** Identities whose entrance sound you do not hear, their effects aside. */
  mutedEntrances: string[];
}

export const DEFAULT_SOUNDBOARD_SETTINGS: SoundboardSettings = {
  volume: 0.5,
  muted: false,
  mutedPeople: [],
  entranceVolume: 0.5,
  entrancesMuted: false,
  mutedEntrances: [],
};

function parseVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function parseIdentities(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((p): p is string => typeof p === 'string' && !!p))]
    : [];
}

/** Settings from storage, field by field: whatever is unreadable is the default. */
export function parseSoundboardSettings(raw: string | null): SoundboardSettings {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
  } catch {
    // Unreadable is the same as never set.
  }
  const { volume, muted, mutedPeople, entranceVolume, entrancesMuted, mutedEntrances } = stored;
  return {
    volume: parseVolume(volume, DEFAULT_SOUNDBOARD_SETTINGS.volume),
    muted: muted === true,
    mutedPeople: parseIdentities(mutedPeople),
    entranceVolume: parseVolume(entranceVolume, DEFAULT_SOUNDBOARD_SETTINGS.entranceVolume),
    entrancesMuted: entrancesMuted === true,
    mutedEntrances: parseIdentities(mutedEntrances),
  };
}

/** How loud the soundboard plays: nothing while muted. */
export function effectsGain(settings: SoundboardSettings): number {
  return settings.muted ? 0 : settings.volume;
}

/** How loud entrance sounds play: nothing while muted, whatever the effects do. */
export function entranceGain(settings: SoundboardSettings): number {
  return settings.entrancesMuted ? 0 : settings.entranceVolume;
}

/** Whether `identity`'s entrance sound plays for you. Muting their effects has no part in it. */
export function hearsEntrance(settings: SoundboardSettings, identity: string): boolean {
  return !settings.entrancesMuted && !settings.mutedEntrances.includes(identity);
}

export function setEntranceMuted(
  settings: SoundboardSettings,
  identity: string,
  muted: boolean,
): SoundboardSettings {
  const others = settings.mutedEntrances.filter((p) => p !== identity);
  return { ...settings, mutedEntrances: muted ? [...others, identity] : others };
}

/** One entrance sound per person per ENTRANCE_COOLDOWN_MS, across every channel. */
export class EntranceCooldown {
  private played = new Map<string, number>();

  ready(identity: string, now: number): boolean {
    const last = this.played.get(identity);
    return last === undefined || now - last >= ENTRANCE_COOLDOWN_MS;
  }

  mark(identity: string, now: number): void {
    this.played.set(identity, now);
  }
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

/**
 * Holds each key back while its last sound plays: one sound at a time per
 * person. A sound is taken when it arrives and held, once it starts, until
 * it ends.
 */
export class SoundLock {
  private held = new Map<string, { at: number; until: number }>();
  private readonly slack: number;

  /** `slack` ms of each lock are forgiven: a listener's, for the network. */
  constructor(slack = 0) {
    this.slack = slack;
  }

  /** Whether `key` may play at `now`; if so, the sound is taken. */
  take(key: string, now: number): boolean {
    const held = this.held.get(key);
    if (held && now < held.until - this.slack) return false;
    this.held.set(key, { at: now, until: now });
    return true;
  }

  /**
   * The sound `key` took at `at` plays until `until`: held till then. Ignored
   * if `key` has taken another since.
   */
  hold(key: string, at: number, until: number): void {
    const held = this.held.get(key);
    if (held?.at === at) held.until = until;
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

/**
 * Quieter than this (about -40 dB) is silence: what a sound's file holds
 * before its first sound and after its last.
 */
export const SILENCE_LEVEL = 0.01;

/**
 * Where a decoded sound is heard, in seconds: from its first sample above
 * SILENCE_LEVEL, on any channel, to just after its last. A file padded with
 * silence would otherwise lock its player out long after it fell quiet. A
 * sound that is silence throughout is played, and locks, whole.
 */
export function audibleRange(
  channels: readonly ArrayLike<number>[],
  sampleRate: number,
): { from: number; to: number } {
  const length = Math.max(0, ...channels.map((c) => c.length));
  let first = -1;
  let last = -1;
  for (const samples of channels) {
    for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i] ?? 0) > SILENCE_LEVEL) {
        if (first === -1 || i < first) first = i;
        break;
      }
    }
    for (let i = samples.length - 1; i > last; i--) {
      if (Math.abs(samples[i] ?? 0) > SILENCE_LEVEL) {
        last = i;
        break;
      }
    }
  }
  if (first === -1) return { from: 0, to: length / sampleRate };
  return { from: first / sampleRate, to: (last + 1) / sampleRate };
}
