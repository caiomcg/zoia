/**
 * Messages in three languages, and the one function that reads them. Shared
 * by both processes; see core.ts for how a language is chosen.
 */

import { format, type Language, type Vars } from './core';
import { en, type MessageKey, type Messages } from './en';
import { es } from './es';
import { pt } from './pt';

export * from './core';
export type { MessageKey } from './en';

const DICTIONARIES: Record<Language, Messages> = { en, es, pt };

export function translate(language: Language, key: MessageKey, vars?: Vars): string {
  return format(DICTIONARIES[language][key] ?? en[key], vars);
}
