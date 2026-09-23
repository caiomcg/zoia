# Self-hosting Zoia

Everything needed to run your own server and hand out your own builds.

This is the generic guide. [RUNBOOK.md](RUNBOOK.md) is the author's own deployment written
down in full — a worked example on Proxmox, with the router and DNS quirks of one real
network. Read this one first; read that one when something here needs a concrete precedent.

## What you need

| | |
|---|---|
| A Linux host | 2 cores and 2 GB is enough. It forwards packets; it does not transcode. |
| Docker with Compose | `docker compose version` should print v2 or later. |
| A domain | On **Cloudflare**, because TLS uses the DNS-01 challenge. |
| A public IP | Static, or dynamic with something keeping DNS in step. |
| Control of the router | Three port forwards. Without them there is no media path. |
| Upload bandwidth | `viewers × MAX_BITRATE`. This is the real ceiling — see [Capacity](#capacity). |

A VM, a spare box and a VPS all work. A VPS costs bandwidth but removes the router work.

## 1. DNS

Zoia serves two hostnames: the app, and the SFU's signalling. Add two **A records**:

| Type | Name | Value | Proxy status |
|---|---|---|---|
| A | `zoia` | your public IP | **DNS only** |
| A | `sfu` | your public IP | **DNS only** |

> **Both must be DNS only — grey cloud, not orange.** Cloudflare defaults new records to
> Proxied. Proxying breaks Zoia twice over: Cloudflare's network does not carry WebRTC media
> (UDP) at all, and putting the signalling WebSocket through it buys latency and failure
> modes for nothing. `scripts/preflight.sh` checks this and fails loudly.

Confirm both resolve to your own address before continuing:

```bash
nslookup zoia.your-domain.com 1.1.1.1
nslookup sfu.your-domain.com  1.1.1.1
```

## 2. Ports

Three forwards, all to the host running Docker:

| Port | Proto | Why |
|---|---|---|
| **443** | TCP | Caddy — the app and LiveKit signalling, both over TLS |
| **7882** | UDP | WebRTC media. One rule covers every viewer |
| **7881** | TCP | Fallback for networks that block UDP |

**Do not forward 80.** Certificates come from a DNS-01 challenge, which needs no inbound
HTTP at all.

**Do not point an existing reverse proxy at this.** A proxy that routes by `Host` header is
a door to every service behind it; Zoia runs its own Caddy precisely so that door stays
shut. See [ADR 0004](adr/0004-isolated-caddy-front-end.md).

UDP 7882 is the one people forget. Without it viewers connect, negotiate, and then watch a
black rectangle forever — or quietly fall back to TCP and blame the app for the latency.

## 3. A Cloudflare API token

Caddy edits a DNS record to prove it owns the domain, so it needs a token.

**Cloudflare → My Profile → API Tokens → Create Token → Edit zone DNS**

- Permissions: `Zone` · `DNS` · `Edit`
- Zone Resources: `Include` · `Specific zone` · your zone

Scope it to the one zone. It can rewrite that zone's DNS, so treat it as a real secret: it
belongs in `.env` on the server and nowhere else.

## 4. Configure and start

```bash
git clone https://github.com/caiomcg/zoia.git
cd zoia
```

Generate `.env` rather than writing it by hand:

```bash
./scripts/gen-env.sh zoia.your-domain.com sfu.your-domain.com > .env
chmod 600 .env
```

The generator exists for one reason: the LiveKit credentials appear in three variables that
must agree — `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_KEYS` as `"key: secret"`.
Out of step, they fail at connect time with no useful error.

Then add your Cloudflare token to `.env` and bring it up:

```bash
docker compose up -d
```

Verify, rather than assuming:

```bash
bash scripts/preflight.sh
```

Preflight checks the things that look like app bugs but are not: proxied DNS records, a
missing UDP forward, certificates that never issued, containers that are up but unhealthy.

### Worth setting before you hand out builds

| Variable | Default | |
|---|---|---|
| `MAX_BITRATE` | `20000000` | **Lower this until it fits your upload.** See below. |
| `MAX_FRAMERATE` | `60` | 30 halves the bitrate need for most content. |
| `CAPTURE_WIDTH` / `_HEIGHT` | `3840` / `2160` | Drop to `1920`/`1080` on a thin link. |
| `VIDEO_CODEC` | `vp9` | `vp9` compresses screen content best; `h264` is cheaper to encode. |
| `ROOM_NAME` | `zoia` | One room per server. |

### Capacity

The server sends one copy of the stream per viewer, so **upload is the binding constraint**:

| Viewers | @ 2.5 Mbps | @ 8 Mbps | @ 20 Mbps |
|---|---|---|---|
| 3 | 7.5 Mbps | 24 Mbps | 60 Mbps |
| 5 | 12.5 Mbps | 40 Mbps | 100 Mbps |
| 10 | 25 Mbps | 80 Mbps | 200 Mbps |

CPU is not the limit — an SFU forwards packets without decoding them. If the numbers do not
fit your link, lower `MAX_BITRATE` first, then `MAX_FRAMERATE`, then resolution.

## 5. Mint a pairing token

Nobody can use the server until a build carries a token. Tokens are what you revoke later,
so mint one per group rather than one for everyone:

```bash
docker compose exec app node server/bin/keytool.js \
  pair:new --name "friends" --max-activations 5
```

It prints the token **once**. `--max-activations` caps how many machines it can ever
activate, which bounds the damage if it leaks.

## 6. Build an .exe that carries it

On a **Windows** machine with Node and Visual Studio Build Tools — not WSL, because the
audio addon is native and a WSL install puts Linux binaries in `node_modules`:

```
cd desktop
npm install
make-exe.bat
```

It asks for the pairing token on first run, saves it to a gitignored `.pairing-token`, and
refuses to report success if the token did not make it into the binary. The result lands in
`desktop/release/`.

Hand that one file to people. There is nothing to configure on their side: the server
address and the pairing token travel inside it. [DISTRIBUTING.md](DISTRIBUTING.md) covers
what SmartScreen will say and how to revoke a build that gets away from you.

## Two kill switches

Access is per device, and the two levers are independent:

```bash
# Stop new machines activating. Everyone already paired keeps working.
node server/bin/keytool.js pair:list
node server/bin/keytool.js pair:revoke <id>

# Cut off one machine. Nobody else notices.
node server/bin/keytool.js device:list
node server/bin/keytool.js device:revoke <id>
```

Both take effect on the next request, not the next login: the session cookie holds an id
that is re-resolved against the store every time. See [ADR 0007](adr/0007-device-pairing.md).

`device:list` shows a `lastSeen` per machine, which is how you tell a device somebody
stopped using from one that is simply idle right now.

## Optional: hardware encoding

Off by default. It needs an NVIDIA GPU on the broadcaster's machine and a broadcaster on the
same network as the server, and it is the one path where those constraints are load-bearing.
[ADR 0009](adr/0009-hardware-encoding.md) explains what it does and why it is gated.

To enable it server-side, set `WHIP_BASE_URL` in `.env` to the ingress endpoint reachable
from the broadcasting machine:

```
WHIP_BASE_URL=http://<your-server-lan-ip>:8085/w
```

Deliberately **not** internet-exposed: WHIP ingress is plain HTTP here, and the broadcaster
is assumed to be on the same LAN. Remote broadcasters use the ordinary in-app path, which
needs no configuration.

## Keeping it running

Day-to-day operation — deploying changes, backing up the stores, reading crash reports, and
a long list of symptoms with their real causes — is in [RUNBOOK.md](RUNBOOK.md).

The one backup that matters:

```bash
# On the server. These are the access records; the rest is reproducible from git.
tar czf zoia-data-$(date +%F).tar.gz -C /opt/zoia server/data
```
