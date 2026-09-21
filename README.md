# Zoia

Private one-to-many screen broadcast. One person shares a screen, window or browser tab —
with audio — and everyone you've invited watches it live in their browser at roughly
200–500 ms latency. Self-hosted, no accounts, no third-party service in the path.

```
host browser ──┐                                    ┌──► viewer
  screen+audio │   Nginx Proxy Manager (TLS)        │
               ├──►  zoia.<domain>  → node app      ├──► viewer
               │     sfu.<domain>   → livekit SFU   │
               └──►  UDP 7882 ──► livekit (media) ──┴──► viewer
```

## Why an SFU

The host uploads **one** stream regardless of audience size; the SFU fans it out. A mesh
would make the host upload once per viewer, which a home connection cannot do past two or
three people. The cost moves to the server's upstream bandwidth: roughly
`viewers × 2.5 Mbps`, so 15 viewers needs ~37 Mbps up. That, not CPU, is the ceiling.

## Quick start (local development)

```bash
cp .env.example .env          # then fill in the secrets
npm install
npm run keytool -- add --name "Me" --role host
npm run dev
```

Open the printed URL. For local development over plain HTTP, use `http://localhost:3000` —
browsers treat localhost as a secure context, so screen capture works. On any other
hostname **HTTPS is mandatory**; `getDisplayMedia()` does not exist without it.

You will also need a LiveKit server. For local work:

```bash
docker run --rm -p 7880:7880 -e LIVEKIT_KEYS="devkey: secret" livekit/livekit-server --dev
```

## Inviting people

```bash
npm run keytool -- add --name "Alice" --role viewer
```

This prints a one-time URL of the form `https://zoia.<domain>/?k=<key>`. Send it to Alice;
she opens it once and a cookie carries her afterwards. The key is stored hashed — this is
the only time it is ever displayed.

To cut someone off: `npm run keytool -- revoke <keyId>`. It takes effect on their next
request, not whenever their cookie happens to expire.

Exactly one person should hold a `host` key. Viewers are issued tokens that LiveKit will
not accept a publish from, so the single-producer rule is enforced server-side rather than
by everyone behaving.

## Hosting a broadcast

1. Open the URL in **Chrome or Edge on desktop** — they are the only browsers that can
   capture system or tab audio. Viewers can use anything.
2. Click **Start broadcast**, pick a screen, window or tab.
3. To share audio, tick "Share tab audio" / "Share system audio" in the picker. That box
   only appears for a tab or a whole screen, never a single window.

Viewers click **Join** and see the stream. The click is required — browsers block
autoplaying audio without a user gesture.

## Documentation

- [AGENTS.md](./AGENTS.md) — conventions and invariants for contributors
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — how the pieces fit, and why
- [docs/SECURITY.md](./docs/SECURITY.md) — threat model and key lifecycle
- [docs/RUNBOOK.md](./docs/RUNBOOK.md) — deploy, operate, debug
- [docs/adr/](./docs/adr/) — decision records
