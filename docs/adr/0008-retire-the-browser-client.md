# 8. Retire the browser client

- **Status:** superseded by [ADR 0013](0013-browser-viewer.md)
- **Date:** 2026-09-22
- **Follows** [ADR 0006](0006-native-desktop-client.md)

## Context

Once the desktop app worked, the browser client was a second front end for the same server,
carrying its own copy of the player, the stage controls, the room list and the LiveKit
wiring — and it could not share application audio, which is the reason the project exists.

The original plan was to keep it **dormant as a viewer-only fallback**: it costs nothing to
leave deployed, and it is the only way a phone, a Mac or a Linux machine can watch. That was
the right instinct, and it is worth recording why it did not survive contact with the
codebase.

Two things settled it:

1. **It was a second implementation of every change.** Renaming, dismissible errors, the
   takeover flow, camera preview, the floating player controls — each landed in the desktop
   app and left the web client further behind. A fallback that diverges is not a fallback;
   it is a second product nobody tests.
2. **A dormant client is still attack surface.** It served `/?k=<key>`, held a session, and
   reached `/api/token`. Leaving that deployed and unmaintained on a public repository is a
   liability out of proportion to "somebody might watch on a phone".

## Decision

Replace the browser client with a **static landing page**: the logo, the project's colours,
and a link to the repository. No `<script>` tag at all.

The **HTTP API is untouched.** `/`, `/api/login`, `/api/session` and the key store all still
work exactly as before — see [ADR 0007](0007-device-pairing.md). What was removed is the
*client*, not the server's ability to serve one.

## Consequences

- **Watching requires Windows.** Combined with [ADR 0006](0006-native-desktop-client.md),
  Zoia is Windows x64 end to end. This is the second time that cost is paid, and it is the
  larger half: broadcasting was always going to be Windows-only, but watching need not have
  been.
- The landing page is a genuine static file, so the server no longer ships any browser
  JavaScript, and the markup/id guard that kept the client's DOM honest has nothing left to
  guard.
- Reviving a viewer-only client later is a real option rather than a rewrite: the token
  endpoint, the stage model and the room semantics are all still there and still tested. It
  would be a new page against an existing API.
- `server/public/` shrinks to a page and a logo, which is the whole of what is now public.
