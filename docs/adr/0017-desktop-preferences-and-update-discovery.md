# ADR 0017 — Desktop preferences and update discovery

- **Status:** accepted
- **Date:** 2026-09-27

## Context

The desktop client has behavior that users reasonably expect to control without
editing files: whether closing the window quits Zoia or leaves it in the system
tray, and which update feed is checked. Users also need to distinguish the
version currently installed from a version that is available remotely.

The Electron renderer cannot safely own process-level behavior or open an
installer. Those operations belong to the main process, while the settings UI
needs a small, typed surface for requesting them.

## Decision

Expose desktop preferences through the existing main/preload/renderer IPC
boundary:

- The close-to-tray preference is persisted in the Electron user data directory
  and is applied immediately when changed. Closing the last window hides it
  when enabled; the tray menu remains able to quit the application explicitly.
- The settings screen displays both the installed application version and the
  version returned by the configured update feed.
- Update configuration remains editable from settings, including startup
  checks and automatic installation. The renderer asks the main process to
  check the feed and, for a full installed-build update, open the HTTPS
  installer URL with the operating system.
- The preload exposes only these narrow operations. Renderer code never gains
  direct access to Electron filesystem, shell, or process APIs.

The supported distribution is the installed Windows build. Portable packaging
and portable-specific update paths are not part of the product surface; a
release that requires the full Electron runtime uses the Windows installer.
Application-only releases continue to follow [ADR 0016](0016-desktop-ota-updates.md).

## Consequences

- Users can understand their update state without inspecting package files.
- Close behavior is consistent between the settings screen and the tray menu.
- Process and installer actions stay behind the main-process security boundary.
- Forks can change the update repository and branch without changing renderer
  code.
- Automatic installation can interrupt a session, so it remains an explicit
  setting and must use a trusted HTTPS feed.
- The settings UI depends on the installed Windows application model; it does
  not define a portable fallback.
