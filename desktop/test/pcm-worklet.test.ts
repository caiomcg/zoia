import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Runs the real pcm-worklet.js outside a browser: a fake AudioWorkletGlobalScope
 * around it, a producer posting WASAPI-shaped chunks on its own clock, and the
 * render quantum pulling 128 frames at a time on the other.
 *
 * The two clocks are what this is about. WASAPI loopback runs on the clock of
 * the device the captured app plays to; the AudioContext on its own. Measured
 * on an RX 9070 XT broadcast, the consumer ran about 0.5% fast: with audio
 * arriving steadily the buffer still drained 114 -> 37ms in fifteen seconds,
 * and every time it emptied the worklet re-primed with ~200ms of silence —
 * heard by the viewer as crackle and cut-outs.
 */

const SAMPLE_RATE = 48000;
const QUANTUM = 128;
const source = readFileSync(
  fileURLToPath(new URL('../src/renderer/public/pcm-worklet.js', import.meta.url)),
  'utf8',
);

interface Stats {
  underruns: number;
  drifted: number;
  latencyMs: number;
  rate?: number;
}

interface Processor {
  port: { onmessage: (event: { data: ArrayBuffer }) => void };
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
}

function loadWorklet(): { processor: Processor; stats: () => Stats | null } {
  let ctor: (new () => Processor) | null = null;
  let last: Stats | null = null;
  const context = vm.createContext({
    sampleRate: SAMPLE_RATE,
    AudioWorkletProcessor: class {
      port = {
        onmessage: null as unknown,
        postMessage: (message: Stats) => {
          last = message;
        },
      };
    },
    registerProcessor: (_name: string, processor: new () => Processor) => {
      ctor = processor;
    },
    Math,
    DataView,
    Float32Array,
  });
  vm.runInContext(source, context);
  if (!ctor) throw new Error('pcm-worklet.js registered no processor');
  return { processor: new (ctor as new () => Processor)(), stats: () => last };
}

/** A chunk of `frames` stereo frames of a quiet sine, as WASAPI sends them. */
function chunk(frames: number, phase: { t: number }): ArrayBuffer {
  const buffer = new ArrayBuffer(frames * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin(phase.t++ * 0.05) * 8000);
    view.setInt16(i * 4, value, true);
    view.setInt16(i * 4 + 2, value, true);
  }
  return buffer;
}

interface Run {
  /** Render quanta with any silence inserted mid-stream, after the first second. */
  gapQuanta: number;
  /** Separate stretches of inserted silence: each a hole someone could hear. */
  gapRuns: number;
  /** Total silence inserted, ms. */
  underrunMs: number;
  /** Audio thrown away to hold the ceiling, ms. */
  droppedMs: number;
  /** Buffer depth over the last half, ms. */
  depth: { min: number; max: number };
}

/**
 * `drift`: the producer's clock against the consumer's (-0.005 = 0.5% slow).
 * `pauses`: every 5s, 300ms in which no chunk is sent at all — the application
 * went quiet, and loopback-capture leaves out packets it judges silent.
 * `jitter`: hand-off delay, in chunks, now and then.
 */
function simulate(seconds: number, drift: number, pauses = false, jitter = false): Run {
  const { processor, stats } = loadWorklet();
  const output = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  const phase = { t: 0 };
  const chunkFrames = 480; // 10ms, WASAPI's usual period
  const producerRate = SAMPLE_RATE * (1 + drift);
  let produced = 0;
  let chunkIndex = 0;
  let held: ArrayBuffer[] = [];
  let gapQuanta = 0;
  let gapRuns = 0;
  let inGap = false;
  const depths: number[] = [];
  const quanta = Math.floor((seconds * SAMPLE_RATE) / QUANTUM);

  for (let q = 0; q < quanta; q++) {
    const now = ((q + 1) * QUANTUM) / SAMPLE_RATE;
    // Everything the producer has captured by now, on its own clock.
    while (produced + chunkFrames <= now * producerRate) {
      produced += chunkFrames;
      chunkIndex++;
      const data = chunk(chunkFrames, phase);
      if (pauses && chunkIndex % 500 < 30) continue;
      held.push(data);
    }
    // A stalled main thread delivers late and then in a burst.
    const stalled = jitter && chunkIndex % 50 < 3;
    if (!stalled) {
      for (const data of held) processor.port.onmessage({ data });
      held = [];
    }

    output[0].fill(1);
    processor.process([], [output]);
    // A run of exact zeros inside a sine is silence the worklet inserted.
    if (q * QUANTUM > SAMPLE_RATE) {
      let zeros = 0;
      for (const sample of output[0]) if (sample === 0) zeros++;
      const gap = zeros > 8;
      if (gap) gapQuanta++;
      if (gap && !inGap) gapRuns++;
      inGap = gap;
    }
    if (q > quanta / 2) depths.push(stats()?.latencyMs ?? 0);
  }

  const final = stats();
  return {
    gapQuanta,
    gapRuns,
    underrunMs: ((final?.underruns ?? 0) * 1000) / SAMPLE_RATE,
    droppedMs: ((final?.drifted ?? 0) * 1000) / SAMPLE_RATE,
    depth: { min: Math.min(...depths), max: Math.max(...depths) },
  };
}

describe('pcm-worklet', () => {
  test('a consumer 0.5% fast never runs the buffer dry', () => {
    const run = simulate(120, -0.005);
    assert.equal(run.gapQuanta, 0, JSON.stringify(run));
    assert.ok(run.depth.min > 40, JSON.stringify(run));
  });

  test('a consumer 0.5% slow never drops audio', () => {
    const run = simulate(120, 0.005);
    assert.equal(run.droppedMs, 0, JSON.stringify(run));
    assert.equal(run.gapQuanta, 0, JSON.stringify(run));
    assert.ok(run.depth.max < 260, JSON.stringify(run));
  });

  test('an application going quiet is heard as one silence, with no holes around it', () => {
    // Twelve 300ms pauses in a minute, on a consumer 0.5% fast as measured.
    const run = simulate(60, -0.005, true);
    assert.ok(run.gapRuns <= 12, JSON.stringify(run));
    // Each about as long as the pause it stands for: 300ms is ~112 quanta.
    assert.ok(run.gapQuanta <= 12 * 160, JSON.stringify(run));
  });

  test('a main thread that stalls and bursts is ridden out', () => {
    const run = simulate(60, 0, false, true);
    assert.equal(run.gapQuanta, 0, JSON.stringify(run));
    assert.equal(run.droppedMs, 0, JSON.stringify(run));
  });

  test('matched clocks hold the buffer near its target', () => {
    const run = simulate(60, 0);
    assert.equal(run.gapQuanta, 0, JSON.stringify(run));
    assert.ok(run.depth.max - run.depth.min < 40, JSON.stringify(run));
  });
});
