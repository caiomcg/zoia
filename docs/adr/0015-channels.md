# ADR 0015 — Channels

## Status

accepted

## Context

One room meant one conversation. With several people broadcasting at once
([ADR 0013](0013-multiple-broadcast-slots.md)), a group watching a game and a
group watching a film had to share a stage and a thumbnail strip, and had no way
to split up short of a second server.

## Decision

The server hosts channels. Each is its own LiveKit room with its own stage and
WHIP publisher; broadcasts are per channel.

There is always a **default channel**. Its room is `ROOM_NAME` (default `zoia`),
the room a single-room server already used, and every request that names no
channel lands there, so clients from before channels keep working unchanged. It
can be renamed but never removed.

**Anyone with a session may add a channel**, up to `MAX_CHANNELS` in total
(five by default, the default channel included), **rename any channel**, and
remove one that is empty and not the default. Nobody is thrown out of a channel
by someone else deleting it. Channels and renames are kept in
`server/data/channels.json`, which deploys never touch.

Every token, stage and WHIP request names its channel; one that does not exist
is refused with `404 unknown_room`, never created. The token's grant stays
subscribe-only whatever room it names. A person holds at most one broadcast slot
across all channels: claiming in one first releases a slot held in any other.
`GET /api/rooms` reports every channel with who is in it and who is live.

Switching channel stops the switcher's own broadcast, leaves the room and joins
the other; what they were watching or listening to does not follow them.

## Consequences

- Groups can watch different things on one server without seeing each other's
  broadcasts, and set that up themselves without an admin.
- There are no roles, so anyone can rename a channel out from under the people
  in it. With a group small enough to share one invite system, that is a social
  problem, not a technical one; the log records who did what.
- The channel list is polled (every 5 s on desktop, 10 s in the browser), so
  presence and names in other channels can lag by that much.
- `/api/rooms` asks LiveKit for every channel's participants per call. With five
  channels and a handful of clients this is negligible.
- Upstream bandwidth is still `broadcasts × viewers` summed over channels; more
  channels do not raise the ceiling.
