/**
 * Silenced chats: a choice each person makes on each machine, by right-
 * clicking a chat in the sidebar. A silenced chat counts only the messages
 * that @mention you, and plays no sound for anything. This
 * module is pure — what is stored, how a toggle changes it, and which cues a
 * new message deserves — so it can be tested without a window. Remembering
 * it is in silence-store.ts.
 */

import type { CueEvent } from '../sounds/cues';

/** The ids of the silenced chats, from storage. Anything unreadable is none. */
export function parseSilencedChats(raw: string | null): ReadonlySet<string> {
  let stored: unknown = null;
  try {
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  if (!Array.isArray(stored)) return new Set();
  return new Set(stored.filter((id): id is string => typeof id === 'string' && id.length > 0));
}

/** What is stored: sorted, so the same set is always the same text. */
export function serializeSilencedChats(silenced: ReadonlySet<string>): string {
  return JSON.stringify([...silenced].sort());
}

/** The set with `chatId` silenced or not; the set given is left as it was. */
export function withChatSilenced(
  silenced: ReadonlySet<string>,
  chatId: string,
  on: boolean,
): ReadonlySet<string> {
  if (silenced.has(chatId) === on) return silenced;
  const next = new Set(silenced);
  if (on) next.add(chatId);
  else next.delete(chatId);
  return next;
}

/**
 * The cues a new message from someone else plays. Only an @mention has one,
 * and not in a chat this machine has silenced: the badge says it instead.
 */
export function chatMessageCues(mentioned: boolean, silenced: boolean): CueEvent[] {
  return mentioned && !silenced ? ['mention'] : [];
}

/**
 * The count a chat shows: its unread, or for a silenced chat only those that
 * @mention you. Null counts, not yet known, are none.
 */
export function shownUnread(
  chat: { id: string; unread: number | null; mentions?: number | null },
  silenced: ReadonlySet<string>,
): number {
  return (silenced.has(chat.id) ? chat.mentions : chat.unread) ?? 0;
}
