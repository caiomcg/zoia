# 3. Reuse Nginx Proxy Manager as the front door

- **Status:** accepted
- **Date:** 2026-09-20

## Context

The initial design put Caddy in front of the app for TLS. The server already runs Nginx
Proxy Manager, publicly reachable on 80/443, fronting other services.

An earlier probe found ports 80 and 443 answering with the Xiaomi router's own admin UI.
That was the router responding to its own WAN address from inside the LAN — ordinary
hairpin behaviour — not an exposed admin panel.

## Decision

Drop Caddy. NPM terminates TLS and reverse proxies two hosts:

- `zoia.<domain>` → `app:3000`
- `sfu.<domain>` → `livekit:7880`

Certificates come from NPM's Let's Encrypt integration over an HTTP-01 challenge, one per
hostname — the same flow NPM already uses for the other services on this domain.

## Why two subdomains rather than path routing

Routing `/rtc` and `/twirp` through a single proxy host via NPM's custom locations works,
but NPM's custom locations are awkward with WebSocket upgrade headers and easy to get subtly
wrong. A second proxy host is one more row in a table and nothing to debug.

## Certificates: the existing wildcard

**Amended twice; this is the settled position.**

The first version of this ADR proposed migrating the zone's nameservers to Cloudflare so NPM
could use a DNS-01 challenge. The second reversed that, reasoning that HTTP-01 through
Squarespace DNS would be simpler.

Both were wrong about the facts on the ground, and checking rather than reasoning settled it:

- The zone is **already served by Cloudflare** (`nadia`/`rudy.ns.cloudflare.com`). There was
  never a migration to perform.
- A Let's Encrypt **wildcard `*.nullptrlabs.com` is already issued and renewing**, which is
  only possible via DNS-01 — so NPM already holds a Cloudflare API token.

So: add two A records in Cloudflare, and in NPM **select the existing wildcard** rather than
requesting anything. No migration, no new certificate, no challenge to configure.

The records must be **DNS only (grey cloud)**. Cloudflare's network does not carry WebRTC
media, and proxying the signalling WebSocket adds latency and failure modes for nothing.
Cloudflare defaults new records to Proxied, and the apex on this zone *is* proxied, so this
is the most likely single mistake in the whole deployment — `scripts/preflight.sh` checks it.

**Lesson worth keeping:** two rounds of confident advice here rested on assumptions about
someone else's infrastructure. A DNS lookup and a Certificate Transparency query answered it
in seconds. Check the environment before reasoning about it.

## Consequences

- No TLS code or certificate handling in this repo at all.
- A record must resolve publicly *before* its certificate is requested: Let's Encrypt
  validates from outside, and an early request fails and consumes rate limit.
- Media still bypasses the proxy entirely: UDP 7882 and TCP 7881 forward straight to the VM.
- `proxy_read_timeout` must be raised on the SFU host; nginx's 60 s default would sever the
  signalling WebSocket mid-broadcast.
- The app runs plain HTTP on 3000 and trusts exactly one proxy hop.
- If the router will not hairpin, LAN clients — including the host PC — need a local DNS
  override. That is an operational fix, not a code one.
