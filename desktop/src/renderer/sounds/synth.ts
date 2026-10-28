/**
 * Plays the cues from cues.ts, synthesised with Web Audio rather than shipped
 * as files: each is a few enveloped oscillator notes, so a style or pitch
 * change is a parameter, not a new asset, and nothing is added to app.asar.
 */

import {
  notesFor,
  voiceFor,
  type CueEvent,
  type CueSettings,
  type Note,
  type StyleVoice,
} from './cues';

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

/** Plays `event` at the overall `volume`, times the cue's own when it has one. */
export function playCue(
  event: CueEvent,
  cue: Pick<CueSettings, 'style' | 'pitch'> & Partial<Pick<CueSettings, 'volume'>>,
  overall: number,
): void {
  playNotes(voiceFor(event, cue.style), notesFor(event, cue), overall * (cue.volume ?? 1));
}

/** Plays `notes` in `voice`, at `volume` of the cue level. */
function playNotes(voice: StyleVoice, notes: readonly Note[], volume: number): void {
  if (volume <= 0) return;
  let ctx: AudioContext;
  try {
    ctx = audioContext();
  } catch {
    // No audio output at all: a cue is never worth an error.
    return;
  }
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
  for (const note of notes) {
    const partials: [number, number][] = [[note.frequency, 1]];
    if (voice.overtone > 0) partials.push([note.frequency * 2, voice.overtone]);
    for (const [ratio, level] of voice.partials ?? []) {
      partials.push([note.frequency * ratio, level]);
    }
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

export type VoiceCue = 'mute' | 'unmute' | 'deafen' | 'undeafen';

/** A soft, short tone: confirmation, not an event in the channel. */
const VOICE_CUE_VOICE: StyleVoice = {
  wave: 'sine',
  base: 0,
  gap: 0,
  duration: 0.12,
  attack: 0.004,
  overtone: 0.08,
  lowpass: 0,
};

/**
 * Down to go quiet, up to come back, as Discord has it; deafen lower than
 * mute, so the two are told apart without looking.
 */
const VOICE_CUE_NOTES: Record<VoiceCue, Note[]> = {
  mute: [
    { at: 0, frequency: 659.3, duration: 0.12 },
    { at: 0.08, frequency: 493.9, duration: 0.16 },
  ],
  unmute: [
    { at: 0, frequency: 493.9, duration: 0.12 },
    { at: 0.08, frequency: 659.3, duration: 0.16 },
  ],
  deafen: [
    { at: 0, frequency: 392, duration: 0.12 },
    { at: 0.08, frequency: 293.7, duration: 0.18 },
  ],
  undeafen: [
    { at: 0, frequency: 293.7, duration: 0.12 },
    { at: 0.08, frequency: 392, duration: 0.18 },
  ],
};

/** How long a voice cue lasts: deafening waits for it, or it would silence itself. */
export const VOICE_CUE_MS = 280;

/** Confirms a shortcut's mute or deafen, at the overall cue volume. */
export function playVoiceCue(cue: VoiceCue, overall: number): void {
  playNotes(VOICE_CUE_VOICE, VOICE_CUE_NOTES[cue], overall);
}
