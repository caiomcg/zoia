# 42. Deleted messages leave the disk an hour later, not ten days

- **Status:** proposed
- **Date:** 2026-10-29

## Context

Messages can be deleted: by whoever wrote them, by an admin, and now by an addon cleaning up
after itself (ADR 0041). Zouve, the music addon, deletes the `!play` commands typed to it and
its own replies when it leaves voice, so a chat is not filled with them, and so they do not
take space for nothing.

A delete in ScyllaDB (ADR 0036) does not free space when it runs. What was found on the
production server, `system_schema.tables` for the `zoia` keyspace:

| Table | `gc_grace_seconds` | Compaction |
|---|---|---|
| `messages` | 864000 (ten days) | `IncrementalCompactionStrategy` |
| `reactions` | 864000 | `IncrementalCompactionStrategy` |
| `read_markers` | 864000 | `IncrementalCompactionStrategy` |

- A `DELETE` writes a **tombstone**: a marker saying the row is gone. Reads stop returning
  the row at once, so for everyone the message is deleted. The row's data stays on disk,
  and the tombstone takes some of its own.
- Data and tombstone leave the disk only when a **compaction** rewrites the files holding
  them, **and** the tombstone is older than `gc_grace_seconds`. Until both, the space is
  held.
- The ten days are Scylla's default. They exist for clusters: a replica that was down when
  a delete ran must be repaired within that window, or, once the tombstone is gone, it
  would hand the deleted row back to the others. The keyspace here has **one replica**
  (`replication = {'class': 'NetworkTopologyStrategy', '<dc>': 1}`): there is no other copy
  to miss a delete.

So, as it stood, every deleted message took its space for at least ten days.

## Decision

**Messages and reactions keep tombstones for an hour** (`gc_grace_seconds = 3600`), by a
schema migration in `server/src/scylla.js`. Read markers are left as they are: a person
has one per chat and they are overwritten, not deleted.

An hour rather than none: a delete and a late write to the same row in the same moment
still resolve the same way, and nothing depends on it being shorter.

## Consequences

- A deleted message's space is reclaimed at the **first compaction after an hour**. On a
  quiet table, compaction may not touch those files for a while, so "an hour" is the
  earliest, not a promise; `nodetool compact zoia messages` forces it.
- The saving is small. A command and its answer are a few hundred bytes; a thousand of
  them are well under a megabyte. The point is that deleting does what it says, and that
  space does not grow with what nobody can see any more. Photos and videos are files on
  the app's disk (ADR 0036) and were always removed at once.
- **If the keyspace ever gets more than one replica, this must go back up** to at least the
  interval between repairs (the default is ten days), and repairs must run. Otherwise a
  replica that missed a delete brings the message back. AGENTS.md says so beside the
  other environment gotchas.
