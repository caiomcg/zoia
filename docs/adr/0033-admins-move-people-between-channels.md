# 33. Admins move people between channels

- **Status:** accepted
- **Date:** 2026-10-18
- **Extends** [ADR 0031](0031-accounts-with-admin-approval.md)

## Context

Channels are separate LiveKit rooms (ADR 0015), and a client joins one only when it is
clicked. An admin looking after a session had no way to bring someone into the channel
where everyone else is, short of asking them to click it.

LiveKit has a server-side `MoveParticipant`. It moves the connection, but the app keeps
its own idea of which channel it is in: its token renewals, its stage and WHIP calls, and
the sidebar all follow the channel it joined. A participant moved underneath it would be
in one room while the app believed it was in another, and a broadcast would keep its
publish grant from the old room's stage.

## Decision

In the sidebar, a person is dragged onto a channel. Anyone may drag themselves, which is
the same as clicking that channel and asks nothing of the server. An admin may also drag
anyone they could manage in Settings › Accounts (ADR 0031's rules: admins manage users, the
super admin also manages admins, and nobody manages the super admin). So only someone
strictly below you can be dragged: two admins are equals, and each moves themselves.

Dragging someone else calls `POST /api/admin/devices/:id/move`, which moves one machine,
the one dragged, not every machine of the account. The server checks the caller's role and
the target as for every admin route. It then sends that participant a reliable LiveKit
data message, topic `zoia.move`, from the server itself. The app switches channel the way a
click would: sharing stops first, then the old room is left and the new one joined.

The app only acts on a `zoia.move` message with no sender. LiveKit always stamps a
participant's own data messages with that participant, so another client cannot forge one.

## Consequences

- Moving relies on the moved app's cooperation. An app older than this change ignores the
  message, and the server cannot tell: the admin sees no error, and the person stays put.
  It becomes reliable only as people update.
- A modified client could ignore a move. Moving is a convenience, not a security
  boundary; removing someone is Revoke access, which the server enforces by disconnecting
  every machine.
- The move happens as a click would, so a broadcast is stopped rather than carried over.
  Someone moved mid-share has to share again in the new channel.

## Amendment: disconnecting someone

An admin may also take someone out of the channel they are in: the sidebar shows a button on
the row of anyone else in their channel, and a right-click on their face in another channel
does the same, each after a confirmation. It calls `POST /api/admin/devices/:id/disconnect`,
and the server removes that machine, and its hardware broadcast, from its LiveKit room.

Unlike moving, **any admin may disconnect anyone else, other admins and the super admin
included**. Moving is administration of a person; disconnecting is keeping order in a
channel, which any admin present may need to do whatever the other person's rank. Nobody
disconnects themselves, which is what leaving is for, and plain users disconnect no one.

Unlike a move, this does not rely on the app: LiveKit drops the connection whatever the app
does. The app recognises the removal and leaves the channel, saying an admin disconnected
it, instead of treating it as a lost connection and trying again. It is not a ban: the
person can join a channel again at once, and keeping someone out is still Revoke access.

Since [ADR 0037](0037-kicks-and-idle-removal.md) the app no longer offers this: a right-click
kicks someone off the server instead. The route stays on the server.
