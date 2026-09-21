# Zoia Desktop

The broadcaster client: screen and (soon) per-application audio over WebRTC,
paired to a Zoia server with a token embedded at build time.

## Build and run on Windows only

This app targets **Windows x64**. `node-window-manager` compiles a native
addon from source (needs MSVC + Python — Visual Studio Build Tools with the
"Desktop development with C++" workload), and `loopback-capture`'s per-process
WASAPI capture only works there at all.

`node_modules` holds compiled native code, so **always run `npm install` from
Windows** (PowerShell or cmd), never from WSL/Linux — installing from the
wrong OS silently swaps in Linux binaries for the same on-disk `node_modules`,
and `npm run build`/`dev` will then fail trying to load them.

```powershell
cd desktop
npm install
npm run dev              # electron-vite dev, hot reload
npm run build             # type-check + production bundles in out/
npm run pack               # + electron-builder installer (step 8)
```

WSL is still fine for editing and for `tsc --noEmit` / `eslint` / `prettier`,
since those are pure JS and don't touch the native addons.

## Embedding the pairing token

The server URL and pairing token are compiled into the main-process bundle
(see `electron.vite.config.ts`'s `define` block) — the person this app is
built for runs a plain `.exe` with nothing to configure.

```powershell
$env:ZOIA_SERVER_URL   = 'https://zoia.example.com'
$env:ZOIA_PAIRING_TOKEN = (mint one on the server: keytool pair:new --name "v1 build")
npm run build
```

Omit them for local development against a server you're already paired to —
`ZOIA_SERVER_URL` defaults to the production server, and with no token the app
just shows "no pairing token embedded" until you set one.

## Architecture

See `docs/adr/` at the repo root and `docs/PLAN.md`'s desktop section. In
short: `src/main` owns all server communication and secrets (credential in
`safeStorage`, HTTP via Electron's `net.fetch` on the cookie-aware default
session); `src/preload` exposes a narrow, typed bridge; `src/renderer` is a
plain React app that never sees a secret, only a LiveKit token or a stage
result.
