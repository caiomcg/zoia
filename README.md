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

- **Share a window, a screen, or a camera.** One person at a time, with the stage handed
  around rather than fought over.
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
                                                   │  one stream in,
                                                   ▼  many out
                                            viewers (the same app)
```

One person uploads a single stream; the SFU fans it out. A mesh would make the broadcaster
upload once per viewer, which a home connection cannot do past two or three people. The
ceiling moves to the server's upstream bandwidth — roughly `viewers × 2.5 Mbps` — and that,
not CPU, is what limits the room.

Longer version, including why the browser client was retired and what the hardware
encoding path does: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

Zoia is **Windows x64 only**, and unsigned — SmartScreen will warn on first run.

1. Download the portable `.exe` from [Releases](https://github.com/caiomcg/zoia/releases),
   or build it yourself (below).
2. Run it. It pairs itself on first launch using a token baked into the build.
3. Share something.

There is nothing to install on a viewer's machine beyond the same app, and nothing to
configure: the server address and pairing token travel inside the binary.

## Run your own

You need a Linux box that can reach the internet, a domain, and Docker.

```bash
git clone https://github.com/caiomcg/zoia.git
cd zoia
cp .env.example .env        # fill in the secrets
docker compose up -d
```

Then mint a pairing token and build an installer that carries it:

```bash
node server/bin/keytool.js pair:new --name "friends" --max-activations 5
cd desktop && ./make-exe.bat        # on Windows
```

Full walkthrough, including DNS, TLS and the router ports that actually matter:
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md). Day-to-day operations — revoking access,
reading crash reports, upgrading — are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Distributing builds

`desktop/make-exe.bat` produces a portable `.exe` with your pairing token embedded, and
refuses to report success if the token did not make it in. See
[docs/DISTRIBUTING.md](docs/DISTRIBUTING.md) for what to hand people, what SmartScreen will
say, and how to revoke a build that escapes.

## Known limits

Stated plainly, because finding these out later is worse:

- **Windows x64 only.** The audio capture is WASAPI process loopback; there is no
  equivalent on macOS or Linux, and no browser client any more.
- **Encoding runs on the CPU.** A hardware path exists — Windows Graphics Capture into
  NVENC, published over WHIP — and it works, but it needs an NVIDIA GPU and is switched off
  behind a flag while it settles. See
  [docs/adr/0009-hardware-encoding.md](docs/adr/0009-hardware-encoding.md).
- **One room, one broadcaster.** This is built for a handful of friends, not a platform.
- **Unsigned binaries.** Code signing costs money this project does not have.

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
