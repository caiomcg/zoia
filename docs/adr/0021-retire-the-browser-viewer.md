# ADR 0021 — Retire the browser viewer

- **Status:** accepted
- **Date:** 2026-09-27
- **Supersedes:** [ADR 0014](0014-browser-viewer.md)

## Context

ADR 0014 brought back a viewer-only browser client so friends could watch without installing
anything. Since then the desktop app has gained features that exist only there: channels,
per-broadcast volume and HQ, sender audio controls, and knowing who is watching your screen.
Who is watching depends on each viewer announcing it from the desktop app (ADR 0020's
companion change), so a browser viewer would be an invisible audience. It would also be a
second client to keep working, without the features people now expect.

## Decision

The web address goes back to a static page, as in ADR 0008: the logo, one sentence and a
link to the repository, with an eye favicon. No script is loaded. `viewer.js` and
`viewer.css` are deleted, and `server/test/landing.test.js` fails if a script or either file
comes back.

The server API is untouched. The desktop app uses the same host for pairing, sessions,
tokens, the stage, WHIP and crash reports. The viewer added no routes of its own, so there
is nothing server-side to remove.

## Consequences

- Watching needs the installed desktop app, so Windows only. Friends on macOS, Linux or a
  phone cannot watch at all.
- Everyone in a room is on a client that reports what it watches, so the eye in the member
  list is complete.
- One client to maintain instead of two.
- Anyone with the old viewer open is left with a page that no longer loads its script. They
  get the static page on their next reload.
