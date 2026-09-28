/**
 * Keeps a removed list item on screen for a moment, flagged as leaving, so it
 * can fade out instead of vanishing. React removes an element the instant its
 * item is gone from the list, which leaves nothing to animate.
 */

import { useEffect, useRef, useState } from 'react';

/** Matches the leave animation in styles.css. */
export const LEAVE_MS = 180;

export interface Presence<T> {
  item: T;
  key: string;
  leaving: boolean;
}

export interface Leaving<T> {
  item: T;
  /** Where it was, so it fades out in place rather than at the end. */
  index: number;
  /** When it is dropped, in Date.now() terms. */
  until: number;
}

/** The current items in order, with each leaving one put back where it was. */
export function mergeLeaving<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  leaving: ReadonlyMap<string, Leaving<T>>,
): Presence<T>[] {
  const out: Presence<T>[] = items.map((item) => ({ item, key: keyOf(item), leaving: false }));
  const present = new Set(out.map((entry) => entry.key));
  const gone = [...leaving.entries()]
    .filter(([key]) => !present.has(key))
    .sort(([, a], [, b]) => a.index - b.index);
  for (const [key, { item, index }] of gone) {
    out.splice(Math.min(index, out.length), 0, { item, key, leaving: true });
  }
  return out;
}

/**
 * `scope` names the list: when it changes (another channel, say) the old
 * items were not removed, they belong somewhere else, so nothing fades out.
 */
export function useLeaving<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  scope: string,
  ms = LEAVE_MS,
): Presence<T>[] {
  // Compared by keys, not by array: callers usually build the array anew on
  // every render, and that alone must not count as a change.
  const signature = `${scope}\u0000${items.map(keyOf).join('\u0000')}`;
  const [shown, setShown] = useState({ signature, scope });
  const [leaving, setLeaving] = useState<ReadonlyMap<string, Leaving<T>>>(new Map());
  const committed = useRef(items);

  // Adjusted during render, not in an effect, so the item is still there on
  // the very frame it would otherwise have disappeared.
  if (signature !== shown.signature) {
    setShown({ signature, scope });
    if (scope !== shown.scope) {
      setLeaving(new Map());
    } else {
      const present = new Set(items.map(keyOf));
      const until = Date.now() + ms;
      const gone = committed.current.flatMap((item, index): [string, Leaving<T>][] =>
        present.has(keyOf(item)) ? [] : [[keyOf(item), { item, index, until }]],
      );
      if (gone.length) setLeaving((current) => new Map([...current, ...gone]));
    }
  }

  useEffect(() => {
    committed.current = items;
  });

  useEffect(() => {
    if (leaving.size === 0) return undefined;
    const soonest = Math.min(...[...leaving.values()].map((entry) => entry.until));
    const timer = setTimeout(
      () => {
        const now = Date.now();
        setLeaving((current) => new Map([...current].filter(([, entry]) => entry.until > now)));
      },
      Math.max(0, soonest - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [leaving]);

  return mergeLeaving(items, keyOf, leaving);
}

/**
 * The same for one thing that opens and closes, such as a dialog or a menu:
 * `mounted` stays true for `ms` after `open` goes false, with `closing` set
 * for that time so it can fade out. Whatever closes it (a button, Escape, the
 * parent), the fade happens, because it follows `open` rather than a handler.
 */
export function useExit(open: boolean, ms = LEAVE_MS): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return undefined;
    const timer = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [open, mounted, ms]);

  return { mounted: open || mounted, closing: !open && mounted };
}
