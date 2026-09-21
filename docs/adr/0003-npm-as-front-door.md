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

## Certificates: HTTP-01, DNS unchanged

**Amended 2026-09-21.** This ADR originally moved the zone's nameservers to Cloudflare so
NPM could use a DNS-01 challenge, reasoning that Squarespace has no NPM DNS plugin. That
reasoning was correct but did not lead where it appeared to: DNS-01 is required only for a
*wildcard* certificate.

NPM already issues Let's Encrypt certificates for other services on this domain, which
demonstrates that port 80 reaches it from the internet — the only requirement of an HTTP-01
challenge. NPM is the default vhost on port 80, so any new subdomain pointed at the public
IP validates with no extra configuration.

So: **DNS stays at Squarespace.** Two A records, two ordinary per-hostname certificates.

This removes the single riskiest step in the deployment — migrating DNS for a domain already
serving live services — in exchange for a wildcard certificate we were not going to use.

If the zone is ever moved behind Cloudflare, both records must be **grey-cloud (DNS only)**:
the proxy will not carry WebRTC media. `scripts/preflight.sh` checks for this regardless, so
the mistake is caught rather than debugged.

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
