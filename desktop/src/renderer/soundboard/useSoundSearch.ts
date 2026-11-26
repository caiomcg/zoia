/**
 * Searching Myinstants as you type (ADR 0040), for the panel and the settings.
 * Results come a page at a time, as Myinstants gives them; a page already
 * seen for this query shows again at once.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Sound, SoundPage } from '../../shared/soundboard';

/** How long typing must pause before Myinstants is asked. */
const SEARCH_DELAY_MS = 300;

export interface SoundSearch {
  query: string;
  /** The page shown, from 1. */
  page: number;
  sounds: Sound[];
  /** The page after this one, or null at the end. */
  next: number | null;
  loading: boolean;
  failed: boolean;
}

function searchFrom(query: string, page: number, found: SoundPage | null): SoundSearch {
  if (!found) return { query, page, sounds: [], next: null, loading: false, failed: true };
  return { query, page, sounds: found.sounds, next: found.next, loading: false, failed: false };
}

export function useSoundSearch() {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SoundSearch | null>(null);

  // The page last asked for: an answer to any other is dropped.
  const latest = useRef('');
  // The pages seen for the current query, by number.
  const pages = useRef(new Map<number, SoundPage>());

  const load = useCallback((searched: string, page: number) => {
    const key = `${page}\n${searched}`;
    latest.current = key;
    const kept = pages.current.get(page);
    if (kept) {
      setSearch(searchFrom(searched, page, kept));
      return;
    }
    setSearch({ query: searched, page, sounds: [], next: null, loading: true, failed: false });
    void window.zoia.soundboard.search(searched, page).then((found) => {
      if (latest.current !== key) return;
      if (found) pages.current.set(page, found);
      setSearch(searchFrom(searched, page, found));
    });
  }, []);

  // Asks Myinstants once typing pauses, from the first page.
  useEffect(() => {
    const trimmed = query.trim();
    pages.current = new Map();
    latest.current = `1\n${trimmed}`;
    if (!trimmed) {
      setSearch(null);
      return;
    }
    setSearch({ query: trimmed, page: 1, sounds: [], next: null, loading: true, failed: false });
    const timer = setTimeout(() => load(trimmed, 1), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, load]);

  const goTo = useCallback(
    (page: number) => {
      if (!search || search.loading || page < 1) return;
      load(search.query, page);
    },
    [search, load],
  );

  return { query, setQuery, search, goTo };
}
