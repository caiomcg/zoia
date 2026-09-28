# ADR 0024 — The activation cap counts seats

- **Status:** accepted
- **Date:** 2026-09-28
- **Amends** [ADR 0007](0007-device-pairing.md)

## Context

ADR 0007 capped how many machines a pairing token could *ever* enrol. In practice people
re-pair constantly — a reinstall, a second PC, a probe during debugging — and each one spent an
activation for good. The `portable-builds` invite hit 25/25 with only a handful of people behind
it, and new friends got `409 exhausted`. Revoking the dead devices did not help, because
revocation never gave the activation back. The only ways out were minting a new invite and
re-sending it, or editing the store by hand.

## Decision

`--max-activations` caps **seats**: live (not revoked, not expired) devices issued by the token.
`claimActivation` asks the device store how many seats are in use instead of reading the
lifetime counter. `activations` is still incremented and shown by `pair:list` as a lifetime
tally, next to `seats`.

## Consequences

- `device:revoke` is now also the way to make room on an invite. Cleaning up stale machines is
  the fix for `exhausted`, not a new invite.
- A leaked invite is bounded by the number of *concurrent* machines, not total ones. Someone
  holding it can pair again after you revoke their device, up to the cap. The answer to that is
  `pair:revoke`, which was already the answer to a leak.
- Two pairs landing in the same instant can both take the last free seat, because the seat
  count is read from a different store than the one being mutated. Behind the pairing rate
  limit and at this scale that means one extra device, not an open door.
