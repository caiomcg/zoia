<div align="center">

<img src="server/public/logo.png" alt="Zoia" width="360" />

**Share a screen, a window or a camera with a few friends — and the sound of just that app.**

[![CI](https://github.com/caiomcg/zoia/actions/workflows/ci.yml/badge.svg)](https://github.com/caiomcg/zoia/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-95%25-brightgreen)](scripts/coverage-check.js)
[![licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)](#install)

</div>

---

Zoia is a small, self-hosted alternative to screen sharing on a chat platform. You run the
server; nobody else is in the path. There are no accounts, no meeting links, and no company
deciding what your stream is worth.

It exists because of one thing browsers cannot do: **send the audio of a single
application**. A web page gets the tab it is in, or your whole desktop mix — never "this
game, and nothing else". Zoia captures a chosen process with WASAPI loopback, so your
notifications, your music and your other calls stay out of the stream.

## What it does

- **Share a window, a screen, or a camera.** Multiple people can share at once, and each
  viewer chooses which broadcasts to watch.
- **Send that application's audio, and only that.** Sharing a whole screen is silent on
  purpose — the only audio a screen has is everything at once.
- **Ask for the stage.** Whoever is sharing can hand over or say no. If they have wandered
  off, you can take it after thirty seconds.
- **Switch what you share** without stopping, so the picture never drops for viewers.
- **Preview a camera first**, with device pickers and a level meter, before anything is
  published.
- **Per-device access, with two kill switches.** Revoke a pairing token to stop new
  machines; revoke a single device to cut off one.

## How it works

```
  Windows desktop app                         your server
 ┌──────────────────────┐                ┌────────────────────────┐
 │  window / screen     │   WebRTC       │  Caddy  (TLS)          │
 │  camera              │ ─────────────► │    ├── app   (Node)    │ ── pairing, tokens,
 │  app audio (WASAPI)  │                │    └── LiveKit (SFU)   │    the stage
 └──────────────────────┘                └────────────────────────┘
                                                   │  many streams in,
                                                   ▼  selected streams out
                                            viewers (desktop app or browser)
```

Each broadcaster uploads one stream; the SFU fans each stream out. A mesh would make every
broadcaster upload once per viewer, which a home connection cannot do past two or three people.
The ceiling moves to the server's upstream bandwidth — roughly `streams × viewers × 2.5 Mbps` — and that,
not CPU, is what limits the room.

Longer version, including the browser viewer and what the hardware
encoding path does: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

Zoia is **Windows x64 only**, and unsigned — SmartScreen will warn on first run.

1. Download the portable `.exe` from [Releases](https://github.com/caiomcg/zoia/releases),
   or build it yourself (below).
2. Get a `zoia-invite.json` from whoever runs the server you are joining.
3. Put it next to the exe — or drag it onto the window — and run it.
4. Share something.

The download itself carries no server and no credentials, so it is the same file for
everybody and safe to link publicly. The invite is the part that grants access, and the part
to send privately.

### Watching without installing the app

Friends who only want to watch can open the invite in a supported browser and use the
viewer page. They can select one or more people in the **Ao vivo** list, use **Assistir todas**
or **Parar todas**, and choose which stream supplies audio. The viewer also shows each
source's identity, such as `Janela: Chrome — YouTube`, and offers low-quality, focus and
audio-only modes for slower connections.

The desktop app is still required for broadcasting, because capturing a window or an
application's audio uses native Windows APIs.

## Run your own

You need a Linux box that can reach the internet, a domain, and Docker.

```bash
git clone https://github.com/caiomcg/zoia.git
cd zoia
cp .env.example .env        # fill in the secrets
docker compose up -d
```

Then mint an invite and send it to whoever is joining:

```bash
node server/bin/keytool.js pair:new --name "friends" --max-activations 5 \
  --invite zoia-invite.json
```

They pair with that plus a release binary; there is nothing to build unless you want to.

Full walkthrough, including DNS, TLS and the router ports that actually matter:
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md). Day-to-day operations — revoking access,
reading crash reports, upgrading — are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Hardware encoding (WHIP)

By default the app encodes on the CPU, inside Chromium's WebRTC stack. That works
everywhere, but Chromium has **no hardware video encoder on Windows** (measured, not
assumed; see [ADR 0009](docs/adr/0009-hardware-encoding.md)). So a 4K share taxes the CPU
while the GPU sits idle.

Tick **Hardware acceleration** in the share picker and the app skips Chromium altogether.
It encodes on the GPU, then ffmpeg publishes the stream over **WHIP**, the WebRTC-HTTP
Ingestion Protocol. WHIP is plain WebRTC with a simple HTTP handshake, and LiveKit's SFU
accepts it natively, so the stream goes straight into the room. Viewers notice no
difference.

```
 broadcaster                                  your server
┌─────────────────────────┐  HTTPS (WHIP)   ┌───────────────────────────────┐
│ window capture (WGC)    │ ──────────────► │ Caddy  sfu.<domain>/whip/v1   │
│ GPU encoder             │                 │   └─► LiveKit SFU  :7880      │
│   NVENC / AMF / QSV     │  UDP (media)    │                               │
│ ffmpeg ──── WHIP ─────► │ ──────────────► │ LiveKit SFU  :7882 ─► room    │
└─────────────────────────┘                 └───────────────────────────────┘
```

**Same ports as the in-app path.** WHIP negotiates over the SFU's existing HTTPS host and
sends media over the same UDP 7882 that every viewer already uses. There's no extra
forward, no extra service, and no address to configure: the server works out the endpoint
from `LIVEKIT_WS_URL` (`wss://sfu.example.com` → `https://sfu.example.com/whip/v1`).

| GPU | Encoder | Path |
|---|---|---|
| NVIDIA | NVENC | Encoded inside the app. Frames never leave the GPU |
| AMD | AMF (`h264_amf`) | Frame read back once, then encoded by ffmpeg on the GPU |
| Intel | Quick Sync (`h264_qsv`) | Same as AMD |

The picker shows which encoder and card it found. The option is off by default, and it
disables itself on a machine with no hardware encoder.

### How publishing is authorised

1. The broadcaster claims their broadcast slot, the same as any share.
2. The app asks `POST /api/whip`. The server replies **only to the participant who owns that slot**,
   with the endpoint and a five-minute, publish-only LiveKit token.
3. ffmpeg sends that token as a Bearer header. The SFU checks it and admits the stream as a
   participant named `<owner>-gpu`, which the stage and every viewer attribute to its
   owner.
4. When the broadcast stops, or the stage is released or taken, the server removes that
   participant.

The token is only ever held by the app's main process. It's redacted from logs and crash
reports.

### When it fails

A failed hardware broadcast documents itself:

- **On the server.** Every failure is reported with the reason, the exact (redacted)
  ffmpeg command, the GPU and encoder, and ffmpeg's own output:
  ```bash
  docker compose logs app | grep -A40 '\[report\]'
  ```
- **On the broadcaster's machine.** `%APPDATA%\Zoia\ffmpeg.log` holds the command and
  everything ffmpeg printed during the last run.

Ignore `Conversion failed!`: it's ffmpeg's generic last line, and the cause is printed
just above it. The [runbook](docs/RUNBOOK.md#hardware-encoding-fails-for-somebody) maps
the common messages to their causes.

## Distributing builds

Pushing a version tag builds the Windows binaries in CI and attaches them to a GitHub
Release with checksums. `desktop/make-exe.bat` still produces a private build with a token
baked in, for when you would rather hand over one file than two. See
[docs/DISTRIBUTING.md](docs/DISTRIBUTING.md) for both paths, what SmartScreen will say, and
how to revoke an invite that escapes.

## Known limits

Stated plainly, because finding these out later is worse:

- **Windows x64 for broadcasting.** The audio capture is WASAPI process loopback; there is no
  equivalent on macOS or Linux. Browser viewing is available on supported desktop and mobile
  browsers, but browsers cannot broadcast a single application's audio.
- **Hardware encoding is opt-in and newer than the rest.** It covers NVIDIA, AMD and
  Intel GPUs, but only NVIDIA has been confirmed on real hardware. See
  [above](#hardware-encoding-whip).
- **One room, many broadcasters.** Each participant can publish one stream; viewers can
  subscribe to one or more streams. This is built for a handful of friends, not a platform.
- **One audio stream at a time for viewers.** Multiple videos can be visible together, but only
  one stream is audible by default; each viewer can activate another stream and adjust volume.
- **Unsigned binaries.** Code signing costs money this project does not have.

## Documentation

| | |
|---|---|
| [Self-hosting](docs/SELF_HOSTING.md) | Run your own server, start to finish |
| [Distributing](docs/DISTRIBUTING.md) | Build an `.exe`, hand it out, revoke it |
| [Architecture](docs/ARCHITECTURE.md) | How the pieces fit, and the audio path in detail |
| [Runbook](docs/RUNBOOK.md) | Day-to-day operation, and a long list of symptoms with their real causes |
| [Security](docs/SECURITY.md) | What this protects against, and what it does not |
| [Decision records](docs/adr/README.md) | Why it is built this way, including what was tried and abandoned |

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the
development setup, the conventions the repository enforces in CI, and the one rule worth
knowing up front: changes to how permissions are granted need a test proving they cannot be
widened.

## Support

If Zoia is useful to you, the Sponsor button at the top of the repository is the way to say
so. It is a hobby project, and it will stay free either way.

## Licence

[MIT](LICENSE).
