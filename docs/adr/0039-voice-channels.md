# 39. Voice in every channel

- **Status:** proposed
- **Date:** 2026-10-28
- **Amends** [ADR 0034](0034-camera-beside-the-screen.md), whose microphones start off for every viewer

## Context

A microphone exists only beside a camera, starts muted, and every viewer turns each person's
microphone on separately. That is right for a camera nobody asked to hear, and wrong for
talking: people want to sit in a channel and speak, as they do in Discord, with noise
suppression that removes a keyboard or a dog, a microphone of their choosing, levels that do
not jump, and shortcuts to mute.

Nobody may publish by default (AGENTS.md invariant 1). The stage grants `canPublish` to a
participant, not to a track, so a voice built on the stage's grant would also let everyone
in voice share a screen, and would make everyone in voice look like a broadcaster.

## Decision

**Every channel is a voice channel.** The app joins voice as soon as it connects to a channel
and leaves it with the channel; there is no button. Everyone in a channel hears everyone
else in it, and mutes or deafens rather than leaving. Android, listening only, is the one
exception until it plays voice.

**The server grants the microphone alone, at runtime.** `POST /api/voice/join` sets the
participant's permission to `canPublish` with `canPublishSources: [MICROPHONE]`, and the
`zoia.voice` attribute, in one update; `/api/voice/leave` takes both away. LiveKit enforces
the source list, so someone in voice cannot publish a screen or a camera. Join tokens still
publish nothing.

The two grants compose, because LiveKit replaces a permission whole:

- A microphone-only permission is not a broadcast slot. `broadcasters()` and the
  `canPublish` the stage reports ignore it, and a microphone alone is not "publishing".
- Claiming the stage from voice lifts the source limit; releasing it puts the microphone
  back, read from the attribute.
- Joining or leaving voice mid-broadcast changes only the attribute: narrowing the permission
  would end the broadcast.
- Being in voice is no activity for the idle sweep (ADR 0037), since everyone is in it.
  Talking is: the microphone on, with someone else in voice to hear it.

The attribute is the only record of who is in voice, so it leaves with the participant. A
client can set it itself; that gains nothing, since the microphone it unlocks on a release
is what joining voice gives anyone.

**Audio is never mixed on the server.** LiveKit is an SFU: each speaker sends one Opus
stream, and each listener receives everyone else's and mixes them locally. Noise
suppression, echo cancellation and gain therefore run on the speaker's machine, before the
encoder. Voice publishes as `Microphone`, mono, at the speech preset with DTX (silence costs
nothing) and RED (redundancy against loss). Shared screen audio keeps its music preset.

**Noise suppression is RNNoise,** in WebAssembly in an AudioWorklet
(`@sapphi-red/web-noise-suppressor`), on by default as "Enhanced", with Chromium's own
suppression as "Standard" and off as the third. Krisp, which Discord uses, comes to LiveKit
only as a filter that works against LiveKit Cloud, not a self-hosted server. It runs as
LiveKit's track processor, so a device or settings change rebuilds it with the capture:
capture (echo cancellation, gain) → RNNoise → the input gate → the encoder. The page's
policy allows `'wasm-unsafe-eval'` for it, and the model is bundled inline, never fetched.

**What is sent is decided on the sender:** by input sensitivity (a gate on the level after
suppression, faded rather than cut) or by push-to-talk. The speaking ring is worked out
locally from the sound itself, what you send and what you receive, not from LiveKit's
smoothed active speakers.

**Each listener sets each voice's volume** for themselves, up to twice as sent, kept per
person on their machine.

**One microphone per person.** In voice, a camera shares the voice microphone instead of
opening another. Everyone in voice hears everyone in voice without turning them on; ADR
0034's "off until you turn it on" stays for the microphone of a camera shared by someone
not in voice.

**Shortcuts work while Zoia is in the background:** push-to-talk, mute and deafen, bound to
keys, combinations or mouse buttons. Electron's global shortcuts take keys only and have no
key-up, so main uses a native input hook (`uiohook-napi`), loaded optionally like the WASAPI
capture and running only while something is bound. A short tone confirms a mute or deafen
done from a shortcut.

**Android listens.** It plays everyone in voice and publishes nothing.

## Consequences

- A listener downloads one stream per person speaking. DTX keeps the silent near zero, so
  the cost is set by how many talk at once, not by how many are in voice.
- Everything that decides who holds a slot must read the source list, not `canPublish`
  alone. A new check written against `canPublish` would count everyone in voice.
- Echo cancellation only cancels what Chromium plays. Playing a stream out of one device
  while the microphone's echo reference is another can let it echo.
- RNNoise costs each speaker a little CPU and is weaker than Krisp on some noises; a heavier
  model (DeepFilterNet) is the next step if it is not enough.
- The input hook needs Accessibility permission on macOS; without it there are no shortcuts,
  and Settings says so.
- The hook sees every key pressed while it runs. It keeps nothing and acts only on what is
  bound, which is why it runs only while something is.
- Older apps do not know the attribute: they see someone in voice as a microphone they can
  turn on, as for a camera.
