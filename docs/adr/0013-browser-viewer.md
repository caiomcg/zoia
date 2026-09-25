# 13. Restore a viewer-only browser client

- **Status:** accepted
- **Date:** 2026-09-25
- **Supersedes:** [ADR 0008](0008-retire-the-browser-client.md)

## Context

The desktop app remains the only broadcaster because screen and application-audio capture
need native Windows APIs. Requiring every friend who only wants to watch to install and pair
the desktop app makes the experience heavier than necessary.

## Decision

The server serves a small browser viewer. It uses the existing invite-key session and the
existing `/api/token` endpoint, whose LiveKit grant is subscribe-only. The page can select one
or more remote broadcasts and mix audio from one selected broadcast at a time, but it has no
capture, stage-claim or publish controls.

The browser viewer uses the pinned LiveKit client as an ESM dependency from jsDelivr. This
keeps the server's static client build-free while retaining a single LiveKit protocol client
version in the repository's desktop package and the browser page.

## Consequences

- A spectator can open the invite in a browser on Windows, macOS, Linux or mobile without
  installing the desktop app.
- The desktop app remains required for screen sharing and application audio capture.
- The viewer is a second UI surface, so its supported scope is deliberately narrow: join,
  watch selection, audio control and reconnection status. Broadcast controls stay desktop-only.
