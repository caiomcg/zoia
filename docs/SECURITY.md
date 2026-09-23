# Security

## What this protects against

The realistic threat is **someone who shouldn't see the broadcast getting the URL** — a
forwarded link, a shared password that outlived its usefulness, or a former member of the
group. Secondarily: a viewer taking over the stream.

It is not designed to withstand a targeted attacker with resources. It is designed so that
access is per-person, revocable, and enforced by the server rather than by the UI.

## Device pairing

This is the path the desktop app uses, and the one that matters today. Full reasoning in
[ADR 0007](adr/0007-device-pairing.md).

An invitation is a **pairing token**, not an access token. The distinction is the whole
design:

> **A secret inside a distributed binary is extractable.** Anyone with the `.exe` can
> recover it. No build flag or obfuscation changes that.

That is why the published binary contains no token at all, and no server URL either
([ADR 0010](adr/0010-invites-outside-the-binary.md)). A release is inert: it can be linked
publicly because it is not a credential. The invitation travels separately, as a
`zoia-invite.json` sent over a private channel, and **that file is the credential** — a fact
worth repeating to anyone you send one to, because it lands in a Downloads folder like
anything else.

A pairing token grants nothing by itself even so. It is spent once, at first run, for a
credential belonging to that one machine, stored with Electron `safeStorage` (DPAPI on
Windows). That gives two independent kill switches — revoke the invite to stop *new*
machines, revoke a device to cut off *one* — and means a leaked invitation is a bounded
problem rather than a permanent one. `--max-activations` bounds it further, and revoking now
costs nothing to redo: no rebuild, no re-sending a binary.

A private build made with `make-exe.bat` still embeds a token, and such a build **is** a
credential. The build script fails loudly if a `--public` build comes out with one inside.

### Pointing the app at a server

Taking the server URL from a file is a new attack surface, so `src/main/invite.ts` validates
it before anything is sent: **https only**, except on loopback where a self-hoster has no
certificate yet. Honouring `http://` would put a device credential — and every later request
carrying the session cookie — on the wire in the clear, at the choosing of whoever wrote the
file. The token's shape is checked too, so a mistyped one fails as a bad token rather than as
an opaque 401.

Pairing tokens and device credentials use the same scrypt-at-rest and timing-safe comparison
as invite keys below, and neither raw value is ever persisted or logged. `pairing.test.js`
asserts both, including that no raw secret reaches a log line.

`/api/pair` is rate-limited harder than login: a pairing token is worth more than one
person's access, so it is guessed at more aggressively.

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

The session cookie holds only `<kind>:<id>` — a device or key id, never a secret — signed
with `SESSION_SECRET`, and is set
`HttpOnly`, `Secure`, `SameSite=Lax`, 30-day expiry.

**Every request re-resolves that id against the store it came from.** Revocation is
therefore immediate. The alternative — trusting the cookie until it expires — would mean
`keytool device:revoke` silently does nothing for up to a month, which is the precise moment
revocation matters.

The key is stripped from the URL by a 302 redirect immediately after login, so it does not
survive in browser history, the URL bar, or a `Referer` header sent to some other site.

## Publishing is a permission, not a UI state

**Every token is issued subscribe-only** — `canPublish: false` — regardless of any stored
role ([ADR 0005](adr/0005-one-tier-claimable-stage.md)). Publishing is granted at runtime,
by the server, only while the stage is free, and LiveKit validates that grant server-side on
every publish attempt.

So a client editing its own JavaScript achieves nothing: it holds a token that says it may
not publish. `server/test/token.test.js` feeds the issuer `'host'`, `'admin'` and assorted
junk and asserts none of it grants publish, so a refactor that reintroduces a privileged
role fails loudly.

## Logging

Raw keys, pairing tokens and device credentials must never reach a log line. The **id** is
logged instead: it identifies the person for auditing without being a credential.
`routes.test.js` asserts that a full login flow emits no raw key, and `pairing.test.js`
asserts the same for a full pairing flow.

Crash reports collected from clients are held in memory and reachable only with a session,
so a report never becomes a public channel.

## Rate limiting

Login routes are limited to 10 attempts/minute/IP. With 256-bit secrets this is belt and
braces, but it also caps log noise and blunts anyone probing the endpoint.

`TRUST_PROXY=1` is required: behind Caddy, every request otherwise appears to come from the
proxy's address and the limiter would throttle all users as one client.

## Known limitations

- **Credentials are bearer credentials.** Whoever holds one is that person. Revocation is
  the mitigation, not prevention.
- **The pairing token in a build is extractable**, by design and unavoidably. It is an
  invitation, not a key — see above.
- **Binaries are unsigned.** SmartScreen will warn, and a warning people are taught to click
  through is a real weakness. Code signing costs money this project does not have.
- **No per-viewer watermarking or DRM.** A viewer can record what they see. If that matters,
  this is the wrong architecture.
- **The router is outside this repo's control.** The port forwards are configured by hand
  and verified per the runbook.
- **The WHIP ingress is plain HTTP**, which is why it is LAN-only and never forwarded
  ([ADR 0009](adr/0009-hardware-encoding.md)).

## Stronger options, if wanted later

- **mTLS client certificates** — issue each person a `.p12`; NPM rejects anyone without a
  valid cert, so unauthenticated traffic never reaches the app at all. Strongest option
  here. Cost: painful to install on phones, and re-issuing on device changes falls to you.
- **Tailscale** — put the VM on a tailnet and open zero router ports. The attack surface
  disappears rather than being guarded, which beats any authentication scheme. Cost: a VPN
  client on every viewer's machine. Layers cleanly on top of device pairing.
- **OIDC via Authelia or oauth2-proxy** with an email allowlist, so nobody holds a secret at
  all. Worth it only if the group grows well beyond fifteen.
