# 35. Text chat, with its messages in ScyllaDB

- **Status:** proposed
- **Date:** 2026-10-21
- **Amends** [ADR 0032](0032-sqlite-for-credentials.md), which argued against a second
  database service

## Context

People in a channel can only talk by voice or by broadcasting. There is nowhere to leave a
link, answer someone who is not in the call, or read what was said while you were away. The
sidebar has room under the channel list, and the main area sits empty whenever nobody is
being watched.

Messages are not like the rest of the data. Accounts and devices are a few dozen rows that
change rarely and are read on every request. Messages only grow, are written by everyone, and
are read newest first, a page at a time. Read markers are one row per person per chat,
rewritten every time someone looks.

## Decision

**Text chats, independent of channels.** A chat is not a LiveKit room and nobody joins one:
every approved account sees every chat. There is a default chat that can be renamed but
never removed. Admins add, rename and remove others, up to a limit that **starts at one** and
that **admins and the super admin** change, at runtime, up to a hard ceiling of 50. The limit
is a row in the SQLite `settings` table, not an environment variable, so raising it needs no
redeploy. Lowering it below how many chats exist removes none.

**The channel limit works the same way**, amending [ADR 0015](0015-channels.md): admins raise
or lower it at runtime, from the same `settings` table. `MAX_CHANNELS` is only where it
starts. Its ceiling is 20, not 50, because every client's channel poll asks LiveKit about
each channel every two seconds; a chat costs nothing while nobody writes in it.

**The chat list stays in SQLite**, beside the accounts that may change it. It is small,
read on every request, and needs the transactions and constraints ADR 0032 chose SQLite for
(one default chat, enforced by a partial unique index).

**Messages and read markers go to ScyllaDB**, a single node in its own container on the
compose network, with no published port.

- `messages` is partitioned by `(chat_id, month)` and clustered by a `timeuuid`, newest
  first. The id orders messages, says when each was sent, and is the paging cursor. The
  monthly bucket keeps any partition from growing without bound; paging back walks the
  months down to the one the chat was created in, which SQLite knows.
- `read_markers` holds each person's last read message in a chat, one partition per chat,
  so "seen by" is one small read. A marker is written with the message's own time as its
  write timestamp, so an older marker arriving late loses to a newer one by Scylla's
  last-write-wins, without a read-before-write or a lightweight transaction.
- **Writes are not buffered in the app.** Scylla already writes in two steps: every write is
  appended to its commit log for durability and applied to a memtable, which is later
  flushed to SSTables. An application-level log and memtable in front of it would do the
  same work twice and add a second place for a message to be lost or duplicated.
- Schema versions are an append-only list recorded in a `schema_migrations` table, as
  SQLite's are in `user_version`.
- The driver is `cassandra-driver`. Scylla speaks CQL natively.

**Chat is optional.** Without `SCYLLA_CONTACT_POINTS` it is off, and the app does not wait
for Scylla to start: if Scylla is down, chat is down and broadcasting carries on.

**Photos and videos** up to 10 MB a file are kept on the app's disk, in
`server/data/chat-media/<chat>/`, which `deploy.sh` already excludes. Each is a message of
its own, with an optional caption, and the message in Scylla carries only the file's id,
type, size and name.

- **What a file is comes from its bytes**, as for profile pictures
  ([ADR 0027](0027-profile-pictures.md)), never from its name or what the client says:
  PNG, JPEG, GIF and WebP images, and MP4 and WebM videos, the kinds Chromium shows inline.
  Anything else is refused, SVG and HTML included. The type is judged again when the file
  is served, with `nosniff` and a closed CSP.
- **Served only to signed-in people**, by chat and id, with Range requests so a video can
  be scrubbed. The desktop loads them from a scheme of its own, `zoia-media://`, which the
  main process answers with the session cookie, since a page cannot send it and a data:
  URL cannot seek.
- **Not in Scylla**: blobs in a wide-column store bloat its compaction, and the disk the
  rest of the data lives on already has room and backups.
- **Removing a chat removes its folder.**

## Why not SQLite for messages too

It would work at today's size, and ADR 0032's argument against a second service applies.
Scylla was chosen for the shape of the data: an append-mostly, time-ordered log read by
partition, where SQLite would serialise every message from every person through the one
write lock the server and keytool already share, and would grow the file the credentials
live in. Keeping messages out of `zoia.db` also keeps its backups small and its contents to
credentials and identities.

## Consequences

- **A second database service on the VM**, the cost ADR 0032 avoided: Scylla takes about
  1 GB of memory and a CPU core (`--smp 1 --memory 1G --overprovisioned 1`), beside
  LiveKit. It runs in developer mode, which skips the I/O tuning a shared VM disk would fail.
- **Two backups instead of one.** `keytool db:backup` covers `zoia.db`; messages need a
  Scylla snapshot of the `scylla_data` volume (see the runbook). `docker compose down -v`
  deletes every message.
- **CI starts Scylla** for the message store's tests, a minute or so per job. Locally they
  skip unless `SCYLLA_TEST_CONTACT_POINTS` is set.
- **One replica.** A disk failure loses the history; there is no second node to recover
  from. A three-node cluster is the remedy, and is not worth it for this.
- **Removing a chat deletes its messages** month by month, from its creation to now.
- **Photos and videos use the VM's disk with no quota** beyond 10 MB a file and the send
  rate limit. A busy chat can fill it; a cap per chat or an expiry is the remedy if it does.
- Scylla 2025.1 is under ScyllaDB's source-available licence, free at this size.
- The Android viewer does not show chat; it stays a viewer of broadcasts.
