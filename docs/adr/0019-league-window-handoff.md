# ADR 0019 — Automatic League window handoff

- **Status:** accepted
- **Date:** 2026-09-27

## Context

League of Legends uses two application processes during a normal session. The
launcher, `LeagueClient.exe`, owns champion selection and other lobby screens,
while `League of Legends.exe` owns the game itself. The game window can appear
after the user has already started sharing the launcher and can disappear again
when the match ends.

Keeping the original window selected would leave viewers watching the lobby
while the game is running. Requiring the broadcaster to stop and select a new
window would interrupt the broadcast and is easy to forget.

## Decision

When a window belonging to `LeagueClient.exe` is selected, the desktop client
enters a League handoff mode:

1. The launcher remains the fallback capture.
2. The source list is periodically inspected for a visible window belonging to
   `League of Legends.exe`.
3. While the game window exists, capture and its process audio are switched to
   that window.
4. When the game window disappears, capture and audio return to the launcher.

The processes are identified from the executable path resolved by the native
window enumeration, not from a localized or mutable window title. The handoff
keeps the existing LiveKit stage claim and is implemented in both the Chromium
WebRTC path and the native hardware/WHIP path. A regular manual source change
disables the League-specific handoff.

## Consequences

- Viewers automatically follow the actual game instead of remaining on the
  launcher screen.
- Lobby, loading, and post-game screens remain available as the fallback.
- The broadcaster does not need to interact with the picker during a match.
- Switching native capture sources can briefly interrupt video while the new
  window capture and its process audio are initialized.
- The behavior depends on Windows exposing the executable path and visible
  window through the native enumeration; it is not a generic game launcher
  detector.
- The feature currently recognizes these exact executable names and does not
  infer other games' launcher relationships.
