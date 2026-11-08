# 44. An away channel, muted and silent, with a longer idle limit

- **Status:** proposed
- **Date:** 2026-10-31
- **Amends** [ADR 0037](0037-kicks-and-idle-removal.md), whose idle limit was the same in every
  channel, and [ADR 0039](0039-voice-channels.md), where being in a channel is being in its voice

## Context

People step away from the computer with Zoia open. In an ordinary channel they are in voice,
so anything their microphone picks up goes to everyone, and after `IDLE_KICK_MINUTES` the
server takes them out. There was nowhere to park while away: somewhere quiet, where staying a
while is expected.

## Decision

An admin may make one channel, never the default, the **away channel**, in Settings › Server.
The server keeps the choice on the channel's record (`away`), lists it in `/api/rooms`, and
changes it at `PUT /api/rooms/away` (`{ channel: id | null }`, admins only).

In the away channel:

- **Nobody is in voice.** The app does not join it there, and leaves it when the channel you
  are in becomes the away channel. So nobody is heard and nobody hears anyone. Zumbido needs the
  sender in voice with the microphone on (ADR 0040), so it is silent there too.
- **Nobody shares.** The screen and camera buttons are disabled, and a share running when its
  channel becomes the away channel is stopped.
- **The idle limit is `AWAY_KICK_MINUTES`,** an hour by default, not `IDLE_KICK_MINUTES`. Since
  nobody talks or shares there, the clock in effect runs from arriving.

The channel shows a moon where others show a screen, and the voice panel reads "Away · muted".

## Consequences

- **The rules are the app's, not the server's.** The server does not refuse a claim or a voice
  grant in the away channel. AGENTS.md asks for rules to be enforced on the server; this was
  chosen for now, knowingly. An app from before this ADR, or one changed to ignore it, can still
  talk and share there. Refusing `/api/stage/claim`, `/api/voice/join` and an addon's bot voice
  token for the away channel would close that, and is the natural next step if it matters.
- An addon's bot can still be put in voice there: bots have no app to keep them out.
- Idle people in other channels are still kicked, not moved to the away channel. Moving them
  there instead is a separate decision; see the amendment below.
- Android viewers do not know the flag. They never publish (they only watch), so this changes
  nothing they do.

## Amendment: the idle go to the away channel, and only when away from the computer

Two things changed in the idle sweep (ADR 0037).

**Using the computer is activity.** Someone in a channel with the app open, playing a game
or working while they listen, was put out after `IDLE_KICK_MINUTES` like someone who had
walked away, because they neither shared, watched nor had their microphone open. The sweep
now also asks the presence of ADR 0038 whether the machine is in use: its app has the chat's
stream open and has not reported being idle, that is, the system has had keyboard or mouse
input in the last 5 minutes and the screen is not locked. A machine in use is never idle.
Machines that report nothing (Android viewers, apps against a server without chat) are judged
as before.

**With an away channel, the idle go there instead of out.** When someone reaches
`IDLE_KICK_MINUTES` in any other channel, the server sends their app the same `zoia.move`
message an admin's move sends, with `reason: "idle"`, and the app switches to the away
channel and says why. There, `AWAY_KICK_MINUTES` counts from arriving, and after it they are
disconnected as before. Without an away channel, the idle are disconnected as before.

- An app that does not switch (an Android viewer, which ignores `zoia.move`) is still in its
  channel at the next sweep, a minute later, and is disconnected then, unless it has done
  something in the meantime. Older desktop apps switch, as for an admin's move, but say
  nothing about why.
- The idle report trusts the app, like `zoia.watching`. A modified app can claim to be in use
  and stay; that costs a seat in a list, as before.
- Coming back to the computer does not bring anyone back to their old channel: they pick it,
  as the notice says.
