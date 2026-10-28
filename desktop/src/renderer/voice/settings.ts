/**
 * How the microphone is captured for voice, remembered per machine. One store
 * shared by the settings pane and the live track, so a change applies to the
 * microphone at once, without leaving voice.
 *
 * The microphone itself is the camera's too: one choice, under the key the
 * camera dialog has always used.
 */

import { useSyncExternalStore } from 'react';
import type { AudioCaptureOptions } from 'livekit-client';

/**
 * Off; Standard, Chromium's own, good on steady hum; Enhanced, RNNoise, which
 * also takes keyboards, clicks and voices in the room (pipeline.ts).
 */
export type NoiseSuppression = 'off' | 'standard' | 'enhanced';

const NOISE_MODES: readonly NoiseSuppression[] = ['off', 'standard', 'enhanced'];

/** Sending whenever you speak above the sensitivity, or only while a shortcut is held. */
export type InputMode = 'voiceActivity' | 'pushToTalk';

export interface VoiceSettings {
  /** Empty: whatever the system calls the default. */
  microphoneId: string;
  noiseSuppression: NoiseSuppression;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /**
   * Input sensitivity, in dBFS: quieter than this and nothing is sent, as
   * Discord's slider. SENSITIVITY_MIN sends everything.
   */
  sensitivity: number;
  /** Sensitivity follows the room's noise (NoiseFloor) instead of the slider. */
  autoSensitivity: boolean;
  inputMode: InputMode;
}

/** What getUserMedia is asked for; the rest applies to the captured sound. */
export type CaptureSettings = Pick<
  VoiceSettings,
  'microphoneId' | 'noiseSuppression' | 'echoCancellation' | 'autoGainControl'
>;

/** The slider's range. Its quiet end is no gate at all. */
export const SENSITIVITY_MIN = -70;
export const SENSITIVITY_MAX = 0;

/** A peak sample, 0 to 1, in dBFS, floored at the slider's quiet end. */
export function levelToDb(level: number): number {
  return level > 0 ? Math.max(SENSITIVITY_MIN, 20 * Math.log10(level)) : SENSITIVITY_MIN;
}

/** Where a dBFS value sits on the slider, 0 to 1. */
export function dbFraction(db: number): number {
  return (db - SENSITIVITY_MIN) / (SENSITIVITY_MAX - SENSITIVITY_MIN);
}

const STORAGE_KEY = 'zoia.voice';
export const MICROPHONE_KEY = 'zoia.microphoneId';

const DEFAULTS: VoiceSettings = {
  microphoneId: '',
  noiseSuppression: 'enhanced',
  echoCancellation: true,
  autoGainControl: true,
  sensitivity: SENSITIVITY_MIN,
  autoSensitivity: true,
  inputMode: 'voiceActivity',
};

export function parseVoiceSettings(raw: string | null, microphoneId: string | null): VoiceSettings {
  let stored: Partial<VoiceSettings> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (parsed && typeof parsed === 'object') stored = parsed as Partial<VoiceSettings>;
  } catch {
    // Unreadable is the same as never set.
  }
  return {
    microphoneId: microphoneId ?? DEFAULTS.microphoneId,
    noiseSuppression:
      stored.noiseSuppression && NOISE_MODES.includes(stored.noiseSuppression)
        ? stored.noiseSuppression
        : DEFAULTS.noiseSuppression,
    echoCancellation:
      typeof stored.echoCancellation === 'boolean'
        ? stored.echoCancellation
        : DEFAULTS.echoCancellation,
    autoGainControl:
      typeof stored.autoGainControl === 'boolean'
        ? stored.autoGainControl
        : DEFAULTS.autoGainControl,
    sensitivity:
      typeof stored.sensitivity === 'number' && Number.isFinite(stored.sensitivity)
        ? Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, stored.sensitivity))
        : DEFAULTS.sensitivity,
    autoSensitivity:
      typeof stored.autoSensitivity === 'boolean'
        ? stored.autoSensitivity
        : DEFAULTS.autoSensitivity,
    inputMode: stored.inputMode === 'pushToTalk' ? 'pushToTalk' : 'voiceActivity',
  };
}

function read(): VoiceSettings {
  try {
    return parseVoiceSettings(
      localStorage.getItem(STORAGE_KEY),
      localStorage.getItem(MICROPHONE_KEY),
    );
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const listeners = new Set<() => void>();

export function getVoiceSettings(): VoiceSettings {
  return current;
}

export function setVoiceSettings(next: VoiceSettings): void {
  current = next;
  try {
    const { microphoneId, ...processing } = next;
    localStorage.setItem(MICROPHONE_KEY, microphoneId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(processing));
  } catch {
    // Remembering is a convenience; the change still applies this session.
  }
  for (const listener of listeners) listener();
}

export function subscribeVoiceSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(subscribeVoiceSettings, getVoiceSettings);
}

/**
 * What Chromium is asked for. Mono, since a voice is one channel and stereo
 * only doubles what the noise suppressor and the encoder have to do. Echo
 * cancellation is on by default: whatever is being watched plays out of the
 * same speakers the microphone hears.
 */
export function captureOptions(settings: CaptureSettings): AudioCaptureOptions {
  return {
    deviceId: settings.microphoneId ? { exact: settings.microphoneId } : undefined,
    echoCancellation: settings.echoCancellation,
    // Enhanced replaces Chromium's suppression rather than stacking on it.
    noiseSuppression: settings.noiseSuppression === 'standard',
    autoGainControl: settings.autoGainControl,
    channelCount: 1,
  };
}

/** Automatic sensitivity: how far above the room's noise a voice must be, in dB. */
export const AUTO_MARGIN_DB = 15;
/** Its range: never so low it sends the room, nor so high it eats a quiet voice. */
export const AUTO_MIN_DB = -58;
export const AUTO_MAX_DB = -28;
/** How fast the floor rises, in dB a second: slowly, so talking does not lift it. */
const FLOOR_RISE_DB_S = 1.5;
/** How fast it falls to a quieter room, as a share of the gap a second. */
const FLOOR_FALL_S = 8;

/**
 * The room's noise, tracked from the level: it falls quickly to anything
 * quieter, so a pause between words resets it, and rises slowly, so a long
 * sentence does not drag it up to the voice. The threshold sits a margin
 * above it.
 */
export class NoiseFloor {
  private floor = AUTO_MIN_DB - AUTO_MARGIN_DB;
  private last: number | null = null;

  /** Feeds one level, in dBFS, at `now` in ms; returns the threshold. */
  update(db: number, now: number): number {
    const dt = this.last === null ? 0 : Math.min(1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (db < this.floor) this.floor += (db - this.floor) * Math.min(1, dt * FLOOR_FALL_S);
    else this.floor = Math.min(db, this.floor + FLOOR_RISE_DB_S * dt);
    return this.threshold;
  }

  get threshold(): number {
    return Math.min(AUTO_MAX_DB, Math.max(AUTO_MIN_DB, this.floor + AUTO_MARGIN_DB));
  }
}
