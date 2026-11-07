# AGENTS.md

Conventions and invariants for anyone — human or agent — working on this repo.
`CLAUDE.md` imports this file; it is the source of truth. Each area has its own
`AGENTS.md` with what only matters there — read it before changing that area:
[desktop/](desktop/AGENTS.md), [server/](server/AGENTS.md), [android/](android/AGENTS.md).

## What this is

Zoia is a private one-to-many screen broadcast with voice and text chat. People with an
approved account (ADR 0031) join a **channel** — a LiveKit room (ADR 0015) — and anyone may
claim a broadcast slot there to share a screen with audio; each viewer picks which broadcasts
to watch. Beside the channels are text chats (ADR 0036), direct messages (ADR 0047),
scheduled events (ADR 0050) and addons (ADR 0041). Roles (user, admin, one super admin)
govern administration only, never who may broadcast.

It is five pieces:

| Piece | Where | |
|---|---|---|
| **LiveKit** | `livekit.yaml` | Self-hosted SFU. No transcoding: cheap on CPU, expensive on upstream bandwidth |
| **The server** | `server/` | Node/Express. Accounts in SQLite, chat in ScyllaDB; mints subscribe-only LiveKit tokens |
| **Caddy** | `Caddyfile`, `caddy/` | TLS for exactly two hostnames; the only public surface. Media bypasses it (UDP 7882) |
| **The desktop app** | `desktop/` | Electron + React, Windows and macOS. The only client that watches and shares (ADR 0021) |
| **The addon host** | `addon-host/` | Sidecar that runs addon containers; the only holder of the Docker socket |

The Android viewer (`android/`) is on hold. Nginx Proxy Manager serves every *other*
service on this network and is deliberately not exposed — never route Zoia through it (ADR 0004).

## Commands

```bash
npm install && npm run dev   # server on :3000, watch mode
npm test                     # node:test suite (root); desktop/ has its own
npm run lint                 # judge by exit code, never by `| tail`
npm run format
npm run keytool -- <cmd>     # server admin CLI — see server/AGENTS.md
./deploy.sh [--homolog]      # rsync to the VM + docker compose up (ADR 0035)
```

**WSL and Windows share this checkout (`/mnt/c`).** Run git and the root test suite from WSL,
with `/usr/bin/git`: a WSL `npm install` leaves no `.cmd` shims, so Windows `git.exe` fails the
pre-commit hook with `'eslint' is not recognized`. **Install `desktop/` from Windows** — see
[desktop/AGENTS.md](desktop/AGENTS.md). After a pull that changed a `package-lock.json`, run
`npm ci` in that folder before trusting lint or tests: CI uses the lockfile, your
`node_modules` may not.

## Invariants — do not break these

1. **Join tokens must never carry `canPublish: true`.** Publishing is granted at runtime by
   `server/src/stage.js`, per participant and only for that participant's slot. Voice is
   granted the same way and covers the microphone alone (`canPublishSources: [MICROPHONE]`,
   ADR 0039); a microphone-only grant is not a broadcast slot, so never decide who holds one
   from `canPublish` by itself. **The one exception is an addon's bot** (ADR 0041): a bot of
   an addon granted `voice.publish` gets a token that publishes the microphone alone (plus a
   camera with `video.publish`), minted for that bot's identity only. A person's join token
   never changes. Guarded by `server/test/token.test.js` and `stage.test.js`.
2. **Never log a secret or an email** — no password, device credential or reset code, and no
   email address — not in the app, not in an error message, not in a debug branch. Log the
   account or device id instead.
3. **Sessions are re-validated against the database on every request** — the device and its
   account — or signing a machine out or disabling someone does nothing until the cookie expires.
4. **Admin rules are enforced on the server.** Every admin route re-reads the caller's role on
   every request; nothing in the app can create, demote, disable or reset the super admin,
   who is set only with `keytool account:super`. Hiding a button is not enforcement.
5. **Never commit secrets.** `.env`, `server/data/` and any key material stay out of git.
   `livekit.yaml` is committed deliberately without credentials (`LIVEKIT_KEYS` env).
6. **`deploy.sh` must keep excluding `server/data`** and `caddy/sites`. It runs
   `rsync --delete`; dropping the first wipes the database and locks out every user.
7. **An addon never holds more than it was granted.** Every `/api/addon/v1` route requires one
   permission, re-read on every request; a bot is always `user`, never signs in and never gets
   a reset code; no addon response carries an email, password hash or device credential.
8. **Only the addon host holds the Docker socket**, and it pulls images by digest only.
9. **`app.set('trust proxy', ...)` must stay.** Behind Caddy every request otherwise comes from
   the proxy, and rate limiting throttles all users as one client.
10. **A direct chat is its two members' alone** (ADR 0047): every chat id goes through
    `resolveChat` in `chat-routes.js` (`404` to anyone else, admins included), and every event
    about a chat goes out through `tell` with its members as the audience. Threads and files
    too. Guarded by `server/test/messaging.test.js`.

## Deployment gotchas

Each fails in a way that looks like an app bug. Details in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md);
`scripts/preflight.sh` (run on the VM) checks most of them.

- `rtc.use_external_ip: true` in `livekit.yaml`, or viewers join and see black video forever.
- Cloudflare records for `zoia` and `sfu` must be **grey-cloud (DNS only)**; the proxy carries no WebRTC.
- **UDP 7882 and TCP 7881** forward straight to the VM; no HTTP proxy can carry them.
- Caddy serves only the two hostnames plus `caddy/sites/` (the homolog). Another hostname widens
  the public surface: that is a decision, not a config tweak (ADR 0035).
- The homolog shares production's LiveKit; only `ROOM_NAME` (`zoia-homolog`) keeps them apart, and
  production's `LIVEKIT_KEYS` must be a `{key: secret, ...}` map holding both keys.
- LAN hairpin: if the router won't route a LAN client to the public hostname, fix it with a local
  DNS override, not code.

## Conventions

- **Conventional Commits**, enforced by commitlint (hook and CI). Scopes are in
  `commitlint.config.js`: mostly `desktop`, `api`, `auth`, `livekit`, `infra`, `deploy`, `docs`,
  `test`, `adr`.
- ESM everywhere. Tests use `node:test` + `supertest`; no test framework dependency.
- Decisions a future reader would otherwise re-litigate go in `docs/adr/`, numbered one past the
  highest existing ADR.
- New UI strings go in `desktop/src/shared/i18n/en.ts` and every other language file.
- Releases: follow [.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md). Every release
  needs `changelog/<version>.md`; never retag or delete a published release.

## Where to look

| For | Read |
|---|---|
| How the pieces fit | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), `docs/adr/` |
| Running your own server | [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md); the author's own: [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Writing an addon | [docs/addons/](docs/addons/README.md) |
| Builds, installers, updates | [docs/DISTRIBUTING.md](docs/DISTRIBUTING.md) |
| Contributing, CI | [CONTRIBUTING.md](CONTRIBUTING.md) |
