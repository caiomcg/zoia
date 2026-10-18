# 32. Credentials and identities in SQLite

- **Status:** proposed
- **Date:** 2026-10-17
- **Replaces** the JSON-file stores of [ADR 0002](0002-invite-keys-over-shared-password.md),
  [ADR 0007](0007-device-pairing.md) and [ADR 0031](0031-accounts-with-admin-approval.md)
  for accounts and devices

## Context

Invite keys, pairing tokens, devices and now accounts were each a JSON file under
`server/data/`. A write read the whole file, changed it, and replaced it with a
write-then-rename, so a crash mid-write could not truncate it, and writes were serialised
by a promise chain.

That chain only exists inside one process. `keytool` is a second process writing the same
files on the VM — revoking a device, making the super admin, issuing a reset code — and
two processes each reading, changing and writing back a whole file lose
whichever change finished first. Nothing reports it. With accounts the files also hold
every email and password hash, and a lost write there is a person locked out or a
revocation quietly undone.

The files also enforced nothing. Two accounts with one email, or a device of an account
that no longer exists, were prevented only by the code that happened to check.

## Decision

Every credential and identity — accounts, and the devices signed in to them — lives in one
SQLite database, `server/data/zoia.db`, through `node:sqlite`, which is built into Node: no
dependency, nothing native to build.

- **Every change is a transaction** that takes the database's write lock (`BEGIN
  IMMEDIATE`). The server and keytool can both write; one waits for the other
  (`busy_timeout`), and neither undoes the other. A change that throws is rolled back
  whole.
- **Durability:** WAL journal with `synchronous = FULL`, so a commit that has returned is
  on disk.
- **The schema keeps the rules:** every account has an email, unique, and a password; every
  device has an account that exists, and goes with it if a pending sign-up is rejected;
  roles and statuses come from a fixed set. Tables are `STRICT`.
- **Schema versions** are an append-only list applied in order and recorded in
  `user_version`.
- **The stores keep their interface.** `mutate(fn)` still hands a callback every record to
  change in place; it now runs inside a transaction and writes back only the rows that
  changed. The account and device logic did not change.
- **Nothing is imported.** Accounts replace every older way in
  ([ADR 0031](0031-accounts-with-admin-approval.md)), so the old JSON files are not carried
  over; deploying this means deleting them.
- **The file is 0600**, as the JSON files were, and SQLite gives its `-wal` and `-shm`
  files the same mode.
- **Backups:** `keytool db:backup <path>` uses SQLite's online backup, so the copy is
  consistent while the server runs.

The channel list stays a JSON file. It holds no credential, and only the server writes it.

## Why not Postgres

It would be a second service on the VM to run, secure, upgrade and back up, with its own
network credentials, for a few dozen rows read by one process. SQLite on the volume the
data already lives on has the same transactions and constraints for this. If Zoia ever runs
more than one app server, these tables move to Postgres largely as they are.

## Why not encrypt the file

The key would live in `.env` on the same VM, next to the file. Anyone who can read the one
can read the other, so it would add a step without adding protection. What protects the
contents is that the file is readable by the server's user only, that passwords and codes
are scrypt hashes, and that nothing logs an email.

## Consequences

- **Node 22.13 or later** is required, for `node:sqlite`. CI tests on 22 and 24; production
  runs 25. Node 20 was already past end of life.
- `node:sqlite` still prints an experimental warning on some Node versions. Its API is
  small and what is used here is stable in practice; if it changes, it changes in one file.
- **The data is no longer readable with `cat`.** `keytool` covers the everyday questions;
  for anything else, `node -e` with `node:sqlite` in the container, or `sqlite3` on a copy
  made with `db:backup`.
- Every store write still reads its whole table. At a few dozen rows that costs nothing; it
  is the price of keeping every store's logic unchanged, and a store that grows large
  should move to queries of its own.
