# ADR 0022 — Unified League of Legends streaming and bidirectional handoff

- **Status:** accepted
- **Date:** 2026-09-27
- **Supersedes:** [ADR 0019](0019-league-window-handoff.md)

## Context

ADR 0019 designed an automatic handoff from the League of Legends lobby to the
game match window. In real-world sessions, several assumptions broke down:

1. **Process ownership on Windows:** League's Chromium Embedded Framework (CEF)
   UI process that owns the actual Win32 window `HWND` is `LeagueClientUx.exe`,
   not `LeagueClient.exe` (a background parent process). Matching only on
   `LeagueClient.exe` meant the handoff mode was never triggered on standard
   client sessions.
2. **Starting from inside a match:** Broadcasters frequently start sharing
   while already in-game. ADR 0019 only initialized the handoff if the launcher
   window was shared first, so starting in-game left the broadcast pinned to the
   game with no fallback when the match finished.
3. **Match exit race condition:** When `League of Legends.exe` closes upon match
   conclusion, the capture track emits `ended` before the launcher window is
   restored or detected. Treating that event as an immediate broadcast
   termination dropped the broadcast instead of returning to the post-game lobby.
4. **Picker ambiguity:** Broadcasters were presented with multiple confusing
   tiles in the window picker (`"League of Legends"` and `"League of Legends (TM) Client"`),
   with no automatic priority resolution.

## Decision

Provide a unified League of Legends streaming experience matching Discord's
behavior:

1. **Priority rule:** If the game match window is open (`League of Legends.exe`
   or `"League of Legends (TM) Client"`), capture opts for the game. Otherwise,
   capture opts for the client launcher window (champion selection / lobby).
2. **Bidirectional handoff:** Broadcasters can start sharing from either the
   champion selection screen or while already in a match. Transitions run in
   both directions:
   - While streaming the client, detecting the game window switches video and
     process audio to the match.
   - When the match ends and its window closes, video and process audio return to
     the launcher window.
3. **Resilient post-game recovery:** When the game window closes, capture does
   not immediately terminate. It polls for the client window across a short
   grace period (up to 7.5 seconds) to allow League's client window to recreate
   or regain focus.
4. **Process and title resolution:** Windows are identified primarily by their
   owning executable (`LeagueClientUx.exe`, `LeagueClient.exe`, or
   `League of Legends.exe`), with fallback matching on the window title when
   Win32 process paths cannot be resolved.
5. **Picker UI:** When any League window is active, the source picker presents a
   prominent game banner with a one-click "Transmitir LoL" action, displaying
   whether the game or the client is currently prioritized. Clicking any League
   window in the grid automatically applies the priority rule.

## Consequences

- Broadcasters can start sharing League of Legends at any point (in lobby,
  during champion select, or in-game) without managing windows manually.
- The transition between lobby, match, and post-game screens happens
  automatically without dropping the broadcast or requiring picker interaction.
- Process audio follows the active window automatically (switching between game
  sounds and client/champ-select audio).
- The client window has time to restore after a match without aborting the
  stream.
- A manual switch to a non-League source cancels the automatic handoff.
