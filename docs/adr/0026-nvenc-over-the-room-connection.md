# 26. NVENC frames over the room's own WebRTC connection

- **Status:** accepted
- **Date:** 2026-09-28
- **Amends:** [ADR 0011](0011-hardware-encoding-over-the-internet.md),
  [ADR 0024](0024-resilient-gpu-broadcasting-pipeline.md) — for NVIDIA only
- **Amended by:** [ADR 0030](0030-amf-over-the-room-connection.md) — the same route for AMD,
  and an adaptive bitrate for both

## Context

The hardware path of ADR 0011 and 0024 captures a window with Windows Graphics Capture, encodes
it with NVENC in the native addon, and hands the bitstream to ffmpeg, which muxes it with the
application's audio and publishes over WHIP as a second participant. Sharing a game with it
ran at around 3fps, and every fix to one stage exposed the next:

1. **ffmpeg holds one input back for the other.** Video was stamped by wall clock and audio by
   sample count. When the captured app's audio ran a few percent slow, ffmpeg stopped reading
   video to wait for it; the pipe filled and nearly every frame was dropped. Reproduced
   outside the app: audio fed at 97% of real time took a 4K stream from 57fps to 26fps.
   Stamping audio by wall clock moved the stall rather than removing it.
2. **Dropped frames smear.** The bitstream is copied, not re-encoded, so a dropped frame left
   every following one decoding against the wrong picture until the next keyframe.
3. **No keyframe on request.** A viewer that lost packets or joined late waited out the GOP.
4. **ffmpeg's WHIP client reads only the first ICE candidate** and aborts if it is TCP, which
   LiveKit lists first. Some attempts failed before sending anything.
5. **4K went out at the preset's bitrate.** Nothing scaled, so a 4K window on the 1080p preset
   had a quarter of the bits per pixel it needed.

Discord's own description of its streaming stack is the opposite shape: a hardware encoder,
and "audio and video are sent over separate RTP packets and the receiver synchronizes them".
Chromium already does that for the room connection, and already carries this app's audio
there well; it only lacks a hardware H.264 encoder on Windows.

## Decision

For an NVIDIA adapter sharing a window, send NVENC's frames on the room's own WebRTC
connection, through Chromium, in place of Chromium's own encode:

- The addon scales the window to the preset's size on the GPU (the D3D11 video processor)
  before NVENC, paces capture against a schedule rather than a truncated gap, and can force an
  IDR on request.
- The main process forwards each encoded frame over a `MessagePort` straight to a worker in the
  renderer, not over ordinary IPC: IPC lands on the page's main thread, which also relays the
  audio, and 4K frames there were audible as crackling.
- The page publishes a placeholder track (`MediaStreamTrackGenerator`), writing one tiny frame
  per NVENC frame. An `RTCRtpScriptTransform` swaps each encoded placeholder for the NVENC
  frame before packetization, and asks NVENC for a keyframe when a viewer does.
- The transform is attached when LiveKit adds the transceiver, before negotiation. Attached
  after `publishTrack`, Chromium creates it but never feeds it, and the placeholder goes out.

Everything after the transform — packetization, pacing, retransmission, bandwidth estimation
and audio/video sync — is Chromium's WebRTC stack. Viewers receive an ordinary H.264 track.

## Consequences

- One connection and one participant carry the whole broadcast; the ffmpeg process, the audio
  pipe, WHIP and the `-gpu` participant are gone from this path. Measured: 4K60 and 1080p60 of
  a game on an RTX 4070 SUPER with no stalls, no dropped frames and clean audio.
- **It rests on a technique Chromium does not advertise:** replacing encoded frames wholesale
  in a sender transform. It works in Electron 44 (Chromium 152); a Chromium change to encoded
  transforms could break it, and it should be re-checked on each Electron upgrade.
- The placeholder is still encoded by OpenH264 (16×16, negligible), and the negotiated
  profile is Chromium's while NVENC sends High profile. Viewers decode it; a stricter decoder
  might not.
- NVENC's bitrate is fixed at the preset's. Chromium's bandwidth estimate does not yet reach
  the encoder, so a viewer on a weak link gets retransmissions rather than a lower bitrate.
- `RTCPeerConnection.prototype.addTransceiver` is wrapped for the moment the placeholder is
  published, and restored immediately after.
- Windows Graphics Capture itself delivers at most 48fps from a 144Hz game on the test
  machine; the stream follows it. That limit is upstream of this change.
- Whole screens go the same way since 0.4.1, captured by monitor with WGC, so NVIDIA no
  longer uses ffmpeg at all. The addon fits every capture into a size fixed at the start and
  refits it when the window changes size, and the sharer's preview is NVENC's output decoded
  locally.
- **Unchanged:** AMD and Intel (AMF / Quick Sync through ffmpeg) and macOS (Chromium with
  VideoToolbox). The AMD and Intel paths keep the ffmpeg failure modes above.
