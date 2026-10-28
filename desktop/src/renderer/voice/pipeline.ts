/**
 * What happens to the microphone between the capture and the encoder
 * (ADR 0039): RNNoise in Enhanced mode, then the input sensitivity gate.
 *
 *   capture (AEC, AGC, Chromium NS in Standard)
 *     → RNNoise (Enhanced) → analyser → gate gain → the track LiveKit sends
 *
 * The same graph, without the gate, drives the meter in Settings › Voice, so
 * the meter shows what would be sent.
 */

import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
// Inlined as a data: URL and decoded here, never fetched: the app is loaded
// from file://, which fetch cannot read, and the page's policy allows no
// data: connections. Chromium has had WebAssembly SIMD since 91, so only the
// SIMD build is needed. Compiling it is what 'wasm-unsafe-eval' in
// index.html's policy is for.
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url&inline';
import { getVoiceSettings, levelToDb, SENSITIVITY_MIN } from './settings';
import { watchSpeaking } from './speaking';

/** RNNoise works on 48 kHz frames, and Opus is 48 kHz anyway. */
export const VOICE_SAMPLE_RATE = 48_000;

/** How often the gate reads the level. Not animation frames: those stop in the background. */
const GATE_TICK_MS = 10;

/** How long the gate stays open after the voice drops, so word endings are not cut. */
const GATE_HOLD_MS = 300;

/** How long push to talk keeps sending after the key is let go, for the last word. */
const PUSH_TO_TALK_RELEASE_MS = 200;

let pushToTalkHeld = false;
let pushToTalkReleasedAt = 0;

/** The push-to-talk shortcut, held or let go (src/main/shortcuts.ts). */
export function setPushToTalk(held: boolean) {
  if (pushToTalkHeld && !held) pushToTalkReleasedAt = performance.now();
  pushToTalkHeld = held;
}

/** Whether push to talk is sending now, release tail included. */
export function pushToTalkOpen(now = performance.now()): boolean {
  return pushToTalkHeld || now - pushToTalkReleasedAt < PUSH_TO_TALK_RELEASE_MS;
}

/** Fade times, in seconds: quick to open so first syllables pass, slower to close. */
const GATE_ATTACK_S = 0.005;
const GATE_RELEASE_S = 0.05;

let rnnoiseBinary: Promise<ArrayBuffer> | null = null;
const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** The bytes of a base64 data: URL. */
function decodeDataUrl(url: string): ArrayBuffer {
  const binary = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function rnnoiseNode(context: AudioContext): Promise<RnnoiseWorkletNode> {
  rnnoiseBinary ??= Promise.resolve().then(() => decodeDataUrl(rnnoiseWasmUrl));
  let loaded = workletLoaded.get(context);
  if (!loaded) {
    loaded = context.audioWorklet.addModule(rnnoiseWorkletUrl);
    workletLoaded.set(context, loaded);
  }
  const [wasmBinary] = await Promise.all([rnnoiseBinary, loaded]);
  return new RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 1 });
}

/** The peak of what the analyser last saw, 0 to 1. */
export function peakOf(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

export interface VoiceGraph {
  /** After noise suppression, before the gate: what the meter shows. */
  analyser: AnalyserNode;
  /** What is sent, gate applied. */
  output: MediaStreamTrack;
  destroy(): void;
}

/**
 * Builds the graph on `input`. With `gate`, what is sent follows the input
 * mode: push to talk, or the sensitivity, read live so the slider needs no
 * rebuild. With `speaker`, that identity's ring follows what is sent.
 */
export async function buildVoiceGraph(
  context: AudioContext,
  input: MediaStreamTrack,
  { gate, speaker }: { gate: boolean; speaker?: string },
): Promise<VoiceGraph> {
  if (context.state === 'suspended') await context.resume().catch(() => {});
  const source = context.createMediaStreamSource(new MediaStream([input]));
  const denoise =
    getVoiceSettings().noiseSuppression === 'enhanced' ? await rnnoiseNode(context) : null;
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();
  destination.channelCount = 1;

  (denoise ? source.connect(denoise) : source).connect(analyser);
  analyser.connect(gain).connect(destination);
  // What actually leaves, gate and mute included: the ring shows only that.
  const sent = context.createAnalyser();
  sent.fftSize = 1024;
  gain.connect(sent);
  const sentSamples = new Float32Array(sent.fftSize);
  const stopSpeaking = speaker ? watchSpeaking(speaker, () => peakOf(sent, sentSamples)) : null;

  let timer: ReturnType<typeof setInterval> | null = null;
  if (gate) {
    const samples = new Float32Array(analyser.fftSize);
    let openUntil = 0;
    let open = true;
    timer = setInterval(() => {
      const { sensitivity, inputMode } = getVoiceSettings();
      const now = performance.now();
      let shouldOpen: boolean;
      if (inputMode === 'pushToTalk') {
        shouldOpen = pushToTalkOpen(now);
      } else {
        if (sensitivity <= SENSITIVITY_MIN || levelToDb(peakOf(analyser, samples)) >= sensitivity) {
          openUntil = now + GATE_HOLD_MS;
        }
        shouldOpen = now < openUntil;
      }
      if (shouldOpen === open) return;
      open = shouldOpen;
      gain.gain.setTargetAtTime(
        open ? 1 : 0,
        context.currentTime,
        open ? GATE_ATTACK_S : GATE_RELEASE_S,
      );
    }, GATE_TICK_MS);
  }

  const [output] = destination.stream.getAudioTracks();
  if (!output) throw new Error('No processed microphone track');
  return {
    analyser,
    output,
    destroy() {
      if (timer) clearInterval(timer);
      stopSpeaking?.();
      sent.disconnect();
      source.disconnect();
      denoise?.disconnect();
      denoise?.destroy();
      analyser.disconnect();
      gain.disconnect();
      output.stop();
    },
  };
}

/** The graph as LiveKit's processor: a restart (new device, new settings) rebuilds it. */
export class VoiceProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'zoia-voice';
  processedTrack?: MediaStreamTrack;
  private graph: VoiceGraph | null = null;
  // LiveKit passes the context to init only: a restart (restartTrack) brings
  // the new track alone.
  private context: AudioContext | null = null;

  /** `identity` is yours, for your own ring. */
  constructor(private readonly identity?: string) {}

  async init({ track, audioContext }: AudioProcessorOptions) {
    this.context = audioContext ?? this.context;
    if (!this.context) throw new Error('No audio context for the microphone');
    this.graph = await buildVoiceGraph(this.context, track, {
      gate: true,
      speaker: this.identity,
    });
    this.processedTrack = this.graph.output;
  }

  async restart(options: AudioProcessorOptions) {
    this.graph?.destroy();
    this.graph = null;
    await this.init(options);
  }

  async destroy() {
    this.graph?.destroy();
    this.graph = null;
    this.processedTrack = undefined;
  }
}
