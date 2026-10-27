/**
 * The chat's bookkeeping, kept free of React so it can be tested: ordering
 * message ids, merging pages and live messages, where the "new messages"
 * line goes, who has seen a message, and its reactions.
 *
 * Message ids are version 1 (time-based) uuids from the server. Their text
 * form puts the time's low bits first, so they do not sort as strings; the
 * time is pulled out and compared instead.
 */

import type { ChatMessage, ChatReaction } from '../../shared/ipc';

const UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-1([0-9a-f]{3})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

/** The 60-bit timestamp of a time-based uuid, or -1 for anything else. */
export function uuidTime(id: string): bigint {
  const match = UUID.exec(id);
  if (!match) return -1n;
  const [, low, mid, high] = match;
  return BigInt(`0x${high}${mid}${low}`);
}

/** Negative when `a` is older than `b`. Ties fall back to the text, so the order is total. */
export function compareIds(a: string, b: string): number {
  const ta = uuidTime(a);
  const tb = uuidTime(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when `a` is the same message as `b` or later. */
export const atOrAfter = (a: string, b: string) => compareIds(a, b) >= 0;

/** Messages oldest first, each once, from any mix of pages and live arrivals. */
export function mergeMessages(...lists: ChatMessage[][]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const list of lists) for (const m of list) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

/**
 * Where the "new messages" line goes: before the first message someone else
 * wrote after `lastRead`, or -1 when there is none. `messages` is oldest first.
 */
export function newMessagesIndex(
  messages: ChatMessage[],
  lastRead: string | null,
  me: string,
): number {
  return messages.findIndex(
    (m) => m.authorId !== me && (lastRead === null || compareIds(m.id, lastRead) > 0),
  );
}

/** Who, besides its author, has read up to `message`. */
export function seenBy(message: ChatMessage, readers: Record<string, string>): string[] {
  return Object.entries(readers)
    .filter(([accountId, last]) => accountId !== message.authorId && atOrAfter(last, message.id))
    .map(([accountId]) => accountId);
}

/** The later of two read markers; either may be missing. */
export function laterMarker(a: string | undefined, b: string): string {
  return a && atOrAfter(a, b) ? a : b;
}

/** Whether two messages fall on the same calendar day, where the reader is. */
export function sameDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/**
 * Whether `next` continues `previous`'s group: same author, within five
 * minutes, so it is shown without repeating the name and picture.
 */
export function continues(previous: ChatMessage | undefined, next: ChatMessage): boolean {
  if (!previous || previous.authorId !== next.authorId) return false;
  return Date.parse(next.sentAt) - Date.parse(previous.sentAt) < 5 * 60_000;
}

/**
 * A message's reactions with `accountId`'s `emoji` added, or taken off with
 * `on` false. Either is harmless to repeat, as it is on the server, so your
 * own change and its echo on the stream land once. An emoji nobody is left
 * on goes; a new one goes last.
 */
export function applyReaction(
  reactions: ChatReaction[] | undefined,
  emoji: string,
  accountId: string,
  on: boolean,
): ChatReaction[] {
  const list = reactions ?? [];
  const group = list.find((r) => r.emoji === emoji);
  if (Boolean(group?.accountIds.includes(accountId)) === on) return list;
  if (!group) return [...list, { emoji, accountIds: [accountId] }];
  return list
    .map((r) =>
      r.emoji !== emoji
        ? r
        : {
            emoji,
            accountIds: on
              ? [...r.accountIds, accountId]
              : r.accountIds.filter((id) => id !== accountId),
          },
    )
    .filter((r) => r.accountIds.length > 0);
}
