/**
 * Plays the cues from cues.ts, synthesised with Web Audio rather than shipped
 * as files: each is a few enveloped oscillator notes, so a style or pitch
 * change is a parameter, not a new asset, and nothing is added to app.asar.
 */

import { STYLE_VOICES, notesFor, type CueEvent, type CueSettings } from './cues';

/** Loud enough to notice under a stream's audio, quiet enough not to startle. */
const PEAK_GAIN = 0.25;

let context: AudioContext | null = null;

function audioContext(): AudioContext {
  context ??= new AudioContext();
  // Chromium starts a context suspended until the page has had a gesture; the
  // settings preview is one, and Electron does not hold cues back without it.
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return context;
}

export function playCue(
  event: CueEvent,
  cue: Pick<CueSettings, 'style' | 'pitch'>,
  volume: number,
): void {
  if (volume <= 0) return;
  let ctx: AudioContext;
  try {
    ctx = audioContext();
  } catch {
    // No audio output at all: a cue is never worth an error.
    return;
  }
  const voice = STYLE_VOICES[cue.style];
  const start = ctx.currentTime + 0.01;

  const output = ctx.createGain();
  output.gain.value = PEAK_GAIN * volume;
  let tail: AudioNode = output;
  if (voice.lowpass > 0) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = voice.lowpass;
    output.connect(filter);
    tail = filter;
  }
  tail.connect(ctx.destination);

  let end = start;
  for (const note of notesFor(event, cue)) {
    const partials: [number, number][] = [[note.frequency, 1]];
    if (voice.overtone > 0) partials.push([note.frequency * 2, voice.overtone]);
    for (const [frequency, level] of partials) {
      const oscillator = ctx.createOscillator();
      const envelope = ctx.createGain();
      const at = start + note.at;
      oscillator.type = voice.wave;
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.linearRampToValueAtTime(level, at + voice.attack);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + note.duration);
      oscillator.connect(envelope).connect(output);
      oscillator.start(at);
      oscillator.stop(at + note.duration + 0.02);
      end = Math.max(end, at + note.duration + 0.02);
    }
  }
  setTimeout(() => tail.disconnect(), (end - ctx.currentTime) * 1000 + 100);
}
