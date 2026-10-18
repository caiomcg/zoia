# 31. Accounts with an email and password, approved by an admin

- **Status:** proposed
- **Date:** 2026-10-17
- **Supersedes** invite keys ([ADR 0002](0002-invite-keys-over-shared-password.md)), pairing
  tokens ([ADR 0007](0007-device-pairing.md), [ADR 0010](0010-invites-outside-the-binary.md)),
  the per-invite seat cap ([ADR 0024](0024-activation-cap-counts-seats.md)) and the "no roles
  at all" half of [ADR 0005](0005-one-tier-claimable-stage.md). The per-device credential from
  ADR 0007 stays, issued by a login instead of a pairing token.

## Context

Access today is a device, not a person. Everyone pairs through one shared invite,
`portable-builds`, capped at 25 live devices. On 2026-10-17 it was full: 25 seats held by
fewer than twenty people, because every reinstall, second PC or tablet retry took a new seat
and became a new, unrelated record — `Diego`, `Diego 2`, `Diego 3`, `Caio 2`, seven
`samsung SM-X510` entries from one afternoon. New people were turned away with `exhausted`
while the logs filled with their retries.

The seat cap is shared by everyone, so one person's flaky tablet can lock the rest out. A
name and a picture belong to a device, so the same person appears several times. And there
is no way to say "this is Diego" at all: revoking Diego means guessing which of the
twenty-five machines are his.

Per-person invite files were considered first. They fix the seat problem but keep the
operator as the bottleneck for every new person — generate a file, send it out of band — and
still give nobody but the operator a way to manage anything. The group has outgrown one
person doing all of that by hand on the VM.

## Decision

### Accounts

A person has an **account**: an email, a password, a display name and a role. Devices belong
to an account.

- **The email is the login.** It is trimmed and lowercased, and unique on the server. It is
  never shown to other users, only to admins. It is **not verified**: the server sends no
  mail. Admin approval is the check that the person is who they claim to be; the email is a
  login name that people do not forget.
- **The display name is separate.** At sign-up it defaults to the part of the email before
  the `@`, made unique with `names.js` as names are today, and the person changes it
  afterwards from Settings › Profile. Name and picture move from the device to the account,
  so every one of a person's devices shows the same person.
- **Passwords** are at least 6 characters, with an uppercase and a lowercase letter, a digit
  and a symbol, and are stored only as scrypt hashes, using the
  machinery in `store.js` that already hashes keys and device credentials.

### Roles

| Role            | Who                                                       | Can                                                                                                     |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **SUPER_ADMIN** | Exactly one account, the operator                         | Everything an admin can, and make or remove admins                                                      |
| **ADMIN**       | Assigned by the super admin                               | Approve or reject sign-ups; disable, re-enable and reset the password of users who are not admins; add, rename and remove channels |
| **USER**        | Everyone else                                             | Watch and broadcast, and join any channel                                                                           |

The super admin is set **only on the server**, with `keytool account:super <email>`. No API
call can create, demote, disable or reset the super admin, so a compromised admin cannot take
the server over. Roles govern administration only: broadcasting is still granted per
participant at runtime by `stage.js`, and join tokens still never carry `canPublish: true`.

### Sign-up and approval

```
sign up     POST /api/signup         { email, password }        → account, status: pending
log in      POST /api/login          { email, password, deviceName }
                                     → deviceCredential (as /api/pair returns today)
every run   POST /api/device/session { deviceCredential }       → session cookie
```

1. Anyone with the server address can create an account. It starts **pending**.
2. A pending account can log in, but `/api/token` refuses it: the app shows a "waiting for
   approval" screen and checks again in the background. Nothing else is reachable.
3. Admins see the number of pending accounts in `/api/session`. The desktop app polls it,
   badges Settings and pops a notice once per new request. Settings › Accounts lists each
   request with its email, date and address, with **Approve** and **Reject**.
4. Approval makes the account **active**; the waiting screen moves on by itself. Rejection
   deletes the pending account, freeing the email.

Approving is desktop-only for now. Android gets the sign-up, login and waiting screens.

### Devices, after login

A password is typed once per device. Logging in issues the same kind of per-device
credential pairing used to, so the session layer, `device:revoke` and per-request revocation
work as before; every device belongs to an account.

- **Each account has a device cap** (default 5). Logging in on one more device revokes the
  account's least recently seen device instead of refusing. A reinstall is the same person
  logging in again, not a new seat.
- **A device unused for 60 days expires.** Stale machines stop holding anything without
  anyone revoking them.

### Recovery

There is no email, so there is no "forgot password". An admin generates a **reset code** for
the account: shown once, valid for 24 hours, single use, stored hashed. The person enters
the code and a new password, and is signed in. Using a code signs out every machine of the
account; changing the password from Settings signs out all but the one doing it. An admin
nobody else can reset gets a code from `keytool account:reset` on the server.

### What guards the public endpoints

Sign-up and login are reachable from the internet, through Caddy, by anyone who knows the
hostname.

- Sign-up is limited per address (3 an hour), and the server holds at most 20 pending
  accounts; past that, sign-up answers "closed for now" until an admin works the queue.
- Login is limited per address, and an account locks for 15 minutes after 10 failed
  attempts.
- An unknown email and a wrong password get the same answer and take the same time — the
  server hashes against a dummy record when the email does not exist.
- Every admin action is checked on the server against the caller's role, re-read from the
  store on every request. The app hiding a button is presentation, not enforcement.

### No migration: every older way in ends

Everyone signs up again. Invite keys, pairing tokens and every device paired with them are
removed — from the code, and from the server's data when this is deployed — rather than
carried into accounts.

Moving people over was designed and built first: group the existing devices into accounts by
name, and have each person claim theirs with a one-time code. It was dropped before release.
The group is small enough that signing up takes each person a minute, while a migration
needs the operator to guess who owns which machine, hand out a code per person, and keep two
ways in alive until the last one claims. Starting clean also means no account exists that
nobody has chosen a password for.

Channel management moves to admins too: adding, renaming and removing a channel, which
[ADR 0015](0015-channels.md) left to anyone, now needs an admin. Joining one does not.

## Consequences

- **The server now holds passwords and email addresses**, in the database
  ([ADR 0032](0032-sqlite-for-credentials.md)) on the gitignored, never-deployed-over volume.
  Passwords are hashed; emails are not, because admins need to read them. Neither is ever
  logged — the account id is. Backups of the VM now contain personal data.
- **There is a public sign-up form.** Before, nobody without a file from the operator could
  even reach the approval stage. The rate limit and the pending cap bound how much noise
  that can make, but an admin will see junk requests and has to reject them.
- **Passwords can be guessed and reused.** People reuse passwords, and a leaked one from
  elsewhere is a working login here. The lockout bounds online guessing; nothing bounds
  reuse. This is the price of not needing a file from the operator.
- **Recovery is manual.** A forgotten password needs an admin to be around. With the group's
  size that is acceptable; it would not be with strangers.
- **Unverified email means anyone can sign up as anyone's address.** Approval is the only
  defence, so admins must recognise who they approve. A rejected request costs nothing.
- **The operator is no longer the only one who can let people in.** That is the point, and
  also new trust: an admin can approve anyone. Only the super admin can make admins, and
  only from the server.
- **There are no invite files any more.** The app needs a server address and nothing
  secret, so a build carries no credential and needs none handed over with it.
- **Everyone is signed out on deploy**, and an app from before this cannot sign in at all:
  it only knows pairing. Desktop updates itself; the Android app needs its own release with
  account login before it works again.
- **AGENTS.md** says accounts and roles where it said invite keys, and the rule against
  logging a raw invite key now covers passwords, credentials, reset codes and emails.
- Display names stay unique per server, as before, but per account rather than per device,
  which is what ends `Diego 2` and `Diego 3`.
