# ADR 0015 — Channels

## Status

accepted

## Context

One room meant one conversation. With several people broadcasting at once
([ADR 0013](0013-multiple-broadcast-slots.md)), a group watching a game and a
group watching a film had to share a stage and a thumbnail strip, and had no way
to split up short of a second server.

## Decision

The server hosts a fixed set of channels, five by default. Each channel is its
own LiveKit room with its own stage and WHIP publisher; broadcasts are per
channel. `ROOMS` lists them as `id:Label` pairs; without it the first channel
keeps `ROOM_NAME` (default `zoia`) as its id, so an existing single-room
deployment's room carries on as the first channel.

Every token, stage and WHIP request names its channel. A request naming none
means the first channel, which is what a client from before channels sends; a
request naming one that is not configured is refused with `404 unknown_room`,
never created. The token's grant stays subscribe-only whatever room it names.

A person is in one channel at a time, and holds at most one broadcast slot
across all of them: claiming in one channel first releases a slot held in any
other. `GET /api/rooms` reports every channel with who is in it and who is live,
so clients can show where people are before joining.

Switching channel stops the switcher's own broadcast, leaves the room and joins
the other; what they were watching or listening to does not follow them.

## Consequences

- Groups can watch different things on one server without seeing each other's
  broadcasts.
- The set of channels is configuration, not something users create at runtime.
  Adding or renaming one is an edit to `ROOMS` and a restart.
- The channel list is polled (every 5 s on desktop, 10 s in the browser), so
  presence in other channels can lag by that much.
- `/api/rooms` asks LiveKit for every channel's participants per call. With five
  channels and a handful of clients this is negligible; with many more of either
  it would want caching.
- Upstream bandwidth is still `broadcasts × viewers` summed over channels; more
  channels do not raise the ceiling.
