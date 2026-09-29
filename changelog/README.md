# Changelog

One file per release, named for its version: `changelog/0.3.17.md` for `v0.3.17`.

The entry is the body of the GitHub release, and the desktop app shows the same text in the
window that opens after an update and from **Settings → About → the version number**. So it
is written for the people running Zoia, not for the people working on it.

**A release cannot be tagged without one.** `scripts/check-release-version.js` refuses a tag
whose entry is missing or empty, and the release workflow runs it before building anything.

## Writing an entry

Say what changed, and nothing about how to install it: no "in-app update", "installer
required" or download instructions. The updater already handles that, and the app shows these
notes to people who have just installed the release. The only thing added around the entry is
the link to the full list of commits, by `scripts/release-notes.js`.

- Start with a front-matter block holding one sentence for the update prompt. It is removed
  from the notes and copied into the release's `update.json`, which the update prompt reads; the
  release workflow refuses a tag without it.

  ```markdown
  ---
  summary: Smooth, hardware-encoded game sharing on NVIDIA graphics cards.
  ---

  ### New
  ```

- Group under `### New`, `### Fixed`, `### Improved` — only the headings that apply.
- Say what changed for someone using the app, and where to find it: "Settings → Sounds",
  not "added `SoundsSection`".
- Mention anything a person has to do, or will notice the first time, such as a setting that
  is on by default.
- Plain Markdown only: headings, `-` bullets, **bold**, `code` and links. The app renders
  that subset and shows anything else as text.

Entries are usually drafted from the commits and diffs since the last tag, then read over
before they are committed. Preview the result with the generated parts added:

```bash
git tag v0.3.17                          # locally; not pushed yet
node scripts/release-notes.js v0.3.17
```

Releases before 0.3.17 have no entry; their notes were generated from the commits.
