# ADR 0013 — Multiple independent broadcast slots

## Status

accepted. Supersedes the single-holder stage of [ADR 0005](0005-one-tier-claimable-stage.md);
its one tier of user still stands.

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

The desktop client shows one broadcast in a spotlight and every other one as a
small thumbnail along the bottom, labelled with the sharer's avatar and source
name. A broadcast that starts later joins the strip rather than taking the
picture; clicking a thumbnail moves it up. Only the spotlight plays audio and
requests the high simulcast layer, so thumbnails cost little. The browser viewer
keeps an explicit selection model, and unsubscribes from deselected broadcasts. Each publisher advertises a small source label (for example,
window name or screen name) as LiveKit participant metadata so viewers can distinguish similar
broadcasts.

## Consequences

- Multiple people can publish in the same room without takeover prompts.
- Each participant remains limited to one application-owned broadcast slot.
- Viewers can watch one, several, or none of the active broadcasts.
- Server upstream bandwidth grows with the number of active streams and viewers.
- Viewers see the broadcaster and source identity, and hear only the spotlight.
- In-app broadcasts publish simulcast with one extra 360p/15 fps layer, which
  thumbnails and the "low quality" setting use. It costs each broadcaster about
  400 kbps of upload and a second encode.
- Hardware (WHIP) broadcasts publish a single layer, so their thumbnails are not
  cheaper than the spotlight, and the quality setting is hidden for them.
- A new broadcast joins the thumbnail strip; the spotlight never moves on its own
  while what it shows is still live.
- The old takeover UI and global-holder semantics are no longer part of the
  broadcast flow.
