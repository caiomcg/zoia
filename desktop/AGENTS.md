# desktop/AGENTS.md

The Electron app for Windows and macOS: the only client that watches and shares (ADR 0021).
Root [AGENTS.md](../AGENTS.md) holds the invariants; [README.md](README.md) the build details.

## Shape

- `src/main` owns all server communication and secrets (credential in `safeStorage`, HTTP via
  `net.fetch` on the cookie-aware default session), capture, encoding and updates.
- `src/preload` exposes a narrow, typed bridge (`window.zoia.*`); its types are in `index.d.ts`,
  IPC channel names in `src/shared/ipc.ts`.
- `src/renderer` is a plain React app that never sees a secret — only a LiveKit token or a
  stage result.
- `src/shared/i18n/` holds the UI strings. A new string goes in `en.ts` **and** every other
  language file (ADR 0023).
- `native/` is the Windows capture addon (WGC + NVENC/AMF); `ffmpeg/` the packaged encoder.

## Installing and running

- **Always `npm install` / `npm ci` here from Windows** (PowerShell or cmd, or `cmd.exe /c` from
  WSL). `node_modules` holds native binaries; a WSL install swaps in Linux ones and the failure
  looks like "no audio", not like an architecture error. WSL is fine for `tsc`, eslint, prettier.
- Run from source with `npm run dev` (electron-vite, hot reload). If it fails with "Electron
  uninstall", run `node node_modules\electron\install.js` first.
- The native addon needs Windows SDK **10.0.26100.0** or later: `addon.cpp` uses
  `GraphicsCaptureSession::MinUpdateInterval`, which 10.0.22621 lacks (error C2039). Build from a
  VS dev prompt pinned to it (`VsDevCmd.bat -arch=amd64 -winsdk=10.0.26100.0`).
- `make-exe.bat` builds the NSIS installer and also leaves `release\win-unpacked\Zoia.exe`; test
  with that rather than installing over a working copy. It kills a running Zoia when it starts.

## Hot reload breaks on these edits

While someone is testing under `npm run dev`, these saves blank the window (and drop them from
voice). Relaunch the dev client after them:

- Any file under `src/shared/i18n/` — components then throw `useT() used outside I18nProvider`.
- The preload bridge or a main-process IPC handler — the renderer reloads, the old preload stays,
  and `window.zoia.<new>` is undefined.
- A file importing something not written yet: write new modules and exports **before** the
  files that import them.

## Platform rules

- **Windows sends per-app audio; macOS sends system audio.** `loopback-capture` (WASAPI) is an
  optional dependency loaded only on Windows. macOS uses ScreenCaptureKit loopback with
  `restrictOwnAudio`, which must stay or viewers hear themselves echoed (ADR 0025).
- The WGC/NVENC addon and ffmpeg are not packaged for Mac. Anything added to the broadcast path
  must degrade on `process.platform !== 'win32'` rather than throw at import time
  (`src/main/optional-module.ts`).
- Selecting several broadcasts downloads several independent streams; only one stream's audio
  is active by default.
- What the desktop publishes (track sources, the `-gpu` ingress, metadata) is what other viewers
  receive. The Android viewer is on hold, but see [android/AGENTS.md](../android/AGENTS.md) if
  it comes back.
