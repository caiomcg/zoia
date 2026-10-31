/**
 * What to accent in the message box while it is being written, kept free of
 * React so it can be tested: the @mentions that will go out as mentions, and
 * a !command the chat really has. The box is a plain textarea, so these are
 * ranges of its text for a backdrop behind it to paint.
 *
 * Only what the server will treat as such is accented, so a stray @ or ! in
 * a sentence stays plain, as it will in the message once sent.
 */

/** A stretch of the text to accent, from start up to (not including) end. */
export interface Highlight {
  start: number;
  end: number;
  kind: 'mention' | 'command';
}

/** A letter or digit right after a name means a longer word, not that name. */
const WORD = /[\p{L}\p{N}]/u;

/**
 * The mentions and the command in the text, in order. Mentions follow the
 * rules a sent message is shown by (splitMentions): an @ at the start or
 * after a space, then a name, longer names first so "@Ana Paula" is not
 * "@Ana". The command is the first word when it is "!name" of a command this
 * chat offers, matched as the server does, ignoring case and leading space.
 */
export function composerHighlights(
  text: string,
  people: { name: string }[],
  commands: { name: string }[],
): Highlight[] {
  const found: Highlight[] = [];
  let from = 0;

  const lead = text.length - text.trimStart().length;
  if (text[lead] === '!') {
    const word = /^!(\S+)/.exec(text.slice(lead))?.[1];
    if (word && commands.some((c) => c.name.toLowerCase() === word.toLowerCase())) {
      from = lead + 1 + word.length;
      found.push({ start: lead, end: from, kind: 'command' });
    }
  }

  const names = [...new Set(people.map((p) => p.name).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) return found;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '@' || (i > 0 && !/\s/.test(text[i - 1]!))) continue;
    const name = names.find((n) => {
      if (!text.startsWith(n, i + 1)) return false;
      const next = text[i + 1 + n.length];
      return next === undefined || !WORD.test(next);
    });
    if (!name) continue;
    const end = i + 1 + name.length;
    found.push({ start: i, end, kind: 'mention' });
    i = end - 1;
  }
  return found;
}

export type HighlightPart = { text: string; kind?: Highlight['kind'] };

/** The text cut at the highlights, every character in exactly one part. */
export function splitHighlights(text: string, highlights: Highlight[]): HighlightPart[] {
  const parts: HighlightPart[] = [];
  let at = 0;
  for (const { start, end, kind } of highlights) {
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: text.slice(start, end), kind });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
