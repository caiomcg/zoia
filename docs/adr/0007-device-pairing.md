# 7. Device pairing, not a key in the binary

- **Status:** accepted
- **Date:** 2026-09-21
- **Extends** [ADR 0002](0002-invite-keys-over-shared-password.md)

## Context

[ADR 0002](0002-invite-keys-over-shared-password.md) gave each person a URL carrying an
invite key. That works when access arrives as a link. The desktop app
([ADR 0006](0006-native-desktop-client.md)) arrives as an `.exe` somebody downloads, and
asking a friend to paste a secret before they can watch a screen is the kind of friction
that ends with them not bothering.

So the binary should carry its own credential. The obvious version of that is wrong in a way
worth stating plainly:

> **A secret inside a distributed binary is extractable.** Anyone holding the `.exe` can
> recover it with a hex editor. There is no build flag, no obfuscation and no packing that
> changes this.

If the embedded value *is* the access token, then one leaked `.exe` is permanent access for
anyone who finds it, and the only remedy is to invalidate everyone and rebuild.

## Decision

The embedded value is a **pairing token**, not an access token. It is spent once, on first
run, to obtain a credential belonging to that one machine:

```
first run    POST /api/pair             { pairingToken, deviceName }
             → { deviceCredential }      stored via Electron safeStorage (DPAPI)

every run    POST /api/device/session   { deviceCredential }
             → session cookie → POST /api/token → LiveKit JWT
```

Treat the embedded token as an **invitation**: something that lets a machine ask to be
enrolled, not something that grants access by itself.

This yields two independent kill switches:

- **Revoke the pairing token.** No new machines can activate; every machine already paired
  keeps working. This is the lever for "that build got passed around".
- **Revoke one device.** A single machine loses access and nobody else notices.

`--max-activations` caps how many machines a token can ever enrol, which bounds the blast
radius before anyone notices a leak.

## Why revocation is re-checked on every request

The session cookie holds `<kind>:<id>` — signed, `httpOnly`, and carrying **no secret**. The
id is resolved against the store on **every** request rather than trusted until the cookie
expires.

The alternative, trusting a valid cookie for its lifetime, means `device:revoke` does
nothing for up to a month. A revocation that takes effect in thirty days is not a
revocation. This costs one small read per request against a JSON file of a few dozen
records, which is not a cost worth optimising.

`server/src/pairings.js` and `server/src/devices.js` deliberately reuse the shape of
`keys.js`: scrypt hashing, write-then-rename for atomicity, and the same `revoked` /
`expiresAt` / `lastSeen` fields. A second, subtly different auth scheme is how a codebase
ends up with two sets of bugs.

## Consequences

- Neither the raw pairing token nor the device credential is ever persisted or logged — only
  their scrypt hashes exist at rest. There are tests asserting exactly this, because it is
  the kind of guarantee that breaks silently.
- `keytool` grows `pair:new`, `pair:list`, `pair:revoke`, `device:list`, `device:revoke`.
- `device:list` gives a real inventory: who paired, from which token, and when they were last
  seen. That last field is only trustworthy because activity is recorded against the device
  store on every token renewal, not just at login.
- **The invite-key path stays.** It still works, still holds real records, and is still
  managed by `keytool`. Removing it would break any cookie issued before the desktop app
  existed for no benefit, and the session layer already handles both kinds. A bare id in a
  cookie is read as a key, which is what old cookies contain.
- The pairing endpoint gets a tighter rate limit than login. A pairing token is guessed at
  far more aggressively than a password, because it is worth more.
