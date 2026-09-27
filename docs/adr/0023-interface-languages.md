# ADR 0023 — Interface languages

- **Status:** accepted
- **Date:** 2026-09-27

## Context

The people using Zoia speak English, Spanish and Portuguese. The interface was English only,
apart from a few Portuguese strings that had crept in from features written in Portuguese. The
tray menu and the update dialogs live in the main process, so they cannot use anything that
only exists in the renderer.

## Decision

- **Three dictionaries, no library:** `src/shared/i18n/en.ts` is the source of truth. `es.ts`
  and `pt.ts` are typed `Record<keyof typeof en, string>`, so a missing key fails the build.
  Placeholders are `{name}`. The files have no imports, so both processes and `node --test`
  can load them.
- **The main process owns the choice.** It's stored in the user-data folder
  (`language.json`), like the tray setting, because the tray menu and dialogs need it too.
  The default is `system`, which follows `app.getPreferredSystemLanguages()` by primary
  subtag: pt-BR and pt-PT are Portuguese, es-419 is Spanish. Otherwise English.
- **Settings → General → Language** overrides it. The change applies at once, and the tray
  menu is rebuilt.
- **Translation happens where a string is shown.** Components use `useT()`. Callbacks use
  `tNow()`, so they don't have to depend on the language. Text that comes from the OS or
  from other people, such as window titles, device names and display names, is never
  translated.
- **A camera broadcast sends no label**, so each viewer names it in their own language. Older
  clients already fall back to "Camera" when the label is empty.

## Consequences

- A new string means a key in all three files. The build enforces the keys, and
  `test/i18n.test.ts` enforces that the placeholders match.
- Technical error details, such as invite validation and updater manifest checks, stay in
  English. They sit under a translated message and are mostly useful when reporting a bug.
- A message the main process has already produced, such as a pairing error on screen, keeps
  its language until it's produced again.
- The translations were written without a native reviewer. Wording fixes are just edits to
  the dictionaries.
