/**
 * Which language the app speaks, from the main process's side.
 *
 * The choice is kept in the user's data folder, next to the tray's, because
 * both processes need it: the renderer for the window, this process for the
 * tray menu and the update dialogs. 'system' follows the OS's preferred
 * languages and is the default.
 */

import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  isLanguagePreference,
  resolveLanguage,
  translate,
  type Language,
  type LanguagePreference,
  type MessageKey,
  type Vars,
} from '../shared/i18n';

const prefsPath = () => join(app.getPath('userData'), 'language.json');

let preference: LanguagePreference | null = null;
const listeners = new Set<() => void>();

function readPreference(): LanguagePreference {
  try {
    const saved = JSON.parse(readFileSync(prefsPath(), 'utf8')) as { language?: unknown };
    return isLanguagePreference(saved.language) ? saved.language : 'system';
  } catch {
    return 'system';
  }
}

export function getPreference(): LanguagePreference {
  preference ??= readPreference();
  return preference;
}

/** The OS's own choice, whatever the user picked. */
export function systemLanguage(): Language {
  return resolveLanguage('system', app.getPreferredSystemLanguages());
}

export function currentLanguage(): Language {
  return resolveLanguage(getPreference(), app.getPreferredSystemLanguages());
}

export function setPreference(next: LanguagePreference): LanguagePreference {
  preference = next;
  try {
    mkdirSync(dirname(prefsPath()), { recursive: true });
    writeFileSync(prefsPath(), JSON.stringify({ language: next }));
  } catch {
    // Remembering is a convenience; the choice still applies this session.
  }
  for (const listener of listeners) listener();
  return next;
}

/** Called whenever the language changes, so menus can be rebuilt. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A message in the current language. */
export function t(key: MessageKey, vars?: Vars): string {
  return translate(currentLanguage(), key, vars);
}
