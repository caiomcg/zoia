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
 *
 * Two clocks meet here. WASAPI loopback delivers on the clock of the device
 * the captured application plays to; this processor is pulled on the
 * AudioContext's. They are never exactly equal, so the buffer between them
 * drifts. It used to be left to drift until it hit a wall: emptied, then
 * re-primed with ~200ms of silence, or overfull, then cut. Measured on an
 * RX 9070 XT broadcast, the context ran 0.5% fast — the buffer drained from
 * 114 to 37ms in fifteen seconds of steady audio and re-primed every half
 * minute or so, and the viewer heard it as crackle and cut-outs. (Those were
 * the "re-buffering events every 15-30s" that an earlier, deeper cushion was
 * meant to cure; a deeper cushion only takes longer to empty.)
 *
 * Now playback runs very slightly faster or slower — within 1%, interpolated
 * — to hold the buffer at a target, the way every real-time audio receiver
 * absorbs clock drift. A difference of 0.5% is inaudible; a 200ms hole is
 * not. The same control absorbs the packets loopback-capture leaves out
 * because it judged them silent.
 */

const CHANNELS = 2;
const RING_SECONDS = 1;
const SAMPLE_RATE = 48000; // loopback-capture's documented, fixed output rate

// Where the buffer is held, and how deep it must be before playback starts.
//
// Measured on real hardware: without priming, the very first process() calls
// drain the ring the instant a single sample exists, while chunk delivery is
// still ramping up (AudioContext/IPC startup jitter), heard as choppy audio
// at the start of every broadcast. Holding silent output until a cushion has
// built removes that race. The same depth is the target afterwards: deep
// enough to ride out a main thread that delays the hand-off by tens of
// milliseconds, shallow enough to keep audio close to the picture.
const TARGET_MS = 120;

// The playback-rate controller. Off target by 50ms, playback runs 0.5% fast
// or slow; never more than 1%. The rate moves smoothly towards that,
// rather than jumping, so it is never heard to change.
const RATE_PER_MS = 0.0001;
const MAX_RATE_ADJUST = 0.01;
const RATE_SMOOTHING = 0.02;

// The hard ceiling on how far audio may lag video: only a burst no gentle
// rate change could absorb in time (a main thread stalled for a third of a
// second, then delivering everything at once) is cut back to the target.
const MAX_LATENCY_MS = 400;

// A single empty sample is unremarkable — re-buffering for a whole target's
// worth over one frame would be far more audible than the frame itself. Only
// a sustained gap (the application went silent, or a real stall) re-arms
// priming, in render quanta of 128 frames: about 53ms.
const EMPTY_STREAK_TO_REPRIME = 20;

class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringLength = SAMPLE_RATE * RING_SECONDS;
    this.targetFrames = Math.floor((SAMPLE_RATE * TARGET_MS) / 1000);
    this.maxFrames = Math.floor((SAMPLE_RATE * MAX_LATENCY_MS) / 1000);
    this.drifted = 0;
    this.channels = [new Float32Array(this.ringLength), new Float32Array(this.ringLength)];
    this.writeIndex = 0;
    // Fractional: playback reads between samples when its rate is not 1.
    this.readPosition = 0;
    this.available = 0;
    this.rate = 1;
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
        if (this.available < this.ringLength - 2) {
          this.available++;
        } else {
          // Overrun: the ring is full because process() is reading slower
          // than chunks arrive. Drop the oldest frame rather than block.
          this.readPosition = (this.readPosition + 1) % this.ringLength;
          this.overruns++;
        }
      }

      // Beyond the ceiling, back to the target in one cut, oldest first. Rare
      // by design now: the rate control keeps ordinary drift well inside it.
      if (this.available > this.maxFrames) {
        const excess = Math.floor(this.available - this.targetFrames);
        this.readPosition = (this.readPosition + excess) % this.ringLength;
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
          // Playback speed against real time: how much drift is being absorbed.
          rate: this.rate,
        });
        this.peak = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frameCount = output && output[0] ? output[0].length : 128;

    if (!this.primed) {
      if (this.available >= this.targetFrames) {
        this.primed = true;
        this.emptyStreak = 0;
        this.rate = 1;
      } else {
        for (let c = 0; c < output.length; c++) output[c].fill(0);
        return true;
      }
    }

    // Towards the rate that would bring the buffer back to its target.
    const errorMs = ((this.available - this.targetFrames) / SAMPLE_RATE) * 1000;
    const wanted = 1 + Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, errorMs * RATE_PER_MS));
    this.rate += (wanted - this.rate) * RATE_SMOOTHING;

    let sawData = false;
    for (let i = 0; i < frameCount; i++) {
      // Two samples to interpolate between; one short is an underrun.
      const hasData = this.available >= 2;
      if (hasData) sawData = true;
      else this.underruns++;

      const index = Math.floor(this.readPosition);
      const next = (index + 1) % this.ringLength;
      const fraction = this.readPosition - index;
      for (let c = 0; c < output.length; c++) {
        const src = this.channels[c < CHANNELS ? c : CHANNELS - 1];
        output[c][i] = hasData ? src[index] + (src[next] - src[index]) * fraction : 0;
      }

      if (hasData) {
        this.readPosition += this.rate;
        if (this.readPosition >= this.ringLength) this.readPosition -= this.ringLength;
        this.available -= this.rate;
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
