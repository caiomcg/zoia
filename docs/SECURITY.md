# Security

## What this protects against

The realistic threat is **someone who shouldn't see the broadcast getting the URL** — a
forwarded link, a shared password that outlived its usefulness, or a former member of the
group. Secondarily: a viewer taking over the stream.

It is not designed to withstand a targeted attacker with resources. It is designed so that
access is per-person, revocable, and enforced by the server rather than by the UI.

## Invite keys

A key looks like `zoia_<8 hex id>_<43 char secret>`:

- The **id** is public. It identifies which record to check, so verification is a single
  hash rather than a scan over every record, and it is what gets logged.
- The **secret** is 32 bytes from `crypto.randomBytes`, base64url-encoded — 256 bits of
  entropy. Guessing it is not a threat model, which is why the hash choice below is safe.

Stored as **scrypt** (`N=16384, r=8, p=1`) with a per-record 16-byte salt, compared with
`timingSafeEqual`.

> **Why scrypt rather than argon2id:** the slow-hash arms race exists to protect *low-entropy
> human passwords* against offline cracking. A 256-bit random secret has no such weakness —
> no attacker cracks it at any hash cost. What matters is that the stored form is
> irreversible and the comparison is timing-safe, both of which `node:crypto` provides
> without a native dependency in the image. If the scheme ever changes to accept
> user-chosen passphrases, this reasoning no longer holds and argon2id becomes required.

The raw key is displayed **once**, when minted. It is never stored, never logged, and never
recoverable; a lost key is replaced, not looked up.

## Session handling

The session cookie holds only the `keyId`, signed with `SESSION_SECRET`, and is set
`HttpOnly`, `Secure`, `SameSite=Lax`, 30-day expiry.

**Every request re-resolves that id against the key store.** Revocation is therefore
immediate. The alternative — trusting the cookie until it expires — would mean
`keytool revoke` silently does nothing for up to a month, which is the precise moment
revocation matters.

The key is stripped from the URL by a 302 redirect immediately after login, so it does not
survive in browser history, the URL bar, or a `Referer` header sent to some other site.

## Role enforcement

`server/src/token.js` sets `canPublish` from the stored role. LiveKit validates that grant
server-side on every publish attempt. A viewer who edits the page's JavaScript still cannot
publish — the server refuses. `server/test/token.test.js` asserts this and will fail loudly
if a refactor ever drifts.

## Logging

Raw keys must never reach a log line. `keyId` is logged instead: it identifies the person
for auditing without being a credential. `routes.test.js` asserts that a full login flow
emits no raw key.

## Rate limiting

Login routes are limited to 10 attempts/minute/IP. With 256-bit secrets this is belt and
braces, but it also caps log noise and blunts anyone probing the endpoint.

`TRUST_PROXY=1` is required: behind NPM, every request otherwise appears to come from the
proxy's address and the limiter would throttle all users as one client.

## Known limitations

- **A key is bearer credential.** Whoever holds the URL is that person. Revocation is the
  mitigation, not prevention.
- **No per-viewer watermarking or DRM.** A viewer can record what they see. If that matters,
  this is the wrong architecture.
- **NPM and the router are outside this repo's control.** The TLS posture and the port
  forwards are configured by hand and verified per the runbook.

## Stronger options, if wanted later

- **mTLS client certificates** — issue each person a `.p12`; NPM rejects anyone without a
  valid cert, so unauthenticated traffic never reaches the app at all. Strongest option
  here. Cost: painful to install on phones, and re-issuing on device changes falls to you.
- **Tailscale** — put the VM on a tailnet and open zero router ports. The attack surface
  disappears rather than being guarded, which beats any authentication scheme. Cost: a VPN
  client on every viewer's machine. Layers cleanly on top of invite keys.
- **OIDC via Authelia or oauth2-proxy** with an email allowlist, so nobody holds a secret at
  all. Worth it only if the group grows well beyond fifteen.
