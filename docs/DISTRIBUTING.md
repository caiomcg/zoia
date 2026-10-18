# Distributing builds

A Zoia installer carries no server and no credential: people enter their server's address
and sign in with an account ([ADR 0031](adr/0031-accounts-with-admin-approval.md)). So there
is one kind of build, safe to link publicly, made either by CI or locally.

## Public releases

### OTA application-code updates

The Electron client also supports a lightweight `app.asar` update. It does not replace
`Zoia.exe`, the Electron runtime, FFmpeg, or the native addon. Use OTA only for TypeScript/
React changes and JavaScript dependencies that are already included in the package. Changes
to Electron, FFmpeg, or `native/*.node` still require a new distribution.

Updates come from GitHub releases ([ADR 0028](adr/0028-updates-from-releases.md)). The
updater asks the GitHub API for the repository's latest release (drafts and pre-releases are
never offered), reads the `update.json` attached to it, and compares versions. Nothing is
read from a branch.

The file [desktop/updater-config.json](../desktop/updater-config.json) is the packaged default
and can be overridden with another `updater-config.json` next to the executable or at
`%APPDATA%/Zoia/updater-config.json`. For a fork, change only `repository`:

```json
{
  "repository": "https://github.com/OWNER/REPOSITORY",
  "checkOnStartup": true,
  "autoInstall": false
}
```

Users do not need to navigate to AppData to make this change: in the desktop app, open the
settings button (the sliders icon) at the bottom of the member list and edit the **Updates**
section. It has the Git repository, which must be a GitHub repository URL, restores the
defaults, and provides **Check now**. Enable automatic installation only when the configured
repository is trusted. `autoInstall` set to `true` installs without confirmation; the default
`false` shows the update dialog. Settings saved by versions before 0.4.4 also held a branch
and a manifest path; they are ignored.

Each release carries its `update.json`, written by the release workflow's publish job with
[`scripts/write-updater-manifest.js`](../scripts/write-updater-manifest.js): checksums of the
files being uploaded, `minimumVersion` from the classifier, `notes` from the changelog
entry's `summary`. A complete example is
[desktop/updater-manifest.example.json](../desktop/updater-manifest.example.json):

```json
{
  "version": "0.2.14",
  "updateType": "asar",
  "minimumVersion": "0.2.10",
  "artifactUrl": "https://github.com/OWNER/REPOSITORY/releases/download/v0.2.14/Zoia-OTA-0.2.14.asar",
  "sha256": "<SHA-256 of the app.asar file>",
  "installerUrl": "https://github.com/OWNER/REPOSITORY/releases/download/v0.2.14/Zoia-Setup-0.2.14-x64.exe",
  "notes": "Optional summary"
}
```

The updater refuses an `update.json` whose `version` is not its release's tag, or that
names a file outside that same release. A `full` release has no `artifactUrl` or `sha256`
and `updateType: "full"`.

`minimumVersion` is the last `full` release. An `app.asar` is built against that release's
Electron, FFmpeg and native addon, so an installation older than it must not receive the
OTA: it gets the `full-required` prompt with `installerUrl` instead, and the update is
rejected if that URL is missing. The classifier prints the value (`Minimum installed version
for OTA`) in the release run's log.

The `app.asar` must be produced by the same release build (`electron-builder --dir`) and
copied from `win-unpacked/resources/app.asar`; the release workflow attaches it as
`Zoia-OTA-X.Y.Z.asar` next to `update.json`.

**Apps from before 0.4.4** read `desktop/updater-manifest.json` on `main` instead, which has
the same shape. It stays at the first release that reads releases, so those installs update
to it and find everything after it on their own. It is published by pull request, since
`main` is protected: run the script without `--out` on the release's `.exe` and `.asar`.

The regular CI workflow classifies every commit on `main` against the previous release tag.
The release workflow repeats the same classification for each release tag. The result is
printed in CI and controls whether the OTA asset is published:

| Classification | Meaning | Updater behavior |
|---|---|---|
| `asar` | Only application code or other files inside `app.asar` changed | Download and install the small OTA artifact |
| `full` | Electron, native code, FFmpeg, packaging, or external resources changed | Do not apply OTA; offer the full installer |
| `none` | No desktop files changed | Publish the normal release without an updater artifact |

The workflow marks a release as `full` when it sees changes under `desktop/native/`,
`desktop/vendor/`, `desktop/build/`, `desktop/ffmpeg/`, or changes to `desktop/ffmpeg.json`,
`desktop/electron-builder.yml`, `desktop/electron.vite.config.ts`, or desktop dependency
metadata/lockfiles. A version-only change to `desktop/package.json` or the lockfile does not
force a full release. The classifier lives in
[`scripts/classify-desktop-update.js`](../scripts/classify-desktop-update.js) and requires
the checkout to contain the release tags.

The desktop updater never replaces the executable itself. It focuses only on `asar` updates;
when it sees `updateType: "full"`, it tells the user to download the installer instead.

The [desktop/src/main/updater.ts](../desktop/src/main/updater.ts) module starts from
`desktop/src/main/index.ts` after `config.init()` and `pairing.restoreSession()`. It downloads
to `%APPDATA%/Zoia/updates`, validates SHA-256, starts a helper process, quits Electron, and
replaces `resources/app.asar` with a temporary backup before relaunching the installed executable.

The published binary contains **no server address and no credential**, so it can be linked
anywhere. It is inert until someone signs in to a server with an account.

Tag a version and CI does the rest:

```bash
npm version 0.2.0 --no-git-tag-version
npm version 0.2.0 --no-git-tag-version --prefix desktop
$EDITOR changelog/0.2.0.md    # required: the release notes
git add changelog/0.2.0.md
git commit -am "chore: release 0.2.0"
git tag v0.2.0
git push --follow-tags
```

`.github/workflows/release.yml` then builds on a Windows runner — the native capture addon
and the Windows installer — and attaches it to a GitHub Release with a
`SHA256SUMS.txt`.

Every release needs a changelog entry, `changelog/<version>.md`, committed before tagging;
the release workflow refuses a tag without one before it builds anything. See
[changelog/README.md](../changelog/README.md) for how to write it. The entry becomes the
body of the GitHub release, and the desktop app shows the same text after an update and from
Settings → About, so it says what changed and never how to install it.
[`scripts/release-notes.js`](../scripts/release-notes.js) adds only a link to the full
comparison. Preview the result before pushing the tag:

```bash
node scripts/release-notes.js v0.2.0   # after tagging locally, before pushing the tag
```

**The tag must match both `package.json` files.** electron-builder names its artifacts from
`desktop/package.json`, not from the tag, so a mismatch would publish `Zoia-Setup-0.1.0-x64.exe`
under a release called v0.2.0. The workflow refuses before building anything. Check it
yourself first with `npm run version:check v0.2.0`.

To exercise the pipeline without publishing — worth doing before the first real tag, since
this is the only place CI compiles C++ — run the workflow by hand from the Actions tab with
**publish** left off. The binaries appear as a workflow artifact instead.

Verifying a download:

```powershell
Get-FileHash Zoia-Setup-0.2.0-x64.exe -Algorithm SHA256   # compare with SHA256SUMS.txt
```

## Local builds

From Windows, in `desktop/`:

```bat
make-exe.bat
```

The same installer CI publishes, in `desktop/release/`. Set `ZOIA_SERVER_URL` first to have
the sign-in screen start with that address filled in; it is only a default, and people can
change it.

It also closes any running copy first: a running `Zoia.exe` holds `release/win-unpacked` open
and the build fails one line before writing the exe.

## What to expect when you send it

The binaries are unsigned, because code signing certificates cost money this project does not
have. On first run Windows shows **"Windows protected your PC"**; the way through is
*More info* → *Run anyway*. Tell people that before they see it, or they will assume the file
is broken.

The installer is large because it carries Electron and ffmpeg. The ffmpeg build alone is
about 100 MB of the package.

## Letting people in, and cutting them off

Both happen in the app, under **Settings › Accounts**, not by sending anything: approve a
sign-up, disable someone, or reset their password. See [RUNBOOK.md](RUNBOOK.md#day-to-day).
