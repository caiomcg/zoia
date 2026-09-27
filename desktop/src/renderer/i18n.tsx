/**
 * The renderer's side of translation. The language comes from the main
 * process (see src/main/language.ts), which owns the stored choice so the
 * tray and its dialogs follow it too.
 *
 * Components call `useT()` and re-render when the language changes. Code
 * outside React (errors set inside callbacks) calls `tNow()`, which reads the
 * language current at that moment.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  FALLBACK_LANGUAGE,
  translate,
  type Language,
  type LanguagePreference,
  type MessageKey,
  type Vars,
} from '../shared/i18n';
import type { LanguageState } from '../shared/ipc';
import Splash from './components/Splash';

export type T = (key: MessageKey, vars?: Vars) => string;

let current: Language = FALLBACK_LANGUAGE;

/** A message in the language in use right now, for code outside React. */
export function tNow(key: MessageKey, vars?: Vars): string {
  return translate(current, key, vars);
}

interface I18nValue {
  t: T;
  language: Language;
  preference: LanguagePreference;
  /** What 'system' resolves to, for the setting's label. */
  system: Language;
  setPreference: (preference: LanguagePreference) => Promise<void>;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LanguageState | null>(null);

  useEffect(() => {
    window.zoia.language
      .get()
      .then(setState)
      .catch(() =>
        setState({ preference: 'system', language: FALLBACK_LANGUAGE, system: FALLBACK_LANGUAGE }),
      );
  }, []);

  const language = state?.language ?? FALLBACK_LANGUAGE;
  current = language;
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const t = useCallback<T>((key, vars) => translate(language, key, vars), [language]);
  const setPreference = useCallback(async (preference: LanguagePreference) => {
    setState(await window.zoia.language.set(preference));
  }, []);

  // Held until known, so nothing renders in one language and then another.
  if (!state) return <Splash />;

  return (
    <I18nContext.Provider
      value={{ t, language, preference: state.preference, system: state.system, setPreference }}
    >
      {children}
    </I18nContext.Provider>
  );
}

function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useT() used outside I18nProvider');
  return value;
}

export function useT(): T {
  return useI18n().t;
}

export function useLanguage() {
  const { language, preference, system, setPreference } = useI18n();
  return { language, preference, system, setPreference };
}
