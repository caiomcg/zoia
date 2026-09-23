# 2. Per-person invite keys, not a shared password

- **Status:** accepted
- **Date:** 2026-09-20
- **Extended by** [ADR 0007](0007-device-pairing.md), which is how the desktop app gets access

## Context

Access must be restricted to an invited group of roughly fifteen people. The initial
proposal was a single password shared with everyone.

## Decision

Each person gets their own 256-bit invite key, stored hashed, delivered as a one-time URL.
Roles (`host` / `viewer`) are a property of the key.

## Why not a shared password

A shared secret cannot be revoked for one person. When someone leaves the group — or
forwards the link once, carelessly — the only remedy is rotating the password and
re-distributing it to everyone else. In practice that friction means it never happens, and
the credential slowly leaks into permanence.

Per-person keys also give a usable audit trail: `lastSeen` per record answers "who is
actually using this?", which a shared password cannot.

The cost is a mint/revoke workflow, which is a ~100-line CLI.

## Why the key encodes its own id

`zoia_<id>_<secret>`. The id is public and identifies the record, so verification is a
single hash. Without it, login would have to try every stored record's salt in turn — N
scrypt operations per attempt, turning login into a self-inflicted denial of service as the
group grows. It also gives us a safe token to log.

## Consequences

- Keys are bearer credentials; holding the URL *is* being that person. Revocation is the
  mitigation.
- Sessions must be re-validated against the store on every request, or revocation is
  cosmetic until the cookie expires.
- The raw key is shown once and is unrecoverable, so the workflow for a lost key is "mint a
  new one and revoke the old", not "look it up".
