# Security

## What this protects against

The realistic threat is **someone who shouldn't see the broadcast getting the URL** — a
forwarded link, a shared password that outlived its usefulness, or a former member of the
group. Secondarily: a viewer taking over the stream.

It is not designed to withstand a targeted attacker with resources. It is designed so that
access is per-person, approved by someone, revocable, and enforced by the server rather than
by the UI.

## Accounts

Access is an account: an email and a password, approved by an admin before it can reach
anything ([ADR 0031](adr/0031-accounts-with-admin-approval.md)). Anyone who knows the host
can sign up, so most of what follows is about what sign-up does *not* let through.

- **Pending is nothing.** A pending account can sign in and ask whether it has been
  approved, and nothing else: no token, no channels, no stage. `accounts.test.js` checks each.
- **The email is not verified.** There is no mail, so anyone can sign up with anyone's
  address. Approval is the check; an admin must recognise who they approve.
- **Roles are checked on the server, every request.** Admins approve, disable and reset
  users; only the super admin manages admins; nothing in the app can create, demote,
  disable or reset the super admin, who is set with `keytool account:super` on the server.
  The role is re-read from the database on every request, so a demotion is immediate.
  A modified app — or DevTools — can show itself any button it likes; every request behind
  one is refused unless the database says the caller may make it, and no field a client
  sends is ever read as a role or a status. `accounts.test.js` sends exactly those forged
  requests.

### Passwords

Stored as **scrypt** with a per-account 16-byte salt, compared with `timingSafeEqual`, at
OWASP's setting for passwords: `N=2^14, r=8, p=5` — the form of it that keeps each hash to
16MB of memory, so a burst of logins cannot exhaust the VM. People choose passwords, and
someone holding a copy of the database would try to crack them offline; this is what that
costs them. At least 6 characters, with an uppercase and a lowercase letter, a digit and a
symbol; at most 128. Six is short on its own: what stops a short password being guessed
online is the per-account lockout and the per-address rate limit below.

An unknown email and a wrong password get the same answer and take the same time: a miss is
hashed against a decoy at the same setting. Ten wrong passwords lock an account for 15
minutes, and login is rate-limited per address on top.

There is no "forgot password" link, because there is no mail to send one with. An admin
issues a **reset code** instead: 256 random bits, shown once, valid 24 hours, single use,
stored hashed. Using it signs out every machine of the account.

### Devices

A password is typed once per machine. A login answers with a **device credential** —
`zdev_<8 hex id>_<43 char secret>` — which the app keeps with Electron `safeStorage` (DPAPI
on Windows, the Keychain on macOS) and presents at each launch. An account holds at most five
live machines; one more replaces the least recently used. A machine unused for 60 days
expires. Each can be signed out alone, by its owner, an admin disabling the account, or
`keytool device:revoke`.

Device credentials and reset codes are random, not chosen: 256 bits that nobody cracks
offline at any hash cost. They use scrypt at `N=2^14, r=8, p=1`, which only has to be
irreversible and compared in constant time. The **id** is public — it picks the record to
check, so verification is one hash, and it is what gets logged.

### Where it is all kept

In one SQLite file, `server/data/zoia.db`, readable by the server's user only
([ADR 0032](adr/0032-sqlite-for-credentials.md)). Every change is a transaction, so the
server and `keytool` writing at once cannot undo each other, and the schema refuses records
that should not exist: two accounts with one email, a device of an account that is gone.
It holds password hashes and every email; a backup of it is as private as the original.

### Pointing the app at a server

The sign-in screen asks for the server's address, and the password goes wherever it points,
so `src/main/server-url.ts` checks it before anything is sent: **https only**, except on
loopback, where someone trying a server they just started has no certificate yet. An address
typed without a scheme is taken as https, never http.

## Session handling

The session cookie holds only `device:<id>` — never a secret — signed with
`SESSION_SECRET`, and is set `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day expiry.

**Every request re-reads that device and its account from the database.** Signing a machine
out or disabling someone is therefore immediate. The server also removes their machines from
every channel at that moment, since a LiveKit connection makes no requests to refuse. The alternative — trusting the cookie until
it expires — would mean both silently do nothing for up to a month, which is the precise
moment they matter.

## Publishing is a permission, not a UI state

**Every token is issued subscribe-only** — `canPublish: false` — regardless of any stored
role ([ADR 0005](adr/0005-one-tier-claimable-stage.md)). Publishing is granted at runtime,
by the server, only to the participant who claimed their own broadcast slot
([ADR 0013](adr/0013-multiple-broadcast-slots.md)), and LiveKit validates that grant server-side on
every publish attempt.

So a client editing its own JavaScript achieves nothing: it holds a token that says it may
not publish. Account roles are about administration and never reach the token:
`server/test/token.test.js` feeds the issuer `'host'`, `'admin'` and assorted junk and
asserts none of it grants publish, so a refactor that lets a role leak into the grant fails
loudly.

## Logging

Passwords, device credentials, reset codes and email addresses must never reach a log line.
The account or device **id** is logged instead: it identifies the person for auditing
without being a credential, or personal data. `routes.test.js` and `accounts.test.js` assert
that sign-up, login and resets emit none of them.

Crash reports collected from clients are held in memory and reachable only with a session,
so a report never becomes a public channel.

## Rate limiting

Failed logins are limited per address (20 a minute), on top of the per-account lockout.
Sign-up is limited to 3 an hour per address, counting successes, and the server holds at
most 20 accounts waiting for approval; past that, sign-up is closed until an admin works the
queue. Reset codes are limited harder than logins, since one is worth an account.

`TRUST_PROXY=1` is required: behind Caddy, every request otherwise appears to come from the
proxy's address and the limiter would throttle all users as one client.

## Known limitations

- **Credentials are bearer credentials.** Whoever holds a device credential is that person
  on that machine. Signing it out is the mitigation, not prevention.
- **Passwords get reused.** A password leaked from somewhere else is a working login here.
  The lockout bounds online guessing; nothing bounds reuse.
- **Sign-up is public.** Anyone who knows the host can fill the approval queue up to its
  cap. It costs an admin a click per junk request, and nothing more.
- **Binaries are unsigned.** SmartScreen will warn, and a warning people are taught to click
  through is a real weakness. Code signing costs money this project does not have.
- **No per-viewer watermarking or DRM.** A viewer can record what they see. If that matters,
  this is the wrong architecture.
- **The router is outside this repo's control.** The port forwards are configured by hand
  and verified per the runbook.
- **Hardware-encoded broadcasts publish over WHIP**, straight to the SFU at `/whip/v1`
  on its existing TLS hostname, with media on the existing UDP 7882. No separate port or
  service is exposed. Publishing needs a LiveKit token that `/api/whip` hands out **only
  to the current stage holder**: it lasts five minutes, allows publishing only, and is
  redacted from logs and crash reports. Before this, a separate Ingress endpoint checked
  only for a session, so any signed-in device could publish around the stage
  ([ADR 0011](adr/0011-hardware-encoding-over-the-internet.md)).

## Stronger options, if wanted later

- **mTLS client certificates** — issue each person a `.p12`; NPM rejects anyone without a
  valid cert, so unauthenticated traffic never reaches the app at all. Strongest option
  here. Cost: painful to install on phones, and re-issuing on device changes falls to you.
- **Tailscale** — put the VM on a tailnet and open zero router ports. The attack surface
  disappears rather than being guarded, which beats any authentication scheme. Cost: a VPN
  client on every viewer's machine. Layers cleanly on top of accounts.
- **OIDC via Authelia or oauth2-proxy** with an email allowlist, so nobody holds a secret at
  all. Worth it only if the group grows well beyond fifteen.
