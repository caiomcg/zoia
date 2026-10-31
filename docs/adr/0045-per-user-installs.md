# 45. The desktop app installs for the current user only

- **Status:** accepted
- **Date:** 2026-10-31
- **Amends** [ADR 0016](0016-desktop-ota-updates.md), whose updater elevates to write into a
  protected install

## Context

The Windows installer asked whether to install for the current user or for everyone, and let
people pick the folder. Installed for everyone, Zoia lives in `Program Files`, which a normal user
cannot write. An OTA (ADR 0016) replaces `app.asar` in the install folder, so there it asks for
administrator rights through `elevate.exe`.

Up to 0.13.0, the elevated helper also reopened Zoia, and a process started by an elevated one is
elevated too. Windows refuses window capture to an elevated Zoia: Chromium's sandbox marks the
elevated browser process so that Windows Graphics Capture answers `CreateForWindow` with
`E_ACCESSDENIED`, on the GPU path and Chromium's alike. So after every update, anyone installed for
everyone could not share a window until they restarted Zoia themselves. It was first reported as a
failed share on the day 0.11.0 came out, and again after 0.13.0.

0.14.0 stopped the elevated helper from reopening Zoia: a relauncher Zoia starts as the user does
it. But a `Program Files` install still needs a UAC prompt for every update, and anyone who runs
Zoia as administrator still cannot share a window.

## Decision

- **Per-user only.** The installer is one-click and per-user (`oneClick: true`,
  `perMachine: false`): no install-mode page and no folder choice. Zoia goes to the user's own
  AppData, which they can write, so an update never needs administrator rights.
- **An elevated Zoia says so.** At startup Zoia checks whether it runs as administrator
  (`whoami /groups`: a High or System mandatory level). If it does, a banner says Windows will not
  let it share a window, with **Restart normally**, which closes it and reopens it through
  Explorer as the signed-in user. A share refused with `0x80070005` brings the banner back; when
  Zoia is not elevated, it says instead that the window's own program runs as administrator.
- **Installer options ship as an OTA.** The release classifier counts a change confined to
  `electron-builder.yml`'s `nsis:` block as no packaging change: those options decide nothing
  inside the install folder, so a new `app.asar` still fits every install.

## Consequences

- Installs made for everyone before this stay in `Program Files` and keep needing a UAC prompt
  per update, though since 0.14.0 one no longer leaves Zoia elevated. Moving them means
  uninstalling and installing again; the new installer does not remove an old per-machine copy.
- Nobody can choose where Zoia is installed any more.
- Someone who runs Zoia as administrator on purpose (for shortcuts over a game that runs as
  administrator, say) sees the banner, and can dismiss it.
- A comment at the margin of `electron-builder.yml` is outside the `nsis:` block, so changing one
  there still makes a release full. Comments about the installer belong inside the block.
