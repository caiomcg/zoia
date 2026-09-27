# ADR 0020 — Sender-side audio controls replace the monitor

- **Status:** accepted
- **Date:** 2026-09-27
- **Supersedes:** the monitoring bullet of [ADR 0018](0018-local-audio-controls.md)

## Context

A broadcaster had two audio controls on their own share, and neither did what the position
suggested. The speaker and slider at the bottom only changed the local *monitor*, which
plays your own capture back through your speakers. Muting what viewers heard needed a
separate button laid over the picture. In practice the monitor was not usable: people read
the speaker as "mute my stream", and the headphones as noise.

## Decision

- On your own share, the footer's speaker and slider set **what viewers hear**. The slider
  drives a gain node between the capture worklet and the published track. The speaker mutes
  the LiveKit track, so the track stays published and unmuting is instant.
- The level and mute last for the session and carry across source switches, so switching
  windows does not unmute behind your back.
- A camera's microphone has no gain stage, so it gets the mute but no slider. The camera
  dialog's "mute microphone" option (ADR 0018) sets the same mute, so the two agree.
- The monitor is removed, including its gain node and the `canMonitor` flag.

Your share uses the same footer as a broadcast you watch. Only the controls differ.

## Consequences

- There is no longer a way to hear your own capture without a second device. That was the
  monitor's one real use, and it is gone with it.
- A viewer's volume (ADR 0018) and the sender's volume multiply. A sender at 50% and a viewer
  at 50% gives 25%, and neither can see the other's setting.
- Mute is signalled to LiveKit, so viewers' clients know the track is muted rather than
  receiving silence.
