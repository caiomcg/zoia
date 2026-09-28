# 25. Resilient GPU broadcasting pipeline with opt-in fallback

- **Status:** accepted
- **Date:** 2026-09-27
- **Extends and amends:** [ADR 0011](0011-hardware-encoding-over-the-internet.md)

## Context

[ADR 0011](0011-hardware-encoding-over-the-internet.md) established direct WHIP publishing to
the SFU across NVIDIA, AMD, and Intel GPUs. However, the path was switched off for all users
(`hardware = false` with a "Coming soon" label in Settings) after real-world test sessions
revealed several failure modes:

1. **Uncapped game framerates and memory exhaustion.** Windows Graphics Capture (WGC) is
   event-driven and fires per frame presented. When games ran with uncapped framerates or on
   high-refresh displays (144Hz–240Hz+), WGC delivered hundreds of frames per second. On
   non-NVENC adapters (AMD, Intel, or CPU fallback), each raw BGRA frame is ~8.3 MB at 1080p.
   Delivering them faster than the encoder consumed them backed up the pipe and flooded Node's
   V8 heap with hundreds of megabytes in seconds, triggering prolonged garbage collection stalls
   and freezing the desktop UI.
2. **Backpressure in Node streams.** When FFmpeg's `stdin` experienced write backpressure,
   continuing to queue uncompressed buffers in memory caused unbounded heap growth.
3. **Burst packet loss over domestic connections.** A generous VBV buffer
   (`-bufsize String(bitrate)`) allowed FFmpeg to transmit large UDP packet bursts, resulting
   in buffer bloat, packet drops, and NACK storms on viewer connections.
4. **No startup fallback.** If the native capture or WHIP negotiation failed at "go live",
   the broadcast aborted outright with an error dialog, leaving the user with a broken
   broadcast instead of falling back to standard CPU capture.
5. **Stage leakage on encoder death.** If FFmpeg or the native capture process exited
   unexpectedly mid-broadcast, the client state reverted to idle but never called
   `stage.release()`, leaving the participant's stage slot claimed on the server and blocking
   others from broadcasting until the idle timeout expired.
6. **Unknown adapter crashes.** Adapters not matching recognized strings defaulted to
   `h264_nvenc`, failing immediately on systems without NVIDIA hardware.

## Decision

Re-enable the hardware-accelerated broadcast path behind an opt-in "Beta" setting with
multi-layer resilience safeguards:

1. **Capture framerate throttling at the source:**
   - In `desktop/native/src/addon.cpp`, the WGC frame pool calculates elapsed time between
     frames and discards any frame arriving sooner than `(1000 / targetFps) - 2` ms. High-FPS
     games no longer generate unnecessary D3D11 copies or readbacks.
   - In `desktop/src/main/index.ts`, raw BGRA delivery to the encoder pipe is similarly throttled
     to the configured preset framerate.
2. **Selective backpressure frame dropping:**
   - In `desktop/src/main/encoder.ts`, `writeFrame()` checks `stdin.writableLength`. For
     uncompressed BGRA frames, any positive backpressure causes immediate frame dropping
     to protect V8 heap memory.
   - For NVENC passthrough H.264 (`-c:v copy`), frames are already compact NAL units. Dropping
     P-frames mid-GOP corrupts video for viewers, so frames are preserved during normal
     fluctuations and only dropped under severe congestion (>256 KB).
3. **FFmpeg transmission tuning:**
   - Constrained `-bufsize` to `Math.floor(bitrate / 2)` and added `-reorder_queue_size 1024`
     to smooth packet pacing and mitigate NACK storms.
   - Added explicit audio sample rate (`-ar 48000`) and stream mapping (`-map 0:v`, `-map 1:a`).
   - Added `libx264` ultrafast zerolatency tuning as a safe software fallback for unknown
     adapters.
4. **Atomic fallback to window broadcast:**
   - If `gpuCast.start()` returns false, the application automatically initiates
     `room.startBroadcast()` retaining the claimed stage (`keepStage: true`), avoiding race
     conditions or brief stage drops.
5. **Stage lifecycle integrity:**
   - When the GPU encoder stops unexpectedly without an active League client handoff,
     `useGpuBroadcast` explicitly invokes `window.zoia.stage.release()`.
6. **Opt-in setting with clear status:**
   - The toggle in *Settings > Broadcast* is restored as an opt-in checkbox labeled "Beta".
     It is disabled with explanatory text if no compatible hardware encoder is detected.

## Consequences

- Broadcasters with supported GPUs can choose hardware acceleration to reduce CPU overhead
  without risking UI lockups or memory exhaustion during high-framerate gameplay.
- A GPU initialization failure no longer kills the broadcast; the broadcaster transitions
  to standard window capture transparently.
- Memory usage remains stable regardless of how fast the shared game or application renders.
- An unexpected encoder termination immediately frees the broadcast slot on the server.
- The C++ native addon and vendored FFmpeg remain Windows-only components verified locally
  rather than in Linux CI.
