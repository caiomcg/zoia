# 28. Updates are found from the latest GitHub release, not a file on main

- **Status:** accepted
- **Date:** 2026-09-29

## Context

Installed apps learned about a new version from `desktop/updater-manifest.json` on `main`:
the updater read the file from `raw.githubusercontent.com` and the branch's commit from the
API. Keeping it current was the last step of every release, first by hand and then by a
release-workflow job that pushed the file to `main` once the release's assets existed.

Protecting `main` from direct pushes broke that job for 0.4.3: the release was published,
with its OTA archive, and no installed app heard about it. The workflow's built-in token
cannot be let past the protection. The ways around it were a deploy key allowed to bypass
it, which would be the release workflow's first secret and a standing exception to the
protection, or a pull request per release, which puts a person back in every release.

Almost everything the manifest said is already in the release: the version is the tag, the
files and their download links are the assets, the checksums are in `SHA256SUMS.txt`, and
the notes are the release body, which the app already reads for What's new. The one thing
that is not is `minimumVersion`, the last release that needed the installer: an OTA is built
against that release's Electron and native addon. It cannot be guessed from the assets,
since a release that changes nothing in the app has no OTA archive either, yet an install
before it needs no installer.

## Decision

The release workflow's publish job writes an `update.json` with the manifest's fields
(`version`, `updateType`, `minimumVersion`, `artifactUrl`, `sha256`, `installerUrl`,
`notes`) and attaches it to the release with the other files. Nothing is pushed to `main`.

From 0.4.4 the updater asks the API for the repository's latest release, which skips drafts
and pre-releases, downloads that release's `update.json`, and decides by version as before.
It refuses an `update.json` that is not about its own release's tag or that names a file
outside that release. The settings keep only the repository; the branch and manifest path
are gone.

Apps before 0.4.4 still read `desktop/updater-manifest.json` on `main`. It is published by
pull request for 0.4.3 and 0.4.4, then left at 0.4.4: older installs update to it and find
later releases on their own.

## Consequences

- A release reaches installed apps the moment it is published, with no second step and no
  bypass of the branch protection. The release workflow still needs no secrets.
- What an app is offered and the files it downloads come from one place, the release, and
  the checks tie them to each other.
- One API call per check, as before: the release lookup replaces the branch-commit lookup.
  Unauthenticated calls are limited to 60 an hour per address, shared with the notes lookup;
  a check runs every 30 minutes.
- A release without `update.json` stops updates for everyone until the next release: the
  updater says so rather than guessing. A tag always bumps the desktop version, which makes
  it at least `asar`, so every tagged release gets one; a `none` release would not.
- Updates now need a GitHub repository. A fork elsewhere would need its own source.
- The manifest on `main` and its example stay until nobody is on a version before 0.4.4,
  and the 0.4.4 manifest there still takes a pull request to publish.
