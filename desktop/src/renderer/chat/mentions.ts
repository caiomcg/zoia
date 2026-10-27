/**
 * @mentions in the chat, kept free of React so they can be tested: finding
 * the "@query" being typed, the people it may mean, putting a chosen name in
 * its place, and splitting a message into text and the mentions in it.
 *
 * Names are unique on a server and may hold spaces ("@Bia Souza"), so a query
 * runs past a space for as long as someone's name still starts with it.
 */

import type { ChatMention } from '../../shared/ipc';

/** As long as a name may be, so a stray @ never matches a whole paragraph. */
const QUERY_MAX = 32;

/** What is being typed after an @, and where that @ is. */
export interface MentionQuery {
  /** Index of the @. */
  start: number;
  query: string;
}

/**
 * The @query that ends at the caret, or null. The @ must start the text or
 * follow a space or line break, so an email address is not a mention.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length > QUERY_MAX || query.includes('\n') || query.includes('@')) return null;
  return { start: at, query };
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * People whose name fits the query: those it starts first, then those with
 * a word that starts with it, each alphabetical. Accents and case are
 * ignored, so "joao" finds "João".
 */
export function matchPeople<T extends { name: string }>(
  people: T[],
  query: string,
  limit = 6,
): T[] {
  const q = fold(query);
  const starts: T[] = [];
  const words: T[] = [];
  for (const person of people) {
    const name = fold(person.name);
    if (name.startsWith(q)) starts.push(person);
    else if (q && !q.includes(' ') && name.split(/\s+/).some((w) => w.startsWith(q))) {
      words.push(person);
    }
  }
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  return [...starts.sort(byName), ...words.sort(byName)].slice(0, limit);
}

/** The text with the @query replaced by "@Name ", and where the caret goes. */
export function applyMention(
  text: string,
  { start, query }: MentionQuery,
  name: string,
): { text: string; caret: number } {
  const end = start + 1 + query.length;
  const inserted = `@${name} `;
  const rest = text.slice(end).replace(/^ /, '');
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length };
}

/** Of the people picked while writing, those still named in the text. */
export function mentionedIn(text: string, picked: ChatMention[]): ChatMention[] {
  const seen = new Set<string>();
  return picked.filter((p) => {
    if (seen.has(p.id) || !text.includes(`@${p.name}`)) return false;
    seen.add(p.id);
    return true;
  });
}

export type BodyPart = { text: string; mention?: ChatMention };

/**
 * A message's text as plain parts and mentions, in order. Longer names are
 * tried first, so "@Ana Paula" is not taken for "@Ana" followed by " Paula".
 */
export function splitMentions(body: string, mentions: ChatMention[] = []): BodyPart[] {
  if (mentions.length === 0) return [{ text: body }];
  const sorted = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const parts: BodyPart[] = [];
  let plain = '';
  for (let i = 0; i < body.length;) {
    const mention =
      body[i] === '@' && (i === 0 || /\s/.test(body[i - 1]!))
        ? sorted.find((m) => body.startsWith(`@${m.name}`, i))
        : undefined;
    if (mention) {
      if (plain) parts.push({ text: plain });
      plain = '';
      parts.push({ text: `@${mention.name}`, mention });
      i += mention.name.length + 1;
    } else {
      plain += body[i];
      i += 1;
    }
  }
  if (plain) parts.push({ text: plain });
  return parts;
}
