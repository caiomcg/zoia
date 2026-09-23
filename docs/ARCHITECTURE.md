# Architecture

## The shape of it

```
  HOST PC (Chrome/Edge)                 PROXMOX  (Ryzen 5 3500U)
┌────────────────────┐          ┌──────────────────────────────────────┐
│ getDisplayMedia()  │          │   zoia-vm  <server-ip>             │
│   screen + audio   │          │  ┌────────────────────────────────┐  │
└─────────┬──────────┘          │  │ caddy  :443                    │  │
          │  HTTPS/WSS :443 ────┼─►│   zoia.example.com → app    │  │
          │  (page + signalling)│  │   sfu.example.com  → livekit│  │
          │                     │  │   certs: Cloudflare DNS-01      │  │
          │                     │  └───────┬─────────────┬──────────┘  │
          │                     │          ▼             ▼             │
          │                     │      app :3000    livekit :7880      │
          │  UDP :7882 ─────────┼──────────────────►    :7881 :7882    │
  VIEWERS │  (media, direct)    │                                      │
   ×15 ◄──┴─────────────────────┼──────────────────────────────────────┤
                                │   NOT EXPOSED — LAN/VPN only:        │
                                │   NPM .4 · your local DNS .3 · everything   │
                                └──────────────────────────────────────┘
```

Caddy on the VM is the entire public surface. an existing reverse proxy, which serves every other
service on this network, stays unreachable from the internet exactly as it was before this
project existed — see [ADR 0004](adr/0004-isolated-caddy-front-end.md).

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

All three forwards target the VM at `<server-ip>`.

| Port | Proto | Exposed to internet | Purpose |
|---|---|---|---|
| 443 | TCP | yes | Caddy: web app + LiveKit signalling over TLS |
| 7882 | UDP | yes | WebRTC media — single-port mux |
| 7881 | TCP | yes | WebRTC-over-TCP fallback |
| 80 | TCP | **no** | Caddy LAN redirect only; DNS-01 needs no inbound HTTP |
| 3000 | TCP | no | Node app — no host port at all, reached only via Caddy |
| 7880 | TCP | no | LiveKit signalling, reached only via Caddy |

## Capacity

Upstream bandwidth is the binding constraint: `viewers × bitrate`.

| Viewers | @ 2.5 Mbps | @ 4 Mbps |
|---|---|---|
| 5 | 12.5 Mbps | 20 Mbps |
| 10 | 25 Mbps | 40 Mbps |
| 15 | 37.5 Mbps | 60 Mbps |

If the link is tighter than ~40 Mbps up, enable simulcast so LiveKit can serve lower layers
to some viewers rather than degrading the stream for everyone.
