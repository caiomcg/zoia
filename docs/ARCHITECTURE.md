# Architecture

## The shape of it

```
  BROADCASTER (Windows desktop app)             YOUR SERVER
┌────────────────────────────────┐        ┌──────────────────────────────┐
│  MAIN process                  │        │  caddy :443                  │
│   ├ desktopCapturer → sources  │        │    zoia.<domain>  → app      │
│   ├ node-window-manager → PID  │        │    sfu.<domain>   → livekit  │
│   ├ WASAPI loopback → PCM      │        │    certs: Cloudflare DNS-01  │
│   └ safeStorage → credential   │        └───────┬──────────────┬───────┘
│                                │                ▼              ▼
│  RENDERER                      │            app :3000     livekit :7880
│   ├ AudioWorklet → track       │   WSS :443     │               │
│   ├ livekit-client → publish   │ ───────────────┘               │
│   └ player                     │   UDP :7882 (media, direct)    │
└────────────────────────────────┘ ──────────────────────────────►│
                                                                   │
  VIEWERS (the same app) ◄─────────────────────────────────────────┘
```

Caddy is the entire public surface, and it serves exactly two hostnames. Anything else gets
a refused connection rather than reaching a service — see
[ADR 0004](adr/0004-isolated-caddy-front-end.md).

The server does not transcode. One stream arrives, N copies leave, and the CPU cost is
forwarding packets rather than touching pixels.

## Why there is a desktop app at all

A browser cannot send the audio of a single application. Not "does not yet" — there is no
API for it, deliberately, because it would let any page listen to everything you play. That
single limitation is why this is an Electron app calling WASAPI process loopback rather than
a web page. [ADR 0006](adr/0006-native-desktop-client.md) has the full reasoning;
[ADR 0008](adr/0008-retire-the-browser-client.md) covers why the browser client was retired
rather than kept as a viewer-only fallback.

## The audio path

This is the load-bearing piece, and the reason the app exists.

```
WASAPI process loopback          main process      S16LE 48kHz stereo
  (one PID, no mixing)     ──►   src/main/audio.ts        │
                                                          │ IPC
                                                          ▼
  MediaStreamTrack  ◄──  AudioWorklet ring buffer  ◄── renderer
   (published)            public/pcm-worklet.js
```

Two properties are deliberate and were settled by measurement:

- **The `AudioContext` is pinned to 48 kHz**, matching WASAPI's fixed rate. Letting it
  default to the device rate inserts a resampler, and a resampler is a drift source.
- **Underrun and overrun are handled in the worklet**, which is the only place that knows,
  sample by sample, whether data arrived in time. A priming cushion covers startup jitter; a
  hard latency ceiling drops the oldest frames so the A/V offset stays bounded instead of
  growing all session. Both are counted and shown in the UI.

Sharing a **screen** sends no audio, on purpose. A screen has no owning process, so the only
audio it could carry is the whole system mix — every notification and every other app —
which is exactly what this design exists to avoid. Windows carry their process's audio;
cameras carry a chosen microphone.

## The hardware encoding path

A second, optional path encodes on the GPU and never touches Chromium's WebRTC encoder,
which has no hardware encoder on Windows:

```
Windows Graphics Capture ─► D3D11 ─► NVENC ─► ffmpeg ─► WHIP ─► LiveKit Ingress ─► the room
```

It is **off by default**, needs an NVIDIA GPU, and expects the broadcaster on the same LAN
as the server. [ADR 0009](adr/0009-hardware-encoding.md) covers what it does, what was tried
first, and why it is gated.

## Request flow

1. **First run.** The app POSTs its embedded pairing token to `/api/pair` and receives a
   device credential, stored with Electron `safeStorage` (DPAPI on Windows).
2. **Every run.** It POSTs that credential to `/api/device/session` and receives a **signed
   session cookie holding `device:<id>` and no secret**.
3. On every subsequent request the id is re-resolved against the device store. A revoked
   record is rejected immediately, not when the cookie expires.
4. `POST /api/token` mints a LiveKit JWT. Everyone joins **subscribe-only** —
   `canPublish: false` — regardless of any stored role.
5. To broadcast, the client calls `POST /api/stage/claim`. The server raises that
   participant's permission with `updateParticipant` only if nobody else already holds it.
6. The client connects to `wss://sfu.<domain>`, authenticates with the JWT, and publishes or
   subscribes.

Pairing and revocation: [ADR 0007](adr/0007-device-pairing.md). The stage:
[ADR 0005](adr/0005-one-tier-claimable-stage.md).

## Why these choices

**An SFU, not a mesh or an MCU.** A mesh makes the broadcaster upload once per viewer, which
a residential connection cannot sustain past two or three people. An MCU would transcode and
burn CPU the server does not have. An SFU forwards packets untouched: one upload in, N
forwards out.

**Tokens carry the authorization, not the client.** LiveKit validates the grant server-side
on every publish attempt, so a client editing its own JavaScript achieves nothing.
`canPublish` is computed in `server/src/token.js` from server state and never from anything
the client sends.

**Stage state is derived, not stored.** "Who is broadcasting" is read from LiveKit's
participant list rather than kept in a variable. A variable is wrong the moment a
broadcaster's laptop closes — the stage stays locked and nobody can present. A participant
who has gone is simply not in the list, so the failure mode disappears rather than being
handled.

**No database.** The stores are JSON files of a few dozen records, read and written under a
mutex with write-then-rename. Postgres for fifteen invite records would be more to back up,
not more safety.

**Revocation is re-checked per request.** Trusting a valid cookie until it expires would mean
`device:revoke` does nothing for up to a month. That is not a revocation.

## Port map

| Port | Proto | Exposed | Purpose |
|---|---|---|---|
| 443 | TCP | yes | Caddy: app + LiveKit signalling over TLS |
| 7882 | UDP | yes | WebRTC media — single-port mux |
| 7881 | TCP | yes | WebRTC-over-TCP fallback |
| 80 | TCP | **no** | LAN redirect only; DNS-01 needs no inbound HTTP |
| 3000 | TCP | no | Node app — no host port, reached only via Caddy |
| 7880 | TCP | no | LiveKit signalling, reached only via Caddy |
| 8085 | TCP | **no** | WHIP ingress — plain HTTP, LAN only |
| 6379 | TCP | no | Redis, for ingress↔SFU coordination |

## Capacity

Upstream bandwidth is the binding constraint: `viewers × bitrate`.

| Viewers | @ 2.5 Mbps | @ 8 Mbps | @ 20 Mbps |
|---|---|---|---|
| 5 | 12.5 Mbps | 40 Mbps | 100 Mbps |
| 10 | 25 Mbps | 80 Mbps | 200 Mbps |
| 15 | 37.5 Mbps | 120 Mbps | 300 Mbps |

If the link is tighter than the numbers allow, lower `MAX_BITRATE` before anything else.
Simulcast is the alternative: it lets LiveKit serve lower layers to some viewers rather than
degrading the stream for everyone.

## Repository layout

```
zoia/
├── server/          Node + Express: pairing, tokens, the stage, crash reports
│   ├── src/         app.js · token.js · stage.js · devices.js · pairings.js · keys.js
│   ├── bin/         keytool.js — mint and revoke
│   └── public/      the static landing page (no client JavaScript)
├── desktop/         Electron + React, Windows x64
│   ├── src/main/    sources · audio (WASAPI) · nvenc · capture · pairing
│   ├── src/renderer/  the UI, the player, the LiveKit hooks
│   └── native/      C++ addon: Windows Graphics Capture + NVENC
└── docs/            this, the runbook, self-hosting, and the ADRs
```
