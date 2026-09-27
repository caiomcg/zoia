/**
 * The language machinery both processes share: which languages exist, how
 * the OS's preference is resolved to one of them, and how a message is
 * filled in. The main process uses it for the tray and its dialogs, the
 * renderer for everything else.
 *
 * Kept free of imports so `node --test` can load it directly.
 */

export const LANGUAGES = ['en', 'es', 'pt'] as const;
export type Language = (typeof LANGUAGES)[number];

/** What the user picked: a language, or whatever the OS prefers. */
export type LanguagePreference = Language | 'system';

/** Each language named in itself, so it is recognisable whatever is showing. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English',
  es: 'Español',
  pt: 'Português',
};

export const FALLBACK_LANGUAGE: Language = 'en';

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || (LANGUAGES as readonly unknown[]).includes(value);
}

/**
 * The language to show. An explicit choice wins; otherwise the first of the
 * OS's preferred locales Zoia speaks, by its primary subtag, so pt-BR and
 * pt-PT are both Portuguese and es-419 is Spanish. English if none match.
 */
export function resolveLanguage(
  preference: LanguagePreference,
  systemLocales: readonly string[],
): Language {
  if (preference !== 'system') return preference;
  for (const locale of systemLocales) {
    const primary = locale.toLowerCase().split(/[-_]/)[0];
    const match = LANGUAGES.find((language) => language === primary);
    if (match) return match;
  }
  return FALLBACK_LANGUAGE;
}

export type Vars = Record<string, string | number>;

/** Fills `{name}` placeholders. An unknown placeholder is left as written. */
export function format(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}
