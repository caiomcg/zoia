/**
 * Converts interleaved S16LE stereo PCM chunks (posted from the main thread,
 * relayed from WASAPI via IPC) into audio graph output.
 *
 * Plain JS, not TypeScript, and placed under public/ rather than bundled:
 * AudioWorkletProcessor modules are loaded by URL via addModule(), a
 * completely separate loading path from the rest of the app's bundle, and
 * public/ is the one place Vite serves a file byte-for-byte at a stable path
 * with no transform step to get wrong.
 *
 * Runs on the dedicated audio rendering thread, not the main thread. That is
 * why underrun/overrun are handled here rather than upstream: this is the
 * one place that actually knows, sample by sample, whether data arrived in
 * time.
 */

const CHANNELS = 2;
const RING_SECONDS = 1;
const SAMPLE_RATE = 48000; // loopback-capture's documented, fixed output rate

// Measured on real hardware: without priming, the very first process() calls
// drain the ring the instant a single sample exists, while chunk delivery is
// still ramping up (AudioContext/IPC startup jitter). That produced a burst
// of underruns lasting tens of seconds before delivery caught up — audible
// as choppy audio at the start of every broadcast. Holding silent output
// until a cushion has built removes that race entirely.
//
// 300ms rather than a smaller value: with priming alone at 150ms, long
// clean stretches (20-30s with zero underruns) were still interrupted every
// 15-30s by a full re-buffering event — almost certainly the renderer's
// main thread (also encoding 1080p60 video at the same time) occasionally
// delaying the chunk hand-off by tens of milliseconds. A shallow cushion
// drains to zero on that delay and re-primes audibly; a deeper one absorbs
// it without ever emptying. The tradeoff is latency, and 300ms is still
// small next to this app's end-to-end latency budget.
const PRIME_MS = 150;

// The hard ceiling on how far audio may lag video.
//
// The capture clock (WASAPI) and the playback clock (AudioContext) are not
// the same clock, so the ring drifts: a producer even slightly faster than
// the consumer accumulates samples, and every accumulated sample is added
// latency that never comes back. Previously the only backstop was the ring
// being *completely full* — a full second of drift before anything was
// dropped, heard as audio running progressively behind the picture.
//
// Holding the buffer near the priming depth instead keeps the A/V offset
// small and, more importantly, stable. Dropping a few milliseconds of audio
// is inaudible; a drifting half-second offset is not.
const MAX_LATENCY_MS = 260;
// A single empty sample is unremarkable — re-buffering for 150ms over one
// frame would be far more audible than the frame itself. Only a sustained
// gap (a real stall, not a rounding-error blip) re-arms priming.
const EMPTY_STREAK_TO_REPRIME = 20;

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringLength = SAMPLE_RATE * RING_SECONDS;
    this.primeFrames = Math.floor((SAMPLE_RATE * PRIME_MS) / 1000);
    this.maxFrames = Math.floor((SAMPLE_RATE * MAX_LATENCY_MS) / 1000);
    this.drifted = 0;
    this.channels = [new Float32Array(this.ringLength), new Float32Array(this.ringLength)];
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;
    this.primed = false;
    this.emptyStreak = 0;
    this.underruns = 0;
    this.overruns = 0;
    this.statsTick = 0;
    this.peak = 0;

    this.port.onmessage = (event) => {
      const buffer = event.data;
      const view = new DataView(buffer);
      const frameCount = Math.floor(buffer.byteLength / 2 / CHANNELS);

      for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < CHANNELS; c++) {
          const offset = (i * CHANNELS + c) * 2;
          // true = little-endian, matching WASAPI's native S16LE output.
          this.channels[c][this.writeIndex] = view.getInt16(offset, true) / 32768;
        }
        this.writeIndex = (this.writeIndex + 1) % this.ringLength;
        if (this.available < this.ringLength) {
          this.available++;
        } else {
          // Overrun: the ring is full because process() is reading slower
          // than chunks arrive. Drop the oldest frame rather than block.
          this.readIndex = (this.readIndex + 1) % this.ringLength;
          this.overruns++;
        }
      }

      // Discard anything beyond the latency ceiling, oldest first, so the
      // offset against video stays bounded instead of growing all session.
      if (this.available > this.maxFrames) {
        const excess = this.available - this.maxFrames;
        this.readIndex = (this.readIndex + excess) % this.ringLength;
        this.available -= excess;
        this.drifted += excess;
      }

      // Peak level of this chunk, measured on the captured samples rather
      // than on playback output: this must read correctly even while the
      // buffer is still priming and nothing is audible yet. It is the one
      // honest answer to "is this app's audio actually being captured".
      let peak = 0;
      for (let i = 0; i < frameCount * CHANNELS; i++) {
        const sample = Math.abs(view.getInt16(i * 2, true) / 32768);
        if (sample > peak) peak = sample;
      }
      this.peak = Math.max(this.peak, peak);

      // Surface counters and level a few times a second, not per message.
      this.statsTick++;
      if (this.statsTick % 10 === 0) {
        this.port.postMessage({
          underruns: this.underruns,
          overruns: this.overruns,
          peak: this.peak,
          // Current buffer depth in ms — this *is* the audio/video offset
          // contributed by this stage, so it is worth being able to see.
          latencyMs: Math.round((this.available / SAMPLE_RATE) * 1000),
          drifted: this.drifted,
        });
        this.peak = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frameCount = output && output[0] ? output[0].length : 128;

    if (!this.primed) {
      if (this.available >= this.primeFrames) {
        this.primed = true;
        this.emptyStreak = 0;
      } else {
        for (let c = 0; c < output.length; c++) output[c].fill(0);
        return true;
      }
    }

    let sawData = false;
    for (let i = 0; i < frameCount; i++) {
      const hasData = this.available > 0;
      if (hasData) sawData = true;
      else this.underruns++;

      for (let c = 0; c < output.length; c++) {
        const src = this.channels[c < CHANNELS ? c : CHANNELS - 1];
        output[c][i] = hasData ? src[this.readIndex] : 0;
      }

      if (hasData) {
        this.readIndex = (this.readIndex + 1) % this.ringLength;
        this.available--;
      }
    }

    // A real stall (not a single-frame blip) gets treated like a fresh
    // start: rebuild the cushion rather than keep limping sample by sample.
    this.emptyStreak = sawData ? 0 : this.emptyStreak + 1;
    if (this.emptyStreak > EMPTY_STREAK_TO_REPRIME) {
      this.primed = false;
      this.emptyStreak = 0;
    }

    return true;
  }
}

registerProcessor('pcm-playback', PcmPlaybackProcessor);
