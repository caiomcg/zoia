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

export type NoiseSuppression = 'off' | 'standard';

export interface VoiceSettings {
  /** Empty: whatever the system calls the default. */
  microphoneId: string;
  noiseSuppression: NoiseSuppression;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

const STORAGE_KEY = 'zoia.voice';
export const MICROPHONE_KEY = 'zoia.microphoneId';

const DEFAULTS: VoiceSettings = {
  microphoneId: '',
  noiseSuppression: 'standard',
  echoCancellation: true,
  autoGainControl: true,
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
      stored.noiseSuppression === 'off' || stored.noiseSuppression === 'standard'
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
export function captureOptions(settings: VoiceSettings): AudioCaptureOptions {
  return {
    deviceId: settings.microphoneId ? { exact: settings.microphoneId } : undefined,
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression !== 'off',
    autoGainControl: settings.autoGainControl,
    channelCount: 1,
  };
}
