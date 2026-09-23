# 9. Hardware encoding via Windows Graphics Capture and NVENC

- **Status:** accepted, but **disabled by default**
- **Date:** 2026-09-22

## Context

Sharing a 4K screen made the picture blurry and the machine loud. The obvious suspicion —
that the stream was not being compressed properly — was wrong. It was being compressed
entirely on the CPU, by a software H.264 encoder, on a machine with an RTX 4070 SUPER
sitting idle.

Chromium will not use that GPU. Measured, not assumed:

- `navigator.mediaCapabilities.encodingInfo()` reports `powerEfficient: false` for H.264,
  VP8, VP9 **and** AV1, at every resolution — in Electron *and* in stock Chrome.
- A live publish reports `encoderImplementation: "OpenH264"`, a software encoder.

`getGPUFeatureStatus()` was consulted early and actively misleading: it reported states that
contradicted `chrome://gpu` on the same machine. The RTP sender's own
`encoderImplementation` is the only honest answer to "what is encoding this", because it
names the encoder WebRTC actually instantiated.

So no amount of configuration gets hardware encoding out of Chromium's WebRTC stack on
Windows. Getting it means not using that stack.

## What was tried first, and why it failed

**Capturing in Chromium and encoding elsewhere.** Pull frames with
`MediaStreamTrackProcessor`, hand the `VideoFrame`s to a native encoder. This reached
**14 fps at 4K** and no higher. The cost was not encoding — it was a GPU→CPU readback plus
three copies per frame, paid before the encoder saw anything. Moving the scaling to the GPU
made it *worse* (1–3 fps). Abandoned.

**`ddagrab` and `gdigrab` via ffmpeg.** `gdigrab` produced blank frames for the windows that
matter — confirmed by writing one out as a PNG and looking at it. `ddagrab` captures a
*display*, not a window, and the request was explicitly for a running application, not a
region of a screen.

## Decision

Do what Discord does: **capture and encode without the pixels ever leaving the GPU.**

```
Windows Graphics Capture  ──►  D3D11 texture  ──►  NVENC  ──►  H.264
        (per window)              (GPU)           (GPU)          │
                                                                 ▼
                                              ffmpeg ─── WHIP ───►  LiveKit Ingress
                                                                       │
                                                   an ordinary participant in the room
```

A native addon (`desktop/native/`) captures the chosen window with WGC and encodes it with
NVENC via a single `CopyResource` into one registered input surface. ffmpeg muxes the
resulting H.264 with the captured application audio and publishes over WHIP. LiveKit's
ingress turns that into a normal track, with `bypassTranscoding` so the SFU forwards the
already-encoded stream rather than re-encoding it on a 4-core box with no GPU.

Chromium's WebRTC encoder is never involved. That is the entire point.

## Why the frame rate is what it is

WGC is **event-driven**: it delivers a frame when the window redraws. A window that is not
redrawing produces no frames, which looks like a stall and is not one. The encoder is not
the limit — measured at **8.8 ms per frame at 4K**, a ceiling of roughly 114 fps.

This is also why "background apps stop streaming" was a real bug and not a misunderstanding:
an occluded or minimised window genuinely stops redrawing.

## Four ffmpeg facts, each of which cost an evening

- **The ffmpeg build must use GnuTLS.** A build against Windows SChannel completes the DTLS
  handshake and then dies with *"no SRTP Protection Profile was chosen"*, because SChannel
  has no `use_srtp` extension. WHIP cannot work with it at all.
- **`-whip_flags dtls_active`** — without it, neither side starts the handshake.
- **`-ts_buffer_size 16000000`** — the default stalls at 4K bitrates.
- **stdin must never starve.** A silence keep-alive is written every 50 ms, because a
  starved audio input stalls *video*. This is the least obvious of the four.

## Consequences

- **Disabled by default**, behind `MODE_SELECTION_ENABLED` in the renderer. It works, and it
  is off until it has settled. The code stays; the switch is one constant.
- **NVIDIA only.** A friend on AMD hit `nvEncodeAPI64.dll could not be loaded` as a hard
  crash. Capability is now probed at startup — `LoadLibraryW` on that DLL — and the app
  falls back to CPU silently rather than failing at "go live".
- **LAN only.** The WHIP endpoint is plain HTTP and deliberately not internet-exposed, so a
  remote broadcaster uses the ordinary in-app path. `WHIP_BASE_URL` has no default; the
  server throws if the hardware path is requested without one.
- The ingress joins as a **separate participant**, which has two consequences that were both
  bugs first: viewers saw nothing until the client stopped looking exclusively for
  `ScreenShare` (an ingress publishes `CAMERA`, since WHIP has no notion of a screen share),
  and the broadcaster heard their own audio echoed until the client learned to skip its own
  `<identity>-nvenc` participant.
- The repository now carries a C++ addon and a vendored ~100 MB ffmpeg. Neither can be built
  or exercised by CI on Linux, so this path is verified by hand on Windows.
- Two native crashes are permanently guarded against: `winrt::init_apartment` throwing
  `RPC_E_CHANGED_MODE` because Electron's main thread is already STA, and exceptions
  escaping `FrameArrived` on a WinRT threadpool thread. Both killed the process outright.
