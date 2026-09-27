# 16. OTA updates for the desktop app's application code

- **Status:** accepted
- **Date:** 2026-09-27

## Context

The Windows desktop client is distributed as an Electron application. A normal
Electron rebuild produces a large installer because it
contains the Electron runtime, Chromium, FFmpeg, and native capture addons.
Downloading that entire artifact for every TypeScript or React change is
unnecessarily expensive.

The project is also forkable and does not have one universal update service.
An updater therefore needs a repository and branch that can be changed by the
fork owner without rebuilding the Electron runtime solely to change a feed URL.

An update must not replace files while the main Electron process still has
them open. It must also reject corrupted or untrusted downloads and leave a
recoverable copy of the previous application if replacement fails.

## Decision

The desktop app uses a custom OTA updater that replaces only
`resources/app.asar`. It does not replace `Zoia.exe`, the Electron runtime,
FFmpeg, or unpacked native addons.

The feed is configured by `desktop/updater-config.json`, with overrides beside
the executable or in `%APPDATA%/Zoia/updater-config.json`. The configuration
contains the Git repository, branch, manifest path or explicit HTTPS URLs, and
whether startup checks and confirmation dialogs are enabled.

For GitHub repositories, the updater reads the selected branch commit through
the GitHub API and reads a JSON manifest from the corresponding raw branch
path. The manifest contains the release version, commit, an `updateType`, and
optional release notes. An `asar` manifest also contains an HTTPS `app.asar`
artifact URL and SHA-256 digest. A `full` manifest contains an HTTPS installer
URL instead. The updater refuses an incomplete manifest, non-HTTPS URL, commit
mismatch, or digest mismatch.

The release workflow runs `scripts/classify-desktop-update.js` against the
previous release tag. It produces `asar` when only application-code changes are
present, `full` when Electron/native/FFmpeg/packaging inputs changed, and
`none` when no desktop files changed. Only an `asar` classification publishes
the OTA asset. This keeps the decision in CI rather than relying on a person to
remember whether a commit is safe for an archive-only update.

The update sequence is:

1. Fetch the branch commit and manifest.
2. Compare the remote version/commit with the local version and update state.
3. Download the artifact to `%APPDATA%/Zoia/updates` using a partial filename.
4. Verify SHA-256, then rename the verified file into the staging name.
5. Start a detached helper process and ask Electron to quit normally.
6. After the parent exits, rename the current `app.asar` to a backup and move
   the staged artifact into place.
7. Relaunch the original executable and remove the backup after the handoff.

## Consequences

### Benefits

- Routine JavaScript/TypeScript releases download only the application archive.
- Releases that need the full installer are identified before publishing the OTA asset.
- Forks can point the same updater at their own repository and branch by editing
  JSON configuration.
- HTTPS, branch-commit matching, and SHA-256 verification reduce accidental or
  corrupted installs.
- Replacement happens after graceful shutdown and retains a rollback copy while
  the new process starts.
- The installer remains the single distribution format.

### Costs and limitations

- OTA artifacts must be produced from the same packaged build as the release.
- The release workflow must publish an `app.asar` asset and maintain the branch
  manifest with its exact SHA-256 value.
- The path classifier is conservative; a dependency or packaging change may
  require a full installer even when the resulting code would technically fit
  inside `app.asar`.
- Native, Electron, FFmpeg, and unpacked-resource changes cannot use this path.
- The updater currently supports the installed Windows build, not macOS/Linux packages.
- A compromised repository branch or release asset is still an update authority;
  SHA-256 protects integrity in transit, not publisher identity. A future
  signing scheme may extend this design.
