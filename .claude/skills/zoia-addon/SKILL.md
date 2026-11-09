---
name: zoia-addon
description: Create, test and publish a Zoia addon — a bot, chat command or voice player in its own container that a server's super admin installs from GitHub. Use when asked to write, scaffold, debug or release a Zoia addon, write a zoia-addon.json manifest, or pick an addon's permissions.
---

# Writing a Zoia addon

An addon is the author's own program, in their own container image, in their own GitHub
repository. A server's super admin installs it from that repository's latest release, and it
talks to Zoia only through the [addon API](../../../docs/addons/api.md), only as far as the
permissions granted. The reference docs, which this skill doesn't repeat:

- [docs/addons/README.md](../../../docs/addons/README.md): permissions, lifecycle, container limits
- [docs/addons/manifest.md](../../../docs/addons/manifest.md): every field of `zoia-addon.json`
- [docs/addons/api.md](../../../docs/addons/api.md): endpoints, events, errors, the permission each needs
- [docs/addons/publishing.md](../../../docs/addons/publishing.md): releasing and getting installed
- [docs/addons/example/](../../../docs/addons/example/): Echo, a complete addon in ~130 lines

## 1. Pin down what it does, then its permissions

Ask what it should do in one sentence, then pick the **fewest** permissions that do it. Every
extra one is something the super admin must agree to and something the addon can be misused
for. Common shapes:

| Addon | Permissions |
|---|---|
| Answers `!commands` in a chat | `commands`, `chat.write`, `bots.create` |
| Reacts to every message (a quiz, a bridge) | add `chat.read` |
| Plays audio in voice | `voice.publish`, `bots.create`, `channels.read` |
| Moderates | `users.read`, `users.manage` (never reaches admins) |

It can never see an email, password or device credential, act as a person, or touch an admin.
If the idea needs one of those, say so early: it isn't possible, by design (ADR 0041).

## 2. Scaffold from Echo

In the author's repository (not inside Zoia's):

```
Dockerfile               # from docs/addons/example/Dockerfile
zoia-addon.json          # image left as a placeholder; the release workflow fills it in
src/index.js             # reads ZOIA_URL, ZOIA_ADDON_TOKEN (and ZOIA_LIVEKIT_URL for voice)
src/addon.js             # the logic, constructed with { zoiaUrl, token } so tests can run it
.github/workflows/release.yml   # from docs/addons/example/release.yml
```

Keep Echo's split: `index.js` only reads the environment and handles `SIGTERM`; everything else
takes its URL and token as arguments, so it can run against a test server.

## 3. Write it for the container it will live in

- On start, read `GET /me` for settings, bound chats and command names; then open
  `GET /events` and act on what arrives. Keep no state you can't rebuild from `/me`: it restarts
  at any time and nothing on disk survives.
- Handle `settings`, `commands` and `chats` events live; it never has to restart for them.
- Act on the command **you** declared (`command`), not what was typed (`name`): the super admin
  may rename `!play` to `!p`.
- On `401` stop (uninstalled); on `403 addon_disabled` wait (a new token comes when it's back
  on); on `429` back off (50 requests per 10 s).
- Write only under `/tmp` (`HOME=/tmp`, `XDG_CACHE_HOME=/tmp/cache`); run as a non-root user;
  build for `linux/amd64`; log to stdout; exit on a fatal error and let the host restart it.
- Limits: 512 MB, 2 CPUs, no capabilities, read-only root, 256 MB `/tmp`.

## 4. Check the manifest

Rules that trip people up: `id` is 2–32 of `a-z0-9-` and never changes between releases;
`version` must change every release; `image` is `ghcr.io/<owner>/<name>@sha256:<64 hex>`,
**lowercase**, by digest never by tag, and under the **same owner as the repository**.
Commands need the `commands` permission. A `secret` setting has no `default`.

With a Zoia checkout at hand, validate against the server's own code. The image placeholder is
swapped for a dummy digest, as the release will do:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const { validateManifest } = await import(process.argv[1] + '/server/src/addons.js');
const m = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!/@sha256:[0-9a-f]{64}\$/.test(m.image)) m.image = m.image.toLowerCase().replace(/@sha256:.*/, '@sha256:' + '0'.repeat(64));
const r = validateManifest(m); console.log(r.ok ? 'manifest ok' : r); process.exit(r.ok ? 0 : 1);
" <path to zoia> zoia-addon.json
```

A failure names the `field` at fault.

## 5. Test it against a real server

The most reliable way is how Zoia tests Echo: `server/test/addon-example.test.js` starts the
app in-process, installs the manifest (`stores.addons.install({ repo, manifest })`, which
returns the token), turns it on (`setEnabled`), binds it to a chat (`setBindings`), and runs
the addon's own factory against it while a signed-in person types the command. In a Zoia
checkout, copy that test, import the new addon's factory instead, and exercise its commands.
`npm test` there runs it.

There is no command yet that mints an addon token on a running dev server without a GitHub
release; don't invent one. Test the logic in-process as above, then try the released build on
a test server (a homolog, or their own).

## 6. Publish

Follow [publishing.md](../../../docs/addons/publishing.md): copy the release workflow, tag
`v1.0.0`, and push. The workflow lowercases the image name and writes the digest and version
into the manifest it attaches. **The first time only**, make the ghcr.io package **public**
(profile › Packages › the package › Package settings): the addon host pulls without
credentials, and a private package fails to install. Then the super admin installs it from
Settings › Addons with the repository's name.

A later release asking for a new permission needs the super admin's yes before it updates.
