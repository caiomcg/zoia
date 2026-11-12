# 53. Blurring or replacing what is behind you on camera

- **Status:** proposed
- **Date:** 2026-11-11
- **Extends** [ADR 0034](0034-camera-beside-the-screen.md)

## Context

A camera goes out exactly as it sees: the room, the people walking through it, the laundry.
Video calls have taught everyone to expect a way to hide that, and without one some people
simply leave the camera off.

## Decision

**The background is blurred or replaced on the sender, before publishing.** The camera's
track gets LiveKit's background processor (`@livekit/track-processors`), which runs
MediaPipe's selfie segmenter on the GPU to find the person and blurs or replaces the rest.
Viewers receive the finished picture as an ordinary `Camera` track, so they, the Android
viewer included, and the server need nothing new. The processor is set before `publishTrack`,
so the unprocessed picture never goes out, not even for a frame.

**The choice is in the camera dialog**, with the preview showing the effect as viewers will
see it: none, a light or a strong blur, one of four pictures that come with Zoia, or an image
of your own. It is remembered on this machine and is off until chosen.

**While the camera is on, it is a row of the live card** in the sidebar, which now holds
whatever you share: how long you have been live, who is watching your screen, then a row for
the screen (switch, stop) and one for the camera (which camera, which background, a settings
menu, stop), and with both on a button that stops everything. Each row stops its own share
alone, as ADR 0034 keeps them apart. The camera's menu changes the background, and the device
when there is more than one, without turning the camera off: the same track and publication
carry on, so viewers keep watching, and LiveKit restarts the effect on the new device's
picture.

**An uploaded image stays on this machine.** It is scaled to fit 1280×720, kept as a JPEG in
the renderer's local storage, and never sent to the server: only the camera's picture with it
behind you goes out. The pictures that come with Zoia are gradients drawn at runtime, so there
are no image files to ship or license.

**Nothing is fetched from elsewhere.** By default the library loads MediaPipe's runtime from
jsDelivr and the model from Google's storage. Zoia serves both beside the page instead: the
model (`selfie_segmenter.tflite`, 244 KB) is committed under `src/renderer/public/mediapipe/`,
and the runtime (~9.6 MB) is copied from the installed `@mediapipe/tasks-vision` at build time
by a plugin in `electron.vite.config.ts`, so it always matches the installed version. Only the
SIMD build is shipped: Electron's Chromium always has SIMD.

If the effect cannot start, the camera goes out without it and says so, rather than not at all.
On a machine without WebGL2, the dialog says background effects are unavailable.

## Consequences

- The installer grows by about 10 MB, almost all of it MediaPipe's runtime.
- Segmentation costs GPU and some CPU on the sender while an effect is on. On a weak machine
  sharing a screen at the same time, that may cost frame rate; the effect is off by default
  for that reason.
- The cut-out is as good as MediaPipe's selfie model: hair and edges can flicker, more so in
  poor light.
- Your own preview shows the processed picture, so what you see is what viewers get. A track's
  `mediaStreamTrack` is still the raw camera, so anything drawing your own camera must go
  through `useShownTrack`.
- An uploaded image is per machine and per profile, like the rest of local storage. It does
  not follow the account to another computer.
