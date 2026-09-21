# 4. An isolated Caddy front end on the VM

- **Status:** accepted
- **Date:** 2026-09-21
- **Supersedes:** [ADR 0003](0003-npm-as-front-door.md)

## Context

ADR 0003 made Nginx Proxy Manager the public entry point, on the stated premise that NPM was
already serving 80/443 from the internet. That premise was wrong.

Nothing on this network is published to the internet. Every service is reached over a VPN,
and NPM serves the LAN only. The evidence that misled us — NPM holding valid Let's Encrypt
certificates — proves nothing about inbound reachability, because the certificate is a
**wildcard**, and wildcards are issued via DNS-01, which validates entirely over DNS.

Zoia is therefore the first service on this network to be exposed at all, which makes the
choice of entry point a security decision rather than a routing one.

## The problem with forwarding 443 to NPM

NPM routes by `Host` header. Forwarding 443 to it would make **every** proxy host it serves
reachable from the internet, not only Zoia — a request to the public IP carrying
`Host: <internal service>` would be routed to that service. The internal hostnames are absent
from public DNS, but hostname obscurity is not an access control.

Containing that would mean attaching an NPM Access List to every internal proxy host, and
remembering to do so for every host added in future. That is N things to keep right,
indefinitely, where N grows.

## Decision

Forward 443 to the **zoia VM**, which runs its own Caddy serving exactly two hostnames:
`zoia.nullptrlabs.com` → the app, and `sfu.nullptrlabs.com` → LiveKit signalling. Any other
Host header reaches nothing.

NPM keeps its current posture: entirely unexposed, LAN and VPN only, unchanged.

Certificates come from Let's Encrypt over a Cloudflare DNS-01 challenge, the same mechanism
already producing the wildcard. No inbound port 80 is required.

Caddy is built from `caddy:2-builder` with the `caddy-dns/cloudflare` plugin rather than
pulled from a third-party image: this container terminates TLS on the only publicly reachable
surface in the deployment, so its provenance should be ours.

## Consequences

- **Public blast radius is one VM** running one application that has its own authentication,
  snapshotted and disposable — instead of the whole internal service estate.
- Three router rules, all to the same host (`192.168.31.60`): 443/TCP, 7881/TCP, 7882/UDP.
  One target is easier to reason about than two.
- **Port 80 is not needed.** DNS-01 requires no inbound HTTP, so it is published on the
  container for LAN convenience only and deliberately not forwarded.
- The app publishes no host port at all; it is reachable only through Caddy.
- A Cloudflare API token scoped to `Zone:DNS:Edit` now lives in `.env` on the server. It can
  edit DNS for the zone, so it is a meaningful secret — `preflight.sh` checks it is set, and
  it is excluded from git and from deploys like every other secret.
- The nginx `proxy_read_timeout` hazard disappears: Caddy streams WebSockets without a read
  timeout, so the once-a-minute signalling drop is no longer a failure mode to configure
  around.

## Lesson

Three ADRs in a row rested on assumptions about infrastructure nobody had checked. Each was
settled in seconds once someone actually looked — a DNS query, a Certificate Transparency
lookup, a question about port forwarding. Check the environment before reasoning about it.
