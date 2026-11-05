/**
 * "Ana is typing…" (ADR 0049). Nothing is stored: while someone writes, their
 * app says so every few seconds, and everyone else shows it until a few
 * seconds pass without another word, or their message arrives.
 *
 * The bookkeeping is kept apart from React so it can be tested.
 */

import { useEffect, useRef, useState } from 'react';

/** How often your app says you are still typing. */
export const TYPING_EVERY_MS = 3_000;

/** How long someone shows as typing after the last time they said so. */
export const TYPING_SHOWN_MS = 6_000;

/** Who is typing in a chat: account id -> { name, until }. */
export type Typers = Record<string, { name: string; until: number }>;

/** `typers` with `accountId` typing until `now + TYPING_SHOWN_MS`. */
export function addTyper(typers: Typers, accountId: string, name: string, now: number): Typers {
  return { ...typers, [accountId]: { name, until: now + TYPING_SHOWN_MS } };
}

/** `typers` without `accountId`, or the same object when they were not there. */
export function removeTyper(typers: Typers, accountId: string): Typers {
  if (!(accountId in typers)) return typers;
  const rest = { ...typers };
  delete rest[accountId];
  return rest;
}

/** `typers` without anyone whose time is up, or the same object when nobody's is. */
export function pruneTypers(typers: Typers, now: number): Typers {
  const kept = Object.entries(typers).filter(([, t]) => t.until > now);
  return kept.length === Object.keys(typers).length ? typers : Object.fromEntries(kept);
}

/**
 * Whether to say you are typing now: not more often than TYPING_EVERY_MS for
 * one chat. `last` is when it was last said there, or undefined.
 */
export function shouldPing(last: number | undefined, now: number): boolean {
  return last === undefined || now - last >= TYPING_EVERY_MS;
}

/** When this app last said you were typing, per chat. */
const pinged = new Map<string, number>();

/** Says you are typing in `chatId`, at most every few seconds. */
export function notifyTyping(chatId: string) {
  const now = Date.now();
  if (!shouldPing(pinged.get(chatId), now)) return;
  pinged.set(chatId, now);
  void window.zoia.chat.typing(chatId);
}

/** Sent: the next keystroke may say so again at once. */
export function typingSent(chatId: string) {
  pinged.delete(chatId);
}

/** The names of those typing in `chatId` now, yourself left out. */
export function useTypers(chatId: string | null | undefined, me: string | null): string[] {
  const [typers, setTypers] = useState<Typers>({});
  const chatRef = useRef(chatId);
  chatRef.current = chatId;

  useEffect(() => setTypers({}), [chatId]);

  useEffect(
    () =>
      window.zoia.chat.onEvent((event) => {
        if (event.type === 'typing') {
          if (event.chatId !== chatRef.current || event.accountId === me) return;
          setTypers((t) => addTyper(t, event.accountId, event.name, Date.now()));
        } else if (event.type === 'message' && event.message.chatId === chatRef.current) {
          setTypers((t) => removeTyper(t, event.message.authorId));
        } else if (event.type === 'stream' && !event.connected) {
          setTypers({});
        }
      }),
    [me],
  );

  const anyone = Object.keys(typers).length > 0;
  useEffect(() => {
    if (!anyone) return undefined;
    const timer = setInterval(() => setTypers((t) => pruneTypers(t, Date.now())), 1_000);
    return () => clearInterval(timer);
  }, [anyone]);

  return Object.values(typers).map((t) => t.name);
}
