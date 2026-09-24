# 11. Hardware encoding over the internet, on any GPU

- **Status:** accepted
- **Date:** 2026-09-24
- **Supersedes** the "NVIDIA only" and "LAN only" consequences of
  [ADR 0009](0009-hardware-encoding.md), and replaces its LiveKit Ingress with the SFU's
  own WHIP endpoint. The rest of 0009 still stands.

## Context

[ADR 0009](0009-hardware-encoding.md) made hardware encoding work for one person: the
server's owner, on an NVIDIA card, on the same network as the server. A separate LiveKit
**Ingress** service received the stream over WHIP at `http://<lan-ip>:8085`. The ADR said
remote publishers would "fall back to the in-app Chromium path".

**That fallback was never built.** When hardware encoding came back as a checkbox in the
share picker, three testers turned it on: one on a Radeon, one on a GTX 1060, and one on an
RTX 5090. All three failed. Their reports were treated as three separate GPU bugs, and four
fixes landed:

- `-profile:v baseline` was dropped. This ffmpeg build rejects `-profile:v` entirely.
- The NVENC headers went from SDK 12.2 (needs driver ≥ 551.76) to 11.1 (≥ 471.41).
- The capture device had been created on the default adapter. On a laptop with switchable
  graphics that's the integrated GPU, where NVENC can't open.
- AMF was given a profile it doesn't have.

Every one was a real fault, and **none of them was why the testers failed.** The server's
own logs showed the cause the first time anyone read them:

```
Stream #0:0 -> #0:0 (rawvideo (native) -> h264 (h264_amf))     ← the encoder opened
Connection to tcp://<lan-ip>:8085 failed: Error number -138 ← the endpoint did not
```

The WHIP endpoint was a private address that no machine outside the LAN can reach. The
failure was identical on every GPU because the GPU was never involved.

It took this long for two reasons. ffmpeg's output only went to a console that a packaged
app doesn't have. And the one line that reached the UI was chosen by a matcher that
reliably picked `Conversion failed!`, ffmpeg's generic last line, over the cause printed
directly above it.

The first fix was to expose the Ingress: route it through Caddy and forward its UDP port,
7885, on the router. That raised a fair question. **Why does WHIP need a second media port
when WebRTC already has one?**

It needed one only because the Ingress is a *second WebRTC server*. It terminated the WHIP
session on its own port, then republished the stream into the SFU over localhost. The SFU
itself, `livekit-server` 1.13.7, **serves WHIP natively** at `/whip/v1`, on the host and
UDP port the room already uses. The Ingress was a detour.

## Decision

**Publish hardware-encoded broadcasts straight to the SFU over WHIP, from anywhere, on any
GPU.**

*Endpoint.* `https://<sfu-host>/whip/v1`, derived on the server from `LIVEKIT_WS_URL`
(`wss://` becomes `https://`). Every other part of the app already depends on that value,
so there's no separate address to configure, and none to get wrong. The existing Caddy
route to the SFU carries it unchanged. Media uses the SFU's UDP 7882, which is already
forwarded.

*Authorisation.* `POST /api/whip` returns the endpoint and a LiveKit token, and **only to
whoever holds the stage**. The token lives for five minutes and allows publishing only: no
subscribing, no data, no room administration. LiveKit checks it when the publisher joins,
so the short lifetime doesn't cut a broadcast off. ffmpeg sends it with `-authorization`,
as a Bearer header.

The old Ingress endpoint only checked for a session, so any paired device could publish
over WHIP whether it held the stage or not. The stage was a rule the in-app path obeyed and
the hardware path ignored.

*Identity.* The publisher joins as `<owner>-gpu`, because a second connection under the
owner's own identity would disconnect their app. The stage treats that participant as its
owner's. `holder()` names the person, and counts the publisher's tracks as proof they're
broadcasting.

Before this change a GPU broadcaster looked idle, since their own participant publishes
nothing while the GPU one carries the picture. Anyone could take the stage from them
mid-broadcast once the grace period passed. Releasing the stage, or having it taken,
removes the publisher, because its rights come from its token and revoking the owner alone
would leave it on air.

*Encoders.* Which one runs depends on the adapter the capture actually lands on:

| GPU | How |
|---|---|
| NVIDIA | NVENC inside the native addon. Zero-copy, and ffmpeg only muxes (`-c:v copy`) |
| AMD | The addon reads the frame back once; ffmpeg encodes with `h264_amf` |
| Intel | Same, with `h264_qsv` |
| Screen share | ffmpeg captures with `ddagrab`; the encoder is chosen by vendor |

When NVENC is present but declines, usually because of an old driver, the broadcast falls
back to the readback path instead of failing. The option is a checkbox in the share picker:
off by default, off after upgrades, disabled on a machine with no hardware encoder, and it
shows the encoder and card it found.

*Diagnostics.* Every run writes ffmpeg's command and full output to
`%APPDATA%\Zoia\ffmpeg.log`, with the token redacted. Every failure is reported to the
server with that redacted command, the GPU, the encoder chosen, and the last 200 lines of
output, including failures before ffmpeg starts. The server keeps 12k characters of that
context; it used to keep 1k, which cut off the cause.

## Measured before it was built

A test pattern was published from outside the server to `https://sfu.<domain>/whip/v1`
with a token minted in the running app. ICE completed in 171 ms and DTLS in 623 ms. It sent
240 frames of video and audio over 8 seconds, with no Ingress and no extra port. Two things
turned up along the way:

- **The WHIP muxer requires stereo audio.** It refuses mono with
  `Unsupported audio channels 1 by RTC`. The encoder passes `-ac 2` explicitly.
- **ffmpeg's teardown `DELETE` doesn't reliably reach the SFU**
  (`Failed to read response from DELETE`). The server removes the publisher itself when a
  broadcast stops, instead of waiting for LiveKit to time it out.

## Consequences

- **No new public surface, and one container fewer.** The Ingress, its config file and its
  port are gone. Signalling uses the SFU hostname that was already public, and media uses a
  port that was already forwarded. Redis stays, because `livekit.yaml` depends on it.
- **Publishing is gated by the stage**, for the first time on this path.
- **AMD and Intel pay one readback per frame.** It's the price of a GPU path where there
  was none. NVIDIA keeps zero-copy.
- **AMF and Quick Sync have not run on real hardware** as of this record. Their argument
  lists were tested end to end against the vendored ffmpeg with libx264 standing in, and
  the D3D11 download chain on a real GPU. That shows the plumbing works, not the encoders.
- **The lesson, written down so it outlasts this record's context:** four fixes landed
  before anyone looked at what the failing machine actually said. The diagnostics exist so
  the next failure explains itself.
