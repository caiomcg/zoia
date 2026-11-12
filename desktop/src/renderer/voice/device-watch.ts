/**
 * The one listener for audio devices coming and going. It runs before the
 * microphone and the speakers react, so that a default Windows moved onto a
 * device just plugged in is held off first (device-hold.ts): the microphone
 * (useVoice) and playback (audioSink) subscribe here instead of to
 * `devicechange` themselves, and take the device to use from deviceNow().
 *
 * Nothing is shown when that happens: Zoia just keeps the device it had.
 * Someone who wants the new one picks it in Settings › Voice or the quick
 * device menu. What is held lasts until a device is picked there, the held
 * device is unplugged, or the app restarts.
 */

import { useSyncExternalStore } from 'react';
import { getVoiceSettings, subscribeVoiceSettings } from './settings';
import { deviceToUse, newDefault, type AudioKind, type Listed } from './device-hold';

const KINDS = ['audioinput', 'audiooutput'] as const;

let devices: Listed[] | null = null;
const held: Record<AudioKind, string> = { audioinput: '', audiooutput: '' };
// Bumped on every change, for components that show what is in use.
let version = 0;
const listeners = new Set<() => void>();

function chosen(kind: AudioKind): string {
  const settings = getVoiceSettings();
  return kind === 'audioinput' ? settings.microphoneId : settings.speakerId;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

async function refresh(): Promise<void> {
  const after = await navigator.mediaDevices.enumerateDevices().catch(() => null);
  if (!after) return;
  const before = devices;
  devices = after;

  for (const kind of KINDS) {
    // Gone: nothing to hold on to any more, so the default it is.
    if (held[kind] && !after.some((d) => d.kind === kind && d.deviceId === held[kind])) {
      held[kind] = '';
    }
    // Only someone following the default is moved by it; a chosen device stays put.
    if (chosen(kind)) continue;
    const moved = newDefault(before, after, kind);
    // Already holding: keep the device held first, not one in between.
    if (moved && !held[kind]) {
      held[kind] = moved.from.deviceId;
      console.info(`[audio] a new ${kind} became the default; kept the one in use`);
    }
  }
  notify();
}

if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', () => void refresh());
  void refresh();
}

// Picking a device in Settings is the person's own choice: nothing is held
// for that kind any more.
let lastChosen: Record<AudioKind, string> = {
  audioinput: chosen('audioinput'),
  audiooutput: chosen('audiooutput'),
};
subscribeVoiceSettings(() => {
  let changed = false;
  for (const kind of KINDS) {
    const now = chosen(kind);
    if (now !== lastChosen[kind] && held[kind]) {
      held[kind] = '';
      changed = true;
    }
  }
  lastChosen = { audioinput: chosen('audioinput'), audiooutput: chosen('audiooutput') };
  if (changed) notify();
});

/** Called after every device change has been taken in, holds included. */
export function subscribeDevices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The device to use for a kind, given what is plugged in: the chosen one, the
 * held one, or '' for the system default. `list` is the caller's own listing,
 * so a caller never mixes two.
 */
export function deviceNow(kind: AudioKind, list: readonly Listed[]): string {
  return deviceToUse(chosen(kind), held[kind], list, kind);
}

/** The name of the device held for a kind, or '' when none is. */
export function heldDeviceName(kind: AudioKind): string {
  if (!held[kind]) return '';
  return devices?.find((d) => d.kind === kind && d.deviceId === held[kind])?.label ?? '';
}

/**
 * "System default" picked again, though it already was: the person wants
 * whatever Windows has now, so nothing is held for that kind.
 */
export function followDefault(kind: AudioKind): void {
  if (!held[kind]) return;
  held[kind] = '';
  notify();
}

function snapshot(): number {
  return version;
}

/** Re-renders a component whenever what is in use may have changed. */
export function useDeviceWatch(): number {
  return useSyncExternalStore(subscribeDevices, snapshot, snapshot);
}
