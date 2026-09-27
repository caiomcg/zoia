# ADR 0018 — Local audio controls for camera and remote broadcasts

- **Status:** accepted
- **Date:** 2026-09-27

## Context

Camera sharing captures a microphone alongside the video, but a user may want
to share only the camera image. Conversely, viewers need to control the volume
of each remote broadcast independently, without changing what other viewers
hear or changing the publisher's source audio.

The application already has separate local and remote LiveKit tracks. Sending
mute or volume preferences through the server would add state that is private
to one user's device and could accidentally affect other participants.

## Decision

- Camera sharing presents a user-controlled "mute microphone" option before
  publishing. The choice is applied to the local microphone track when the
  camera starts and is persisted locally for the next camera share.
- Each remote broadcast has its own local volume and mute state. The state is
  applied to that viewer's playback element and persisted in the renderer's
  local storage, keyed by the remote participant.
- Monitoring of locally captured application audio uses the same local mute and
  volume controls, so a broadcaster cannot accidentally monitor audio that is
  muted for them. Monitoring remains unavailable for whole-system capture,
  where it would create an echo path.
- These controls do not change LiveKit publication permissions, server stage
  ownership, or the audio sent to any other viewer. They are playback/capture
  preferences owned by the current desktop client.

## Consequences

- A camera can be shared silently without requiring a separate microphone
  device or server-side flag.
- Every viewer can mix or silence broadcasts according to their own needs.
- Preferences survive component remounts and reconnects on the same device.
- Local storage is device-local and is not synchronized between devices or
  invite keys.
- A publisher cannot control another viewer's playback volume, and a viewer's
  mute cannot stop audio from being published to other viewers.
- Monitoring and capture behavior remain subject to the browser/Electron audio
  constraints described in [ADR 0006](0006-native-desktop-client.md).
