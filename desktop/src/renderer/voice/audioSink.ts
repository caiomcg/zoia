/**
 * Audio output sink routing (Windows & desktop output device selection).
 *
 * Keeps track of all active AudioContexts and HTMLMediaElements in the renderer,
 * and sets their sinkId to the chosen speakerId (from voice settings).
 * Empty string ("") routes to the system default output device.
 *
 * A chosen output that is unplugged falls back to the system default, and
 * sound moves back to it as soon as it is plugged in again: the choice is
 * kept, only the device in use changes (availableDeviceId).
 */

import {
  availableDeviceId,
  getVoiceSettings,
  subscribeVoiceSettings,
  type ListedDevice,
} from './settings';

const registeredContexts = new Set<AudioContext>();
const registeredElements = new Set<HTMLMediaElement>();

// The outputs last listed; null until the first listing, when the choice is
// trusted rather than routing everything to the default for a moment.
let outputs: readonly ListedDevice[] | null = null;
// The sink every target is routed to, to re-route only on a change.
let currentSink: string | null = null;

/** The output to play on now: the chosen one if it is plugged in, else the default. */
function sinkNow(): string {
  const { speakerId } = getVoiceSettings();
  return outputs ? availableDeviceId(speakerId, outputs, 'audiooutput') : speakerId;
}

function applySink(target: AudioContext | HTMLMediaElement, sinkId: string): void {
  try {
    const candidate = target as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (typeof candidate.setSinkId === 'function') {
      void candidate
        .setSinkId(sinkId)
        .catch((err: unknown) => console.warn('[audio] could not route playback', err));
    }
  } catch {
    // Unsupported or permission error; falls back to system default.
  }
}

/**
 * Registers an AudioContext or HTMLMediaElement to follow the selected speakerId.
 * Returns an unregister function to call on teardown / unmount.
 */
export function registerAudioSink(target: AudioContext | HTMLMediaElement): () => void {
  applySink(target, sinkNow());

  if (target instanceof AudioContext) {
    registeredContexts.add(target);
    // Losing its device can stop a context; this shows when it happens.
    target.addEventListener('statechange', () =>
      console.info(`[audio] playback context is ${target.state}`),
    );
    target.addEventListener('error', (event) =>
      console.warn('[audio] playback context failed on its device', event),
    );
    return () => {
      registeredContexts.delete(target);
    };
  } else {
    registeredElements.add(target);
    return () => {
      registeredElements.delete(target);
    };
  }
}

/** Routes every active target to the sink in use, if that changed. */
function routeAll(): void {
  const sink = sinkNow();
  if (sink === currentSink) return;
  currentSink = sink;
  for (const ctx of registeredContexts) {
    applySink(ctx, sink);
  }
  for (const el of registeredElements) {
    applySink(el, sink);
  }
}

async function refreshOutputs(): Promise<void> {
  outputs = await navigator.mediaDevices.enumerateDevices().catch(() => outputs ?? []);
  const before = currentSink;
  routeAll();
  if (currentSink !== before) {
    console.info(
      `[audio] playback moved to ${currentSink ? 'the chosen output' : 'the system default'}`,
    );
  }
  // A context whose device vanished can be left stopped; nothing here ever
  // suspends one on purpose, so any that is not running is started again.
  for (const ctx of registeredContexts) {
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      console.info(`[audio] playback context was ${ctx.state}; resuming`);
      void ctx
        .resume()
        .catch((err: unknown) => console.warn('[audio] could not resume playback', err));
    }
  }
}

// When speakerId changes, update all active audio sinks immediately.
subscribeVoiceSettings(routeAll);

// A device coming or going may move the sound: off an unplugged output onto
// the default, and back onto it when it returns.
if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', () => void refreshOutputs());
  void refreshOutputs();
}
