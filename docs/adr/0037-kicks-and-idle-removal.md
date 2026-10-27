# 37. Kicking someone off the server, and removing the idle

- **Status:** accepted
- **Date:** 2026-10-26
- **Extends** [ADR 0033](0033-admins-move-people-between-channels.md), whose amendment lets admins disconnect someone from a channel

## Context

An admin can disconnect someone from their channel (ADR 0033), but the app stays open and
signed in: its chat stays connected, it keeps polling the channel list, and the person can
click straight back in. Someone who walked away from their computer is still "there", and
people sitting in a channel neither sharing nor watching anything make every channel look
busier than it is. We want stale people gone, without banning anyone.

## Decision

**A kick takes a machine off the server, not just out of its channel, and replaces the
disconnect in the app.** An admin right-clicks someone (in their own channel or another) and
chooses *Disconnect* from a menu headed with their name and picture, which is the check
against a misclick: there is no confirmation after, and no button for it on the row. The
app no longer offers ADR 0033's disconnect: a person put out of a channel but left connected
was the stale presence this is meant to end. `POST /api/admin/devices/:id/kick` follows the
disconnect's rules: any admin, on anyone but themselves. The server sends that machine a
message on `zoia.kick` with a reason, waits `KICK_GRACE_MS` (750 ms) for it to arrive, then
removes the machine and its hardware broadcast from its LiveKit room. The removal does not
depend on the app.

The app, told it was kicked, stops sharing, leaves the channel, and stops talking to the
server at all: no chat stream, no channel poll, no account checks. It shows a *Disconnected*
screen saying why, with a Reconnect button that puts it back where a launch would, in no
channel. It is not a ban; keeping someone out is still Revoke access.

**The server kicks whoever sits in a channel for 10 minutes neither sharing nor watching.**
Every minute it lists each channel's participants. Sharing is publishing a track, from the
person or their `-gpu` hardware broadcast. Watching is a non-empty `zoia.watching` attribute,
which each app sets to the broadcasts whose picture it is showing; LiveKit tells nobody who
subscribes to what, so the server cannot see it any other way. Idle for `IDLE_KICK_MINUTES`
(default 10; 0 turns it off) is a kick with reason `idle`. The clock restarts on any sharing
or watching, on a channel change, and on a server restart.

The Android viewer now sets `zoia.watching` too, to everyone whose screen it shows and every
camera put on its grid. Without it every Android viewer would look idle.

## Consequences

- The idle check trusts the app's attribute. A modified app can claim to be watching and
  stay; that costs nothing but a seat in a list, so it is not worth more than this.
- Someone only chatting, or only listening, in a channel with nobody live is idle by this
  definition and is kicked after 10 minutes. Chat works outside a channel, so they lose
  nothing but the channel, and Reconnect brings them straight back.
- A paused thumbnail does not count as watching, as for the broadcaster's eye.
- Apps from before this change ignore the `zoia.kick` message: an admin's kick, or the idle
  sweep, disconnects them from their channel, as ADR 0033's disconnect does. Android viewers
  from before it never announce watching, so they are kicked after 10 minutes in a channel.
- Broadcasters now see an eye for Android viewers watching them, which they never did.
- The timers live in memory. A restart forgets them, which errs towards keeping people.
- The message and the removal travel on different connections; the grace period is what
  makes the message usually win. If it does not, the app shows a channel disconnect instead.
