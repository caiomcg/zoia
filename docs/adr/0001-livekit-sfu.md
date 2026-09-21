# 1. Use a self-hosted LiveKit SFU

- **Status:** accepted
- **Date:** 2026-09-20

## Context

One host broadcasts a screen to up to ~15 viewers from a home connection, through a
Proxmox server with a Ryzen 5 3500U. Latency should be low enough for interactive use —
someone watching a demo should be able to ask about what they just saw.

## Options

**Peer-to-peer mesh.** No server media path. But the host uploads a separate copy per
viewer, so 15 viewers means 15× the upload. A residential link dies at three or four.

**MCU** (compose all streams server-side, send one). Cheap on client bandwidth, but it
transcodes — far beyond what a 3500U does in real time at desktop resolutions.

**SFU.** Host uploads once; the server forwards copies. CPU cost is packet forwarding, not
encoding. Bandwidth cost moves to the server's upstream.

**HLS / LL-HLS.** Scales furthest and works everywhere, but 3–15 s latency and the host
must run OBS rather than clicking a button in a web page.

## Decision

A self-hosted **LiveKit** SFU.

The mesh fails the stated audience size outright. The MCU fails the hardware. HLS fails the
interactivity goal and adds a desktop app install for the host, when `getDisplayMedia()` in
the browser needs nothing installed at all.

LiveKit over raw mediasoup/Janus because it ships JWT-based authorization with per-
participant grants, which is exactly the mechanism needed to enforce single-producer, and
because its client SDK handles reconnection and simulcast without us writing it.

## Consequences

- Upstream bandwidth is the capacity ceiling: `viewers × bitrate`, ~37 Mbps for 15 viewers.
- WebRTC needs UDP reaching the server directly; media cannot go through the existing nginx
  proxy, so new port forwards are required.
- `rtc.use_external_ip: true` becomes load-bearing — without it, remote ICE never completes.
- We inherit LiveKit's token model, which turns out to be the cleanest place to enforce
  roles. See ADR 0002.
