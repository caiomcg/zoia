---
name: release
description: Cut a Zoia release — classify the update, bump versions, write the changelog, verify, push and tag. Use when asked to release, ship, tag or publish a new version of Zoia.
---

# Releasing Zoia

A release is a `vX.Y.Z` tag on `main`. CI builds the Windows installer and the Mac disk images,
decides whether Windows can take it as an in-app (OTA) update, and publishes the GitHub Release.
Installed apps find it themselves: the workflow attaches an `update.json` to the release, and
the updater reads the latest release's ([ADR 0028](../../../docs/adr/0028-updates-from-releases.md)).
Details: [docs/DISTRIBUTING.md](../../../docs/DISTRIBUTING.md).

Release end to end once CI passes; don't stop to have the changelog approved. Share the notes
when the release is published.

1. **Check what kind of release it is.** `node scripts/classify-desktop-update.js HEAD` prints
   `asar` (in-app on Windows), `full` (installer needed) or `none`, the reasons, and for `asar`
   the minimum installed version. Macs always download the disk image, whatever it says.
2. **Bump both versions**, kept equal:
   `npm version patch --no-git-tag-version` and the same with `--prefix desktop`.
3. **Write `changelog/<version>.md`** (format in `changelog/README.md`):
   - Start it with a `summary:` front-matter line: one sentence, shown in the update prompt.
   - Read the commits *and the diffs* since the previous tag
     (`git log v<prev>..HEAD`, `git diff v<prev>..HEAD`), plus any new ADR and new UI strings
     in `desktop/src/shared/i18n/en.ts`. Commit subjects alone undersell and mislabel changes.
   - Keep what someone using the app would notice, and say where to find it
     (Settings › Sounds). Leave out refactors, CI and version bumps.
   - Add a **Good to know** section for anything a person will run into: permissions, first-run
     prompts, platform differences, a setting that is on by default.
   - Say which platform a change applies to. Never write install instructions ("in-app
     update", "installer required", which file to download): the notes are shown in the app
     to people who have just installed the release.
   - Claim nothing the diff does not show.
4. **Verify:** `node scripts/check-release-version.js vX.Y.Z` (versions agree, entry exists),
   `npm run lint` and `npm test` at the root and in `desktop/` — judged by exit code. Preview
   the notes with a local tag: `git tag vX.Y.Z && node scripts/release-notes.js vX.Y.Z`.
5. **Push `main`, wait for CI to pass, then push the tag.** The release workflow refuses a tag
   without a changelog entry or with mismatched versions before it builds anything.
6. **When the release is published,** check it has `update.json` beside the `.exe` (and the
   `.asar` for an OTA): installed apps from 0.4.4 on read it from there. Apps before 0.4.4
   read `desktop/updater-manifest.json` on `main` instead, which stays at 0.4.4; to update it,
   download the release's `.exe` and `.asar` into a folder, run
   `node scripts/write-updater-manifest.js vX.Y.Z <folder> <asar|full> [minimumVersion]`, and
   open a pull request, since `main` is protected.

Never retag or delete a published release to fix it; ship the next patch version instead.
