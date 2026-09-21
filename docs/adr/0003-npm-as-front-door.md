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

Certificates come from NPM's Let's Encrypt integration using a Cloudflare DNS-01 challenge,
as a wildcard covering the whole zone.

## Why two subdomains rather than path routing

Routing `/rtc` and `/twirp` through a single proxy host via NPM's custom locations works,
but NPM's custom locations are awkward with WebSocket upgrade headers and easy to get subtly
wrong. A second proxy host is one more row in a table and nothing to debug.

## Why Cloudflare DNS

The domain is registered at Squarespace, which has no Caddy/NPM DNS plugin, so DNS-01 could
not be automated. Moving the zone's nameservers to Cloudflare (registration stays put)
enables automated renewal and a wildcard cert.

The records must be **grey-cloud (DNS only)**. Cloudflare's proxy will not carry WebRTC
media, and proxying signalling buys nothing.

## Consequences

- No TLS code or certificate handling in this repo at all.
- Media still bypasses the proxy entirely: UDP 7882 and TCP 7881 forward straight to the VM.
- `proxy_read_timeout` must be raised on the SFU host; nginx's 60 s default would sever the
  signalling WebSocket mid-broadcast.
- The app runs plain HTTP on 3000 and trusts exactly one proxy hop.
- If the router will not hairpin, LAN clients — including the host PC — need a local DNS
  override. That is an operational fix, not a code one.
