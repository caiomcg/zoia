---
name: zoia-self-host
description: Guide someone through running their own Zoia server — DNS, port forwards, .env, docker compose, the super admin, and verifying with preflight — and diagnose a server that is up but not working. Use when asked to deploy, host, install or set up a Zoia server, or when viewers see black video or cannot connect.
---

# Running your own Zoia server

[docs/SELF_HOSTING.md](../../../docs/SELF_HOSTING.md) is the full guide; this skill is the
order to do it in and how to check each step. Go one stage at a time: run the check, show the
result, and move on only when it passes. Most of what goes wrong here looks like an app bug and
is not one.

## Rules

- **Never print `.env` or any secret** (Cloudflare token, `SESSION_SECRET`, LiveKit secret).
  To check a variable is set, test it without echoing: `grep -c '^CLOUDFLARE_API_TOKEN=.\+' .env`.
- **Never delete or overwrite `server/data/`.** It holds every account; losing it locks
  everyone out. Back it up before any upgrade.
- **Don't route Zoia through an existing reverse proxy** (Nginx Proxy Manager, Traefik…).
  It runs its own Caddy on purpose (ADR 0004).
- Ask before anything that changes the person's router, DNS or firewall; you can't see those,
  and they know their network.

## Stage 0: what they have

Confirm, and stop to discuss if any is missing:

| Need | Check |
|---|---|
| A Linux host with Docker Compose v2 | `docker compose version` |
| A domain on **Cloudflare** (TLS uses DNS-01) | ask |
| A public IP, static or kept in step by DDNS | `curl -s https://api.ipify.org` on the host |
| Control of the router (three forwards) | ask |
| Upload bandwidth ≈ viewers × `MAX_BITRATE` | ask; see the capacity table in the guide |

## Stage 1: DNS

Two A records, `zoia` and `sfu`, to the public IP, both **DNS only (grey cloud)**. Cloudflare
defaults to Proxied, and a proxied record carries no WebRTC.

Check: `nslookup zoia.<domain> 1.1.1.1` and the same for `sfu` both return **their** IP, not a
Cloudflare one (104.x / 172.6x).

## Stage 2: ports

Forward to the Docker host: **TCP 443**, **UDP 7882**, **TCP 7881**. Not 80.
UDP 7882 is the one people forget: without it viewers connect and see black forever.
These can only be fully confirmed from outside, which preflight does in stage 5.

## Stage 3: Cloudflare token

My Profile › API Tokens › Create Token › *Edit zone DNS*, scoped to the one zone. They paste it
into `.env` themselves in the next stage.

## Stage 4: configure and start

```bash
git clone https://github.com/caiomcg/zoia.git && cd zoia
./scripts/gen-env.sh zoia.<domain> sfu.<domain> > .env
chmod 600 .env
# they add CLOUDFLARE_API_TOKEN to .env
docker compose up -d
```

Always generate `.env` rather than writing it: the three LiveKit variables must agree, and out
of step they fail at connect time with no useful error. Before handing out builds, go through
"Worth setting" in the guide with them, `MAX_BITRATE` first.

Check: `docker compose ps`: every service running, `app` healthy. ScyllaDB takes about a minute;
chat says it is unavailable until then, and that is expected.

## Stage 5: verify

```bash
bash scripts/preflight.sh
```

It checks the environment, containers, local endpoints, external IP discovery and DNS, and exits
non-zero on a hard failure. Read every `[FAIL]` and `[warn]` back to them with its fix; don't
summarise it as "mostly fine".

## Stage 6: the super admin and people

They install the desktop app from the Releases page, enter `https://zoia.<domain>`, and create an
account. Then on the server:

```bash
docker compose exec app node server/bin/keytool.js account:super <their email>
```

From then on they approve people in the app (Settings › Accounts). The email is not verified,
so approval is the check.

## When it's up but broken

| Symptom | Usual cause |
|---|---|
| Viewers join, see black video forever | `rtc.use_external_ip` not `true` in `livekit.yaml` (most common), UDP 7882 not forwarded, or a record orange-clouded |
| Certificate never issues | Cloudflare token missing, wrong, or not scoped to the zone: `docker compose logs caddy` |
| Works outside, not from the LAN | Router doesn't hairpin: a local DNS override, not code |
| High latency, choppy | Fell back to TCP 7881 (UDP blocked), or upload too small for `MAX_BITRATE` |
| Chat unavailable | ScyllaDB still starting, or down: `docker compose logs scylla` |

More symptoms and their real causes: [docs/RUNBOOK.md](../../../docs/RUNBOOK.md). App logs:
`docker compose logs app`.

## Keeping it running

Back up `server/data` (`tar czf zoia-data-$(date +%F).tar.gz -C <deploy dir> server/data`) and
the ScyllaDB volume per the runbook. Upgrades: `git pull && docker compose up -d --build`, after
the backup (`docker compose up -d --build` is what `deploy.sh` runs on the VM).
