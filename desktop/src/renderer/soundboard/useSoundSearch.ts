/** Searching Myinstants as you type (ADR 0040), for the panel and the settings. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Sound, SoundPage } from '../../shared/soundboard';

/** How long typing must pause before Myinstants is asked. */
const SEARCH_DELAY_MS = 300;

export interface SoundSearch {
  query: string;
  sounds: Sound[];
  next: number | null;
  loading: boolean;
  failed: boolean;
}

function searchFrom(query: string, before: Sound[], page: SoundPage | null): SoundSearch {
  if (!page) return { query, sounds: before, next: null, loading: false, failed: true };
  // A page can repeat a sound from the one before it when Myinstants' list moves.
  const sounds = [...before, ...page.sounds.filter((s) => !before.some((b) => b.slug === s.slug))];
  return { query, sounds, next: page.next, loading: false, failed: false };
}

export function useSoundSearch() {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SoundSearch | null>(null);

  // Asks Myinstants once typing pauses. An answer to an older query is dropped.
  const latest = useRef('');
  useEffect(() => {
    const trimmed = query.trim();
    latest.current = trimmed;
    if (!trimmed) {
      setSearch(null);
      return;
    }
    setSearch({ query: trimmed, sounds: [], next: null, loading: true, failed: false });
    const timer = setTimeout(() => {
      void window.zoia.soundboard.search(trimmed, 1).then((page) => {
        if (latest.current === trimmed) setSearch(searchFrom(trimmed, [], page));
      });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const loadMore = useCallback(() => {
    if (!search?.next || search.loading) return;
    const { query: searched, sounds, next } = search;
    setSearch({ ...search, loading: true, failed: false });
    void window.zoia.soundboard.search(searched, next).then((page) => {
      if (latest.current === searched) setSearch(searchFrom(searched, sounds, page));
    });
  }, [search]);

  return { query, setQuery, search, loadMore };
}
