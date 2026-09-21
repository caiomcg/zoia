# Architecture

## The shape of it

```
  HOST PC (Chrome/Edge)                 PROXMOX  (Ryzen 5 3500U)
┌────────────────────┐          ┌──────────────────────────────────────┐
│ getDisplayMedia()  │          │  ┌────────────────────────────────┐  │
│   screen + audio   │          │  │ Nginx Proxy Manager (existing) │  │
└─────────┬──────────┘          │  │   zoia.<domain> → app:3000     │  │
          │                     │  │   sfu.<domain>  → livekit:7880 │  │
          │  WSS :443 ──────────┼─►│   wildcard cert, Cloudflare DNS│  │
          │  (signalling)       │  └────────────┬───────────────────┘  │
          │                     │               │                      │
          │  UDP :7882 ─────────┼───────────────┼──► ┌──────────────┐  │
          │  (media, direct)    │               └───►│ zoia-vm      │  │
          │                     │                    │ 4 vCPU / 6GB │  │
  VIEWERS ×15                   │                    │              │  │
┌────────────────────┐          │                    │ node app:3000│  │
│ <video> + audio    │◄─────────┼── UDP :7882 ──────►│ livekit :7880│  │
└────────────────────┘          │                    │        :7881 │  │
                                │                    │        :7882 │  │
                                └────────────────────┴──────────────┘  │
```

Signalling rides the existing 443 through NPM. **Media does not touch NPM** — nginx cannot
proxy WebRTC, so UDP 7882 goes straight to the VM.

## Request flow

1. A person opens `https://zoia.<domain>/?k=<key>`.
2. The app splits the key into a `keyId` and a secret, looks up the record by id, verifies
   the secret against the stored scrypt hash, and issues a **signed session cookie holding
   only the `keyId`** — never the secret.
3. It redirects to `/` with a 302, so the key leaves the URL bar, history and referrer.
4. On every subsequent request the `keyId` is re-resolved against the key store. A revoked
   or expired record is rejected immediately.
5. The page requests `POST /api/token`. The app mints a LiveKit JWT whose grant sets
   `canPublish` from the person's role, and returns it with the SFU's WebSocket URL.
6. The browser connects to `wss://sfu.<domain>`, authenticates with the JWT, and either
   publishes (host) or subscribes (viewer).

## Why these choices

**An SFU, not a mesh or a relay.** A mesh makes the host upload once per viewer, which a
residential connection cannot sustain past a handful. A full MCU would transcode and burn
CPU the 3500U doesn't have. An SFU forwards packets untouched: one upload in, N forwards
out, negligible CPU.

**Tokens carry the authorization, not the client.** LiveKit validates the grant server-side
on every publish attempt, so a viewer editing JavaScript in the console achieves nothing.
This is why `canPublish` is computed in `server/src/token.js` from the stored role and never
from anything the client sends.

**No database.** The key store is a JSON file of at most a few dozen records, read and
written under a mutex. Postgres for fifteen invite keys would be more moving parts to back
up, not more safety.

**No build step in the browser code.** Plain ESM served statically. The client is a few
hundred lines; a bundler would add a failure mode and a toolchain for no gain.

## Port map

| Port | Proto | Exposed to internet | Purpose |
|---|---|---|---|
| 443 | TCP | yes (existing NPM) | Web app + LiveKit signalling over TLS |
| 7882 | UDP | yes (new forward) | WebRTC media — single-port mux |
| 7881 | TCP | yes (new forward) | WebRTC-over-TCP fallback |
| 3000 | TCP | no | Node app, reached only via NPM |
| 7880 | TCP | no | LiveKit signalling, reached only via NPM |

## Capacity

Upstream bandwidth is the binding constraint: `viewers × bitrate`.

| Viewers | @ 2.5 Mbps | @ 4 Mbps |
|---|---|---|
| 5 | 12.5 Mbps | 20 Mbps |
| 10 | 25 Mbps | 40 Mbps |
| 15 | 37.5 Mbps | 60 Mbps |

If the link is tighter than ~40 Mbps up, enable simulcast so LiveKit can serve lower layers
to some viewers rather than degrading the stream for everyone.
