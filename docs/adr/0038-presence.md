# 38. Who is on the server, and their status

- **Status:** proposed
- **Date:** 2026-10-28
- **Extends** [ADR 0036](0036-text-chat-in-scylladb.md), whose live stream it is read from

## Context

The sidebar shows who is in each channel, from LiveKit, and nothing else. Someone with the
app open but in no channel, reading or writing in the chats, is invisible to everyone, and
there is no way to say "I'm here but busy" or "I've stepped away". We want to see who is on
the server, and let each person choose how they appear.

## Decision

**Being on the server is having the chat's live stream open.** Every signed-in desktop app
holds `GET /api/chats/events` while it runs (ADR 0036), so an account with at least one
open is connected, with no new connection or heartbeat to add. `src/presence.js` counts
streams per account and machine, in memory, in the one app process, as the hub does. When
the last stream closes, the person stays shown for `OFFLINE_GRACE_MS` (15 s) before going
offline, so a network blip or a reconnect does not make them blink out for everyone.

**Each person chooses a status: online, busy, away or invisible.** It is kept on the account
(`accounts.presence`, null for online), so it holds across machines and restarts, and is set
with `PUT /api/presence`, by the person only. What everyone else sees is one of online,
busy, away or offline: invisible is shown as offline, and only its owner knows otherwise.

**Online turns to away by itself after 5 minutes without using the computer.** The app reads
the system's idle time (Electron's `powerMonitor`), so typing in another program counts as
being there, and a locked screen is idle at once. It tells the server with
`POST /api/presence/idle` when that changes, and again whenever its stream reconnects,
since the server forgets a machine with its last stream. Someone is away only when every
machine they have connected is idle. A chosen busy or away is left as it is: idleness only
ever changes online.

**Changes go out on the chat's stream** as a `presence` event, `{ accountId, status }`, only
when what others see changes. `GET /api/presence` gives the asker's chosen status and
everyone not offline; the app reads it when its stream connects or reconnects.

In the app, your picture in the sidebar's footer carries your dot and opens the menu to
choose; your status is written under your name. A *People* section under the chats lists
everyone let in, those there first with their dot, then everyone offline, dimmed.
Collapsed, it shows only those there.

## Consequences

- Statuses need chat: against a server without ScyllaDB configured, or an older server,
  the app shows none of this.
- The Android viewer does not open the chat's stream, so someone only on Android shows as
  offline. Opening it there, or a signal of its own, is for later.
- Everything but the chosen status is in memory. A restart shows everyone offline until
  their apps reconnect, which they do within seconds, and online until each idle machine
  says so again on reconnect.
- Busy says so and nothing more: it does not yet silence sounds or mentions.
- There is no "last seen". It would tell others when someone invisible was last there.
