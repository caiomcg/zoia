# 6. A native desktop client, for per-application audio

- **Status:** accepted
- **Date:** 2026-09-21

## Context

The browser client worked. People could join, watch, and claim the stage. It could not do
the single thing the project existed for: **send the audio of one application.**

This is not a gap in the implementation. A web page gets exactly two kinds of audio:
whatever the user picks in the `getDisplayMedia()` dialog — a tab, or the whole desktop mix
— and microphone-style input devices. There is no web API for "the sound of that window",
and there deliberately never will be, because it would let any page listen to everything you
play.

The workarounds are all bad in the same way. A virtual audio cable means every viewer's
friend installs a driver and rewires their default output. Sharing the whole desktop mix
sends notifications, other calls, and whatever music happens to be playing. Muting
everything else defeats the purpose of sharing a game.

Discord in a browser has this same limit. Discord's *desktop* client does not, because a
native process can call into the OS audio stack.

## Decision

Ship a native app: Electron on Windows, calling **WASAPI process loopback**
(`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Windows 10 2004+) to capture one process's
output directly. No virtual device, no mixing, nothing for the viewer to install.

The server is unchanged — same SFU, same stage model, same token issuer. This decision is
about where capture happens, not about the protocol.

The pieces that make it work:

| Problem | Answer |
|---|---|
| Capture one process's audio | `loopback-capture`, a native addon — S16LE stereo 48 kHz |
| `desktopCapturer` gives titles, loopback needs a **PID** | `node-window-manager` bridges window → `processId` |
| PCM arrives in **main**, LiveKit needs a track in **renderer** | IPC → `AudioWorkletProcessor` → `MediaStreamAudioDestinationNode` |

## Why the audio path is built the way it is

The capture clock (WASAPI) and the playback clock (`AudioContext`) are not the same clock,
so a ring buffer between them drifts in one direction or the other forever. Two details
decide whether this sounds correct or sounds broken, and both were settled by measurement
rather than theory:

- **The `AudioContext` is pinned to 48 kHz**, matching WASAPI. Letting it default to the
  device rate inserts a resampler, and a resampler is a drift source nobody asked for.
- **Underrun and overrun are handled explicitly in the worklet**, with a priming cushion
  before playback starts and a hard latency ceiling that drops the oldest frames rather than
  letting the offset grow all session. Without the cushion, the first seconds of every
  broadcast were audibly choppy; without the ceiling, audio drifted steadily behind the
  picture over ten minutes and never recovered.

Both are counted and surfaced in the UI, because "is audio actually flowing" should be
answerable without a second machine on a call.

## Consequences

- **Windows x64 only.** WASAPI process loopback has no macOS or Linux equivalent, so phones,
  Macs and Linux lose access entirely — including people who could previously watch in a
  browser. This is the real cost of the decision, and it was taken knowingly.
- Windows 10 build 19041 (2004) is the floor. Older builds fall back to whole-system audio.
- The project gains a native toolchain: node-gyp, a C++ addon, and platform-specific builds
  that CI on Linux cannot exercise.
- Distribution becomes a real problem rather than a URL, which is what
  [ADR 0007](0007-device-pairing.md) is about.
- Sharing a *screen* is silent on purpose. A screen has no owning process, so the only audio
  it could carry is everything at once — exactly what this decision set out to avoid.
