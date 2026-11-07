---
name: zoia-feature
description: Add or change a feature in Zoia — server route, desktop UI, chat, voice, admin or addon API — from plan to a tested commit. Use when asked to implement, add, build or change behaviour in this repo, not for releases (use the release skill) or one-line fixes.
---

# Adding a feature to Zoia

Work through these in order. Each step names what to read; read it before writing code.

## 1. Place it

Decide which pieces the change touches, then read each one's `AGENTS.md`:

| If it… | It touches | Read |
|---|---|---|
| Stores, checks or serves anything | `server/src/` + `server/test/` | [server/AGENTS.md](../../../server/AGENTS.md) |
| Shows something or adds a setting | `desktop/src/renderer` (+ i18n) | [desktop/AGENTS.md](../../../desktop/AGENTS.md) |
| Needs a secret, the network, the OS or capture | `desktop/src/main` + a preload bridge + `src/shared/ipc.ts` | the same |
| Changes what a broadcast or voice publishes | `server/src/stage.js`, `token.js`, desktop `main` | invariant 1 in [AGENTS.md](../../../AGENTS.md) |
| Should be open to addons | `server/src/addon-routes.js` + `docs/addons/api.md` | invariant 7 |

Find the ADRs it builds on (`grep -l <topic> docs/adr/*.md`) and read them: many features
have a recorded reason for their current shape, and the change should not quietly undo it.

## 2. Check it against the invariants

Before writing code, say in one line each which of these the change touches and how it holds:

- **Tokens** never carry `canPublish: true`; publishing and voice are granted by `stage.js` only.
- **No email or secret in any log** or error message — log ids.
- **Sessions and roles are re-read on every request**; admin rules live on the server.
- **Direct chats**: every chat id through `resolveChat`, every chat event through `tell`.
- **Addons**: one permission per route, re-read per request; no email, hash or credential out.
- **`deploy.sh`** still excludes `server/data` and `caddy/sites`.

If the change needs one of these bent, stop and ask: that is an ADR, not an implementation detail.

## 3. Decide whether it needs an ADR

Write one in `docs/adr/` when a future reader would otherwise re-argue the choice: a new
store, a new permission, a new public surface, a limit, a trade-off you measured. Number it one
past the highest existing file (`ls docs/adr/[0-9]*.md | tail -1`), follow the shape of the recent
ones, and give the **consequences** section the costs too. A decision that replaces an old one
gets a new ADR superseding it, never an edit.

## 4. Build it

- **Server**: route + store + a `node:test`/`supertest` test named for what someone would
  notice (`a second claimant is refused with 409 and told who holds it`). Anything touching
  permissions gets a test showing it cannot grant rights nobody else has.
- **Desktop**: secrets and network stay in `main`; the renderer gets only what it shows.
  Every new string in `src/shared/i18n/en.ts` and every other language file.
- **Addon API**: document the route and its permission in `docs/addons/api.md`; if the example
  addon should use it, `server/test/addon-example.test.js` keeps it honest.
- Write new modules and exports before the files that import them (hot reload blanks the
  window otherwise).
- Comments say why, not what. If you measured something, put the number in the comment or the
  commit message.

## 5. Verify

Judge every command by its exit code, never by piping to `tail`.

```bash
npm run lint && npm run format:check && npm test         # root, from WSL
```

If `desktop/` changed (from Windows, or `cmd.exe /c` from WSL):

```bash
cd desktop
npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json
npm run lint && npm test
```

Then run the client from source (`npm run dev` in `desktop/`) against a server and use the
feature the way a person would. Changes under `desktop/native/` cannot be proven by CI: build
and load the addon on a real machine and say so in the PR.

## 6. Hand it over

Let the person try it before committing. Then commit as Conventional Commits with a scope from
`commitlint.config.js` (`feat(desktop): …`, `fix(api): …`), on a branch — `main` is protected.
Don't bump versions; that belongs to a release.
