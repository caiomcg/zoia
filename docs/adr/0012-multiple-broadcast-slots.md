# ADR 0012 — Multiple independent broadcast slots

## Status

accepted

## Context

The room previously exposed one global stage. That made publishing exclusive:
one participant could share and every other participant had to ask for a
takeover. The LiveKit room itself can carry multiple publishers, and viewers
need to be able to follow one or more of them independently.

## Decision

Each participant may claim one runtime broadcast slot. A slot is represented by
the participant's LiveKit permission, not by a separate application database.
Join tokens remain subscribe-only; `stage.js` grants and revokes publish rights
for the requesting participant only. The WHIP path applies the same per-owner
check.

The desktop client keeps remote publications independently selectable. It
renders selected broadcasts in a grid and unsubscribes from deselected video and
audio publications to avoid downloading streams the viewer did not choose. The browser viewer
uses the same selection model. Each publisher advertises a small source label (for example,
window name or screen name) as LiveKit participant metadata so viewers can distinguish similar
broadcasts.

## Consequences

- Multiple people can publish in the same room without takeover prompts.
- Each participant remains limited to one application-owned broadcast slot.
- Viewers can watch one, several, or none of the active broadcasts.
- Server upstream bandwidth grows with the number of active streams and viewers.
- Viewers see the broadcaster and source identity, while keeping only one stream's audio active
  by default; quality, focus and audio-only controls limit unnecessary bandwidth.
- The old takeover UI and global-holder semantics are no longer part of the
  broadcast flow.
