# 30. AMF frames over the room's own WebRTC connection, at an adaptive bitrate

- **Status:** accepted
- **Date:** 2026-10-06
- **Amends:** [ADR 0026](0026-nvenc-over-the-room-connection.md) — extends it to AMD, and adds
  bitrate adaptation to both encoders

## Context

ADR 0026 moved NVIDIA off the ffmpeg + WHIP route and onto the room's own connection. Radeons
stayed on that route: the addon read every frame back off the GPU, the main process piped it
to ffmpeg, and ffmpeg encoded it with `h264_amf` and published over WHIP. Radeon owners
reported broadcasts that skipped frames where NVIDIA did not. A 13-minute broadcast on an
RX 9070 XT, logged end to end, put the causes on that route rather than on the encoder:

1. **Lost packets were never retransmitted.** ffmpeg's WHIP muxer accepts a NACK only when it
   is alone in its datagram; LiveKit sends NACKs inside compound RTCP, so all 30 in those 13
   minutes were refused. A viewer who lost a packet saw a broken or frozen picture until the
   next keyframe. Upstream ffmpeg has the same code.
2. **No keyframe on request.** The muxer ignores PLI, so a late joiner or a viewer recovering
   from loss waited out the GOP — which is why that GOP was half a second, at a bitrate cost.
3. **The CPU did work the GPU had already done.** ffmpeg took the NV12 frames as an unknown
   colourspace and converted every one through RGB (7.7s of CPU per 600 frames at 1080p, against
   0.9s without), while a game competed for the same cores.
4. **Every frame crossed the main process.** Several megabytes, sixty times a second, through
   a thread that also stalls on the UI; a stall became a burst of stale frames, a duplicate
   and then a skip.
5. **The bitrate was fixed.** Neither ffmpeg nor NVENC's route adapted to the uplink, so on a
   link that could not hold the preset, packets queued and then dropped.

Patching ffmpeg fixes the first (and is done: `desktop/ffmpeg/patches/0001`, built in CI, for
the routes that still use it). It cannot fix the rest without rebuilding inside ffmpeg what
Chromium already does on the room connection.

## Decision

For an AMD adapter sharing a window or a screen, encode with AMF in the native addon and send
its frames on the room connection exactly as NVENC's are:

- `AmfEncoder` sits beside `NvencEncoder` behind one `VideoEncoder` interface in `addon.cpp`.
  It opens on the capture's own D3D11 device, is fed BT.709 limited-range NV12 rendered by the
  same D3D11 video processor that scales, and returns one Annex B frame per input. The runtime
  (`amfrt64.dll`) comes with AMD's driver and is loaded at run time; only the SDK's headers are
  vendored (`native/include/AMF`, v1.5.3).
- Rate control is AMF's latency-constrained VBR with a two-frame VBV — what the ffmpeg route
  measured best — with filler and frame skipping off. A keyframe every two seconds, counted by
  the addon (the low-latency usages were measured ignoring `IDR_PERIOD`), and one on request.
- If AMF declines, the addon falls back to the raw readback, and the renderer to the ffmpeg
  route: a Radeon never ends up with less than it had.

And for both encoders, adapt the bitrate: once a second the renderer reads Chromium's estimate
of the uplink (`availableOutgoingBitrate`) and moves the encoder to fit, in place, with no
keyframe — `nvEncReconfigureEncoder` for NVENC, AMF's dynamic bitrate properties for AMF. Down
at once to 90% of the estimate, up by at most 15% a step, never above the preset nor below a
floor, and nothing for the first ten seconds while the estimate climbs
(`renderer/livekit/adaptive-bitrate.ts`).

Intel keeps the ffmpeg route, now with the patched ffmpeg.

## Consequences

- Measured on an RX 9070 XT, capturing a game at 1080p60: 3.7ms a frame to encode, a keyframe
  every two seconds plus one 9ms after it was asked for, and a bitrate change from 12 to 3 Mbps
  applied mid-stream with no keyframe and no restart. The bitstream decodes cleanly.
- AMD gains what NVIDIA got in ADR 0026: pacing, NACK retransmission and PLI from Chromium,
  one clock for audio and video, and no ffmpeg process or main-process frame copies.
- Bitrate adaptation is new for NVIDIA too, and unlike everything above it was not measured on
  NVIDIA hardware before landing. A driver that refuses the reconfigure stops the adaptation
  and keeps the preset's bitrate — the old behaviour — but one that accepts it and then
  misbehaves would only show in use.
- The adaptation trusts Chromium's estimate, which reads the real frames (the transform swaps
  them in before pacing). It cannot see a viewer's downlink; with one layer and no simulcast, a
  viewer slower than the sharer's uplink still depends on the SFU.
- The ffmpeg the app ships is now built from source in CI instead of downloaded, so its
  toolchain, dependencies and patches are ours to keep current. A change under
  `desktop/ffmpeg/` is a full release, not an OTA one.
- The ffmpeg + WHIP route remains for Intel and for AMF failures, and with it all of
  `encoder.ts`'s raw-frame machinery. It is now the less-travelled path, and correspondingly
  more likely to rot.
