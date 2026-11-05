/**
 * Audio output sink routing (Windows & desktop output device selection).
 *
 * Keeps track of all active AudioContexts and HTMLMediaElements in the renderer,
 * and sets their sinkId to the chosen speakerId (from voice settings).
 * Empty string ("") routes to the system default output device.
 */

import { getVoiceSettings, subscribeVoiceSettings } from './settings';

const registeredContexts = new Set<AudioContext>();
const registeredElements = new Set<HTMLMediaElement>();

function applySink(target: AudioContext | HTMLMediaElement, sinkId: string): void {
  try {
    const candidate = target as unknown as { setSinkId?: (id: string) => Promise<void> };
    if (typeof candidate.setSinkId === 'function') {
      void candidate.setSinkId(sinkId).catch(() => {});
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
  applySink(target, getVoiceSettings().speakerId);

  if (target instanceof AudioContext) {
    registeredContexts.add(target);
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

// When speakerId changes, update all active audio sinks immediately.
subscribeVoiceSettings(() => {
  const { speakerId } = getVoiceSettings();
  for (const ctx of registeredContexts) {
    applySink(ctx, speakerId);
  }
  for (const el of registeredElements) {
    applySink(el, speakerId);
  }
});
