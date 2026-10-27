# 36. Text chat, with its messages in ScyllaDB

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
never removed. Admins add, rename and remove others, up to a limit that **starts at ten** and
that **admins and the super admin** change, at runtime, up to a hard ceiling of 50. The limit
is a row in the SQLite `settings` table, not an environment variable, so raising it needs no
redeploy. Lowering it below how many chats exist removes none. Both limits are changed in
the app's Settings › Server, which only admins see, rather than beside the sidebar's headings.

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
- **The message store's tests need a real Scylla**, and skip without
  `SCYLLA_TEST_CONTACT_POINTS`. CI runs them in a job of their own that is advisory and
  stops after ten minutes, so a slow or stuck database never holds up a deploy; the other
  jobs, the coverage floor included, run without Scylla.
- **One replica.** A disk failure loses the history; there is no second node to recover
  from. A three-node cluster is the remedy, and is not worth it for this.
- **Removing a chat deletes its messages** month by month, from its creation to now.
- **Photos and videos share one cap on disk**, 5 GB by default (`CHAT_MEDIA_CAP_GB`), across
  every chat. Past it the oldest files are deleted first, whichever chat they are in, so they
  cannot fill the disk the database also uses. Their messages stay, and the app says the
  photo or video is no longer available. A restart reads the sizes and ages back from disk.
  Profile pictures are not counted: one small file per device, replaced in place.
- Scylla 2025.1 is under ScyllaDB's source-available licence, free at this size.
- The Android viewer does not show chat; it stays a viewer of broadcasts.

## Amendment: replies and @mentions

A message may answer another and @mention people. Both are columns on `messages` (schema
version 3), as JSON text like `attachment`:

- **`reply_to`** is a snapshot of the message answered: its id, author, author's name and its
  first 200 characters. Messages are never edited, so the snapshot cannot go stale, and the
  reply shows it without a second read. The server checks the original is in the same chat,
  which is one read by the full key, since a message id says which month holds it.
- **`mentions`** is `[{ id, name }]`. The app sends the account ids picked from its @ list;
  the server keeps only people who are let in and whose `@Name` is in the text, so a mention
  cannot be hidden in a message that does not show it. Names are unique on a server, which
  is what makes `@Name` unambiguous.

`GET /api/chats/people` lists who can be mentioned, by name and picture, never email, to any
approved session. A mention only highlights the message for that person; it sends no
notification of its own.

## Amendment: deleting messages

The author of a message may delete it, and so may any admin or the super admin, anyone's;
the server checks which on `DELETE /api/chats/:id/messages/:messageId`. The row is deleted
by its full key, and a photo or video goes with it, freeing its share of the media cap.
Every open app is told on the live stream and takes it out at once.

A reply keeps a snapshot of what it answered, which would outlive a deletion. So when a page
is read, each reply's original is looked up, one read by full key per reply on the page, and
a reply to a deleted message keeps only that it answered something now deleted. Deletion is
final: there is no undo, and an admin's deletion of someone else's message is logged by id.

## Amendment: reactions

Anyone may react to any message with an emoji and take their own reaction off again, with
`PUT` and `DELETE /api/chats/:id/messages/:messageId/reactions/:emoji`. Both are harmless to
repeat, and only an actual change goes out on the live stream, as a `reaction` event.

Reactions are a table of their own (schema version 4), `reactions`, keyed
`((chat_id, bucket), message_id, emoji, account_id)`: the same partition as the message, so a
page's reactions are one `IN` read per month the page spans, and deleting a message or a
chat deletes its reactions with the same keys. Each row keeps when it was made, so emoji show
in the order first used. A counter or a set column on `messages` was not used: a counter
cannot say who reacted, and a collection on the message row would need a read-modify-write
for every reaction.

The server takes one emoji per reaction — a single grapheme that is a pictograph, flag or
keycap — never free text, and at most 20 different emoji on one message; adding to an emoji
already there is always allowed. Reactions have their own per-person rate limit, apart from
sending, so reacting never stops anyone answering.
