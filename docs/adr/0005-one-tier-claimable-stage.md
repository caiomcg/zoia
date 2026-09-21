# 5. One tier of user, with a claimable stage

- **Status:** accepted
- **Date:** 2026-09-21
- **Supersedes the role split in** [ADR 0002](0002-invite-keys-over-shared-password.md)

## Context

The original design had two kinds of key: `host` (could publish) and `viewer` (could not).
In use this was wrong on both counts. Nobody could tell who was in the room, and whoever
happened to hold the host key was the only person who could ever share — which is not how a
group of people looking at each other's screens actually behaves.

## Decision

One tier. Every invite key is equal, everyone joins subscribe-only, and **anyone may claim
the stage** to broadcast. Only one person holds it at a time.

Claiming is a server-side permission change, not a UI state:

1. The client calls `POST /api/stage/claim`.
2. `stage.js` lists the LiveKit room's participants and refuses if anyone already has
   `canPublish`.
3. If free, it raises that participant's permission with `updateParticipant`, and LiveKit
   pushes the change to the client live — no reconnect, no second token.
4. Releasing, disconnecting, or closing the tab drops it back.

## Why derive state from LiveKit rather than track it

The obvious implementation keeps "who holds the stage" in a variable. That variable is wrong
the moment a broadcaster's laptop closes: the stage stays locked and nobody else can present
until something clears it by hand.

Listing the room's participants cannot drift, because a participant who has gone is simply
not in the list. The failure mode disappears rather than being handled.

## Consequences

- A client that skips the claim call still cannot publish; its permission says so and LiveKit
  enforces it. Single-producer survives a hostile browser console.
- A refused claim changes no permissions, so a race between two claimants leaves the loser
  exactly as they were.
- Re-claiming by the current holder succeeds, so a retry after a network blip is not a
  lockout.
- `role` remains in the key store for existing keys but no longer affects anything. Tokens
  are subscribe-only regardless of what it says — covered by a test that feeds the issuer
  `'host'`, `'admin'` and assorted junk and asserts none of it grants publish.
