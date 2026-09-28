# 25. A macOS desktop client with system audio

- **Status:** accepted
- **Date:** 2026-09-28
- **Amends:** [ADR 0006](0006-native-desktop-client.md), [ADR 0009](0009-hardware-encoding.md)

## Context

The desktop app was Windows x64 only. Everything that made it so sits on the *broadcast*
side:

- per-application audio is WASAPI process loopback (`loopback-capture`), which exists only on
  Windows;
- the hardware path is Windows Graphics Capture into NVENC (the `native/` addon) plus a
  vendored `ffmpeg-gnutls.exe`, all D3D11;
- `node-window-manager`, used to map a capture source to its owning process, does build on
  macOS.

Watching, pairing, channels, the camera, the updater's discovery and the stage are plain
Electron and LiveKit and have nothing Windows-specific in them.

The reason the Windows app bypasses Chromium's encoder ([ADR 0009](0009-hardware-encoding.md))
is that Chromium has no hardware encoder *on Windows*. On macOS it does: its WebRTC H.264
encoder is VideoToolbox.

## Decision

Ship a macOS build (arm64 and x64 `.dmg`) that uses only the ordinary Chromium path:

- **Video** goes through `getDisplayMedia` and LiveKit, as on Windows with hardware encoding
  off. `capture.ts` does not try to load the addon off Windows, so `hardwareEncoder` is false
  and the renderer never selects the WHIP path.
- **One video layer, no simulcast.** Measured on an M1 with Electron 44: a single H.264
  layer is encoded by VideoToolbox (`powerEfficientEncoder: true`), but as soon as a second
  simulcast layer is added Chromium encodes *both* with OpenH264 in software. In a real share
  that showed as skipped frames and 25–50 fps against a 58 fps target. A Mac screen share
  therefore publishes only the full layer; viewers lose the 360p layer used for unfocused
  tiles and weak connections. The camera keeps simulcast.
- **System audio, not application audio.** `loopback-capture` is an optional dependency,
  loaded lazily and only on Windows. On macOS the display-media handler answers with
  `audio: 'loopback'` (ScreenCaptureKit), and the renderer publishes that track as the share's
  audio, for screens and windows alike, since a window's audio cannot be isolated this way.
  Measured on macOS 26 / Electron 44 (the typings still call it Windows-only): by default the
  track is mono with echo cancellation, noise suppression and AGC on, and it includes Zoia's
  own playback, so viewers would hear each other echoed back. The request sets
  `channelCount: 2`, turns the three off, and sets `restrictOwnAudio: true` (Zoia's own
  output measured at peak 0.80 without it, 0.00 with it). The banner says every time that
  the whole system is being sent.
- **Screen Recording permission** is macOS's to grant. Without it `desktopCapturer` fails with
  "Failed to get sources."; the picker replaces that with where to turn it on.
- **Updates** always point at the release page. The OTA swap is Windows plumbing (a `.bat`
  runner, `elevate.exe`), and rewriting `app.asar` inside a signed bundle breaks its seal.
- **Ad-hoc signed**, not Developer ID: there is no Apple account behind the repo. Apple
  Silicon will not run unsigned code at all; ad-hoc is enough for that, and Gatekeeper still
  asks on first open.
- The standard app, edit and window menus stay on macOS. Removing the menu, as Windows does,
  also removes Cmd+C/Cmd+V from every text field.

## Consequences

- A Mac can watch, use the camera, and share a screen or window, hardware-encoded, with the
  system's audio. That departs from Windows, where a screen share is deliberately silent:
  on a Mac the choice is system audio or none, and none was the complaint.
- Notifications and every other app go out with a Mac share. Per-application audio would
  need a native module over a Core Audio process tap (macOS 14.2+).
- Without notarization every download shows Gatekeeper's warning, and a translocated app may
  not find an invite placed beside it; dropping the invite on the window always works.
- Release CI gains a `macos-15` job, and a release carries two `.dmg` files and
  `SHA256SUMS-macos.txt` next to the Windows installer.
