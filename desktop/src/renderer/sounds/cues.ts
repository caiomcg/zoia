/**
 * Short sound cues for what happens in a channel: someone joining or leaving,
 * someone going live or stopping; and in the chats, someone @mentioning you. This module is pure — deciding which cues a
 * change deserves, what the settings are, and which notes a cue is made of —
 * so it can be tested without an AudioContext. Playing them is in synth.ts.
 */

export type CueEvent = 'join' | 'leave' | 'streamStart' | 'streamStop' | 'mention';

export const CUE_EVENTS: readonly CueEvent[] = [
  'join',
  'leave',
  'streamStart',
  'streamStop',
  'mention',
];

export type CueStyle = 'chime' | 'pop' | 'soft';

export const CUE_STYLES: readonly CueStyle[] = ['chime', 'pop', 'soft'];

export interface CueSettings {
  enabled: boolean;
  style: CueStyle;
  /** Semitones up or down from the style's own pitch. */
  pitch: number;
  /** 0–1, on top of the overall volume. */
  volume: number;
}

export interface SoundSettings {
  /** 0–1. Zero is the same as off, but keeps each cue's own choice. */
  volume: number;
  cues: Record<CueEvent, CueSettings>;
}

export const PITCH_RANGE = 6;

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  volume: 0.6,
  cues: {
    join: { enabled: true, style: 'chime', pitch: 0, volume: 1 },
    leave: { enabled: true, style: 'chime', pitch: 0, volume: 1 },
    streamStart: { enabled: true, style: 'pop', pitch: 0, volume: 1 },
    streamStop: { enabled: true, style: 'pop', pitch: 0, volume: 1 },
    mention: { enabled: true, style: 'chime', pitch: 0, volume: 1 },
  },
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/**
 * Settings from storage, repaired field by field. A stored value from an
 * older or newer build keeps whatever still makes sense instead of resetting
 * everything, and a corrupt one falls back to the defaults.
 */
export function parseSoundSettings(raw: string | null): SoundSettings {
  let stored: unknown = null;
  try {
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  const source = (stored && typeof stored === 'object' ? stored : {}) as Partial<{
    volume: unknown;
    cues: Record<string, unknown>;
  }>;
  const cues = {} as Record<CueEvent, CueSettings>;
  for (const event of CUE_EVENTS) {
    const fallback = DEFAULT_SOUND_SETTINGS.cues[event];
    const cue = (source.cues?.[event] ?? {}) as Partial<Record<keyof CueSettings, unknown>>;
    cues[event] = {
      enabled: typeof cue.enabled === 'boolean' ? cue.enabled : fallback.enabled,
      style: CUE_STYLES.includes(cue.style as CueStyle) ? (cue.style as CueStyle) : fallback.style,
      pitch: Math.round(clamp(cue.pitch, -PITCH_RANGE, PITCH_RANGE, fallback.pitch)),
      volume: clamp(cue.volume, 0, 1, fallback.volume),
    };
  }
  return { volume: clamp(source.volume, 0, 1, DEFAULT_SOUND_SETTINGS.volume), cues };
}

/** The part of a room member a cue depends on. */
export interface CueMember {
  identity: string;
  isLocal: boolean;
  isBroadcasting: boolean;
}

/**
 * The cues a change in the member list deserves, each at most once. Only
 * other people's: this device's own going live and stopping is heard from its
 * broadcast state instead (see useSoundCues), which changes the moment it
 * happens — the member list only learns of it on a later room event. Someone
 * who leaves while live gets the leave cue alone — the stream ending is part
 * of them going.
 */
export function cuesBetween(
  previous: readonly CueMember[],
  next: readonly CueMember[],
): CueEvent[] {
  const before = new Map(previous.map((member) => [member.identity, member]));
  const after = new Map(next.map((member) => [member.identity, member]));
  const events = new Set<CueEvent>();

  for (const member of next) {
    if (member.isLocal) continue;
    const was = before.get(member.identity);
    if (!was) {
      events.add('join');
      if (member.isBroadcasting) events.add('streamStart');
    } else if (member.isBroadcasting !== was.isBroadcasting) {
      events.add(member.isBroadcasting ? 'streamStart' : 'streamStop');
    }
  }
  for (const member of previous) {
    if (!after.has(member.identity) && !member.isLocal) events.add('leave');
  }
  return CUE_EVENTS.filter((event) => events.has(event));
}

export interface Note {
  /** Seconds from the start of the cue. */
  at: number;
  frequency: number;
  /** Seconds until the note has decayed to silence. */
  duration: number;
}

export interface StyleVoice {
  wave: OscillatorType;
  /** The first note of a rising cue. */
  base: number;
  gap: number;
  duration: number;
  attack: number;
  /** A quieter octave above, which is what makes a chime a chime. */
  overtone: number;
  /** Low-pass cutoff in Hz, or 0 for none. */
  lowpass: number;
  /** More partials, as [ratio to the note, level]: uneven ones make a bell. */
  partials?: [number, number][];
}

export const STYLE_VOICES: Record<CueStyle, StyleVoice> = {
  chime: {
    wave: 'sine',
    base: 880,
    gap: 0.09,
    duration: 0.35,
    attack: 0.005,
    overtone: 0.18,
    lowpass: 0,
  },
  pop: {
    wave: 'triangle',
    base: 660,
    gap: 0.07,
    duration: 0.09,
    attack: 0.002,
    overtone: 0,
    lowpass: 3200,
  },
  soft: {
    wave: 'sine',
    base: 440,
    gap: 0.12,
    duration: 0.3,
    attack: 0.04,
    overtone: 0,
    lowpass: 1200,
  },
};

/**
 * Cues with a sound of their own, the same whatever style or pitch is set:
 * a mention must never be mistaken for something a channel does. It is a
 * small bell struck twice, rising; the uneven partials are what make it a
 * bell, and no channel cue has them. Only on and off are its to choose.
 */
export const FIXED_CUES: Partial<Record<CueEvent, { voice: StyleVoice; notes: Note[] }>> = {
  mention: {
    voice: {
      wave: 'sine',
      base: 1046.5,
      gap: 0.13,
      duration: 0.7,
      attack: 0.002,
      overtone: 0,
      lowpass: 0,
      partials: [
        [2.76, 0.32],
        [5.4, 0.1],
      ],
    },
    notes: [
      { at: 0, frequency: 1046.5, duration: 0.5 },
      { at: 0.13, frequency: 1318.5, duration: 0.8 },
    ],
  },
};

export const isFixedCue = (event: CueEvent) => FIXED_CUES[event] !== undefined;

/** The voice a cue plays in: its own when fixed, else its style's. */
export function voiceFor(event: CueEvent, style: CueStyle): StyleVoice {
  return FIXED_CUES[event]?.voice ?? STYLE_VOICES[style];
}

/**
 * Semitone steps: arrivals rise and departures fall, so the two can be told
 * apart without looking; streams use three notes, presence two.
 */
const PATTERNS: Partial<Record<CueEvent, number[]>> = {
  join: [0, 7],
  leave: [7, 0],
  streamStart: [0, 4, 7],
  streamStop: [7, 4, 0],
};

export function notesFor(event: CueEvent, cue: Pick<CueSettings, 'style' | 'pitch'>): Note[] {
  const fixed = FIXED_CUES[event];
  if (fixed) return fixed.notes;
  const voice = STYLE_VOICES[cue.style];
  return (PATTERNS[event] ?? []).map((step, index) => ({
    at: index * voice.gap,
    frequency: voice.base * 2 ** ((step + cue.pitch) / 12),
    duration: voice.duration,
  }));
}
