/**
 * Formatting in chat messages, as Discord writes it, kept free of React so it
 * can be tested. A message becomes a tree for React to render, never HTML, so
 * nothing anyone writes can inject markup.
 *
 * Inline: **bold**, *italic* or _italic_, __underline__, ~~strikethrough~~,
 * ||spoiler||, `code`, [a masked link](https://…), bare web addresses and
 * @mentions; they nest, as in ***bold italic*** or __*underlined italic*__.
 * Blocks, each at the start of a line: # ## ### headings, -# small text,
 * > a quoted line, >>> quoting the rest of the message, - or * or 1. list
 * items (indented to nest), and ```code blocks```. A backslash before any
 * punctuation keeps it as written: \*not italic\*.
 *
 * Addresses, mentions and code are read before formatting, so the
 * underscores of an address or a name never turn into italics.
 */

import type { ChatMention } from '../../shared/ipc';
// With its extension, so the tests can load it without a bundler.
import { linkAt } from './links.ts';

export type Styled = 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler';

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: Styled; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'mention'; text: string; mention: ChatMention };

export interface ListItem {
  children: Inline[];
  /** Lists indented under this item. */
  lists: ListBlock[];
}

export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  /** The number an ordered list counts from. */
  start: number;
  items: ListItem[];
}

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'subtext'; children: Inline[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'codeBlock'; text: string; language?: string }
  | ListBlock;

/** A backslash before ASCII punctuation keeps that character as written. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;
/** Characters a mention may follow besides a space: the formatting around it. */
const BEFORE_MENTION = /[\s*_~|(]/;

interface Context {
  text: string;
  /** Longest name first, so "@Ana Paula" is not "@Ana" and " Paula". */
  mentions: ChatMention[];
}

/** The pairs of markers that style what is between them, tried in this order. */
const SPANS: { marker: string; kind: Styled }[] = [
  { marker: '||', kind: 'spoiler' },
  { marker: '**', kind: 'bold' },
  { marker: '__', kind: 'underline' },
  { marker: '~~', kind: 'strike' },
  { marker: '*', kind: 'italic' },
  { marker: '_', kind: 'italic' },
];

function context(text: string, mentions: ChatMention[] = []): Context {
  return { text, mentions: [...mentions].sort((a, b) => b.name.length - a.name.length) };
}

/** The mention that starts at `at`, if one does. */
function mentionAt(ctx: Context, at: number, start: number, end: number): ChatMention | null {
  const { text } = ctx;
  if (text[at] !== '@' || ctx.mentions.length === 0) return null;
  if (at > start && !BEFORE_MENTION.test(text[at - 1]!)) return null;
  return (
    ctx.mentions.find((m) => at + 1 + m.name.length <= end && text.startsWith(`@${m.name}`, at)) ??
    null
  );
}

/** Where a `code` span starting at `at` ends (past its closing ticks), and its text. */
function codeAt(text: string, at: number, end: number): { end: number; text: string } | null {
  if (text[at] !== '`') return null;
  let ticks = 0;
  while (text[at + ticks] === '`' && ticks < 2) ticks += 1;
  const fence = '`'.repeat(ticks);
  const close = text.indexOf(fence, at + ticks);
  if (close === -1 || close + ticks > end || close === at + ticks) return null;
  let code = text.slice(at + ticks, close);
  // `` `code` `` may pad a tick it holds with a space on each side.
  if (ticks === 2 && code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) {
    code = code.slice(1, -1);
  }
  return { end: close + ticks, text: code };
}

/**
 * Where something that cannot be cut by formatting ends, if one starts at
 * `at`: an escape, code, an address or a mention.
 */
function atomEnd(ctx: Context, at: number, start: number, end: number): number | null {
  const { text } = ctx;
  const c = text[at];
  if (c === '\\' && at + 1 < end && ESCAPABLE.test(text[at + 1]!)) return at + 2;
  if (c === '`') return codeAt(text, at, end)?.end ?? null;
  if (c === '@') {
    const m = mentionAt(ctx, at, start, end);
    return m ? at + 1 + m.name.length : null;
  }
  if (c === 'h' || c === 'H' || c === 'w' || c === 'W') {
    const link = linkAt(text, at, end);
    return link ? at + link.text.length : null;
  }
  return null;
}

/** Whether `marker` may open a span at `at`. */
function opens(text: string, marker: string, at: number, end: number): boolean {
  const from = at + marker.length;
  if (from >= end) return false;
  // Only italics need a word right after; "|| x ||" and "** x **" still style.
  if ((marker === '*' || marker === '_') && SPACE.test(text[from]!)) return false;
  // _italic_ starts a word, so snake_case stays as written.
  if (marker === '_' && at > 0 && WORD.test(text[at - 1]!)) return false;
  return true;
}

/** Whether `marker` at `at` may close a span whose text began at `from`. */
function closes(text: string, marker: string, at: number, end: number): boolean {
  if (at + marker.length > end || !text.startsWith(marker, at)) return false;
  const after = at + marker.length < end ? text[at + marker.length] : undefined;
  const before = text[at - 1]!;
  switch (marker) {
    // The last of a run closes, so ***both*** is bold around italics.
    case '**':
      return after !== '*';
    case '__':
      return after !== '_';
    case '*':
      return !SPACE.test(before);
    case '_': {
      // Read past the span's end, so _italic_s is not italics either.
      const next = text[at + 1];
      return !SPACE.test(before) && (next === undefined || !WORD.test(next));
    }
    default:
      return true;
  }
}

/** Where the span `marker` opened just before `from` closes, or -1. */
function findClose(ctx: Context, marker: string, from: number, start: number, end: number): number {
  const { text } = ctx;
  let j = from;
  while (j < end) {
    const atom = atomEnd(ctx, j, start, end);
    if (atom !== null) {
      j = atom;
      continue;
    }
    // Inside *italics*, **bold** is a pair of its own, not the closing *.
    const double = marker + marker;
    if ((marker === '*' || marker === '_') && text.startsWith(double, j) && j + 2 <= end) {
      j += 2;
      continue;
    }
    if (j > from && closes(text, marker, j, end)) return j;
    j += 1;
  }
  return -1;
}

/** `[label](https://…)` at `at`: where it ends and what it is, or null. */
function maskedAt(
  ctx: Context,
  at: number,
  end: number,
): { end: number; href: string; label: [number, number] } | null {
  const { text } = ctx;
  if (text[at] !== '[') return null;
  const close = text.indexOf('](', at + 1);
  if (close === -1 || close === at + 1 || close >= end) return null;
  const label = text.slice(at + 1, close);
  if (label.includes('\n') || label.includes('[')) return null;
  const target = /^\(<?(https?:\/\/[^\s<>()]+)>?\)/i.exec(text.slice(close + 1, end));
  if (!target) return null;
  // A label that reads as an address could say one place and go to another.
  for (let i = 0; i < label.length; i += 1) if (linkAt(label, i)) return null;
  let href: string;
  try {
    const url = new URL(target[1]!);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    href = url.href;
  } catch {
    return null;
  }
  return { end: close + 1 + target[0].length, href, label: [at + 1, close] };
}

function inline(ctx: Context, start: number, end: number, links = true): Inline[] {
  const { text } = ctx;
  const out: Inline[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ kind: 'text', text: plain });
    plain = '';
  };

  let i = start;
  outer: while (i < end) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < end && ESCAPABLE.test(text[i + 1]!)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const code = codeAt(text, i, end);
      if (code) {
        flush();
        out.push({ kind: 'code', text: code.text });
        i = code.end;
        continue;
      }
    }
    if (c === '@') {
      const mention = mentionAt(ctx, i, start, end);
      if (mention) {
        flush();
        out.push({ kind: 'mention', text: `@${mention.name}`, mention });
        i += mention.name.length + 1;
        continue;
      }
    }
    if (links && (c === 'h' || c === 'H' || c === 'w' || c === 'W')) {
      const link = linkAt(text, i, end);
      if (link?.href) {
        flush();
        out.push({ kind: 'link', href: link.href, children: [{ kind: 'text', text: link.text }] });
        i += link.text.length;
        continue;
      }
    }
    if (links && c === '[') {
      const masked = maskedAt(ctx, i, end);
      if (masked) {
        flush();
        const [from, to] = masked.label;
        out.push({ kind: 'link', href: masked.href, children: inline(ctx, from, to, false) });
        i = masked.end;
        continue;
      }
    }
    for (const { marker, kind } of SPANS) {
      if (!text.startsWith(marker, i) || !opens(text, marker, i, end)) continue;
      const from = i + marker.length;
      const close = findClose(ctx, marker, from, start, end);
      // Markers around nothing but more of themselves, as in ****, style nothing.
      if (close === -1 || !text.slice(from, close).replaceAll(marker[0]!, '')) continue;
      flush();
      out.push({ kind, children: inline(ctx, from, close, links) });
      i = close + marker.length;
      continue outer;
    }
    // A run of markers that opened nothing stays as written, all of it, so
    // the rest of "**" is not tried again as "*".
    if (c === '*' || c === '_' || c === '~' || c === '|') {
      let run = i;
      while (run < end && text[run] === c) run += 1;
      plain += text.slice(i, run);
      i = run;
      continue;
    }
    plain += c;
    i += 1;
  }
  flush();
  return out;
}

/** A line of text, formatted, with the @mentions it holds. */
export function parseInline(text: string, mentions: ChatMention[] = []): Inline[] {
  return inline(context(text, mentions), 0, text.length);
}

const HEADING = /^(#{1,3}) +(\S.*)$/;
const SUBTEXT = /^-# +(\S.*)$/;
const QUOTE = /^> (.*)$|^>$/;
const QUOTE_REST = /^>>>(?: (.*))?$/;
const ITEM = /^( *)(?:([-*])|(\d{1,9})\.) +(\S.*)$/;

interface Entry {
  indent: number;
  ordered: boolean;
  number: number;
  text: string;
}

function buildLists(ctx: Context, entries: Entry[]): ListBlock[] {
  const lists: ListBlock[] = [];
  const base = entries[0]!.indent;
  let k = 0;
  while (k < entries.length) {
    const entry = entries[k]!;
    const current = lists[lists.length - 1];
    const last = current?.items[current.items.length - 1];
    if (entry.indent > base && last) {
      let run = k;
      while (run < entries.length && entries[run]!.indent > base) run += 1;
      last.lists.push(...buildLists(ctx, entries.slice(k, run)));
      k = run;
      continue;
    }
    const item: ListItem = { children: parseInline(entry.text, ctx.mentions), lists: [] };
    if (current && current.ordered === entry.ordered) current.items.push(item);
    else lists.push({ kind: 'list', ordered: entry.ordered, start: entry.number, items: [item] });
    k += 1;
  }
  return lists;
}

/** Lines of text (no code blocks in them) as blocks. */
function lineBlocks(ctx: Context, source: string, quoted: boolean): Block[] {
  const blocks: Block[] = [];
  const lines = source.split('\n');
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join('\n'), ctx.mentions) });
    }
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // Quotes do not nest, as in Discord: "> > x" quotes "> x".
    if (!quoted) {
      const rest = QUOTE_REST.exec(line);
      if (rest) {
        flush();
        const body = [rest[1] ?? '', ...lines.slice(i + 1)].join('\n');
        blocks.push({ kind: 'quote', blocks: lineBlocks(ctx, body, true) });
        return blocks;
      }
      if (QUOTE.test(line)) {
        flush();
        const quotedLines: string[] = [];
        while (i < lines.length) {
          const q = QUOTE.exec(lines[i]!);
          if (!q) break;
          quotedLines.push(q[1] ?? '');
          i += 1;
        }
        i -= 1;
        blocks.push({ kind: 'quote', blocks: lineBlocks(ctx, quotedLines.join('\n'), true) });
        continue;
      }
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2]!, ctx.mentions) });
      continue;
    }
    const subtext = SUBTEXT.exec(line);
    if (subtext) {
      flush();
      blocks.push({ kind: 'subtext', children: parseInline(subtext[1]!, ctx.mentions) });
      continue;
    }
    if (ITEM.test(line)) {
      flush();
      const entries: Entry[] = [];
      while (i < lines.length) {
        const item = ITEM.exec(lines[i]!);
        if (!item) break;
        entries.push({
          indent: item[1]!.length,
          ordered: item[3] !== undefined,
          number: item[3] !== undefined ? Number(item[3]) : 1,
          text: item[4]!,
        });
        i += 1;
      }
      i -= 1;
      blocks.push(...buildLists(ctx, entries));
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function blocks(ctx: Context, source: string): Block[] {
  const out: Block[] = [];
  let at = 0;
  let textFrom = 0;
  const pushText = (to: number, trimStart: boolean, trimEnd: boolean) => {
    let piece = source.slice(textFrom, to);
    if (trimStart) piece = piece.replace(/^\n/, '');
    if (trimEnd) piece = piece.replace(/\n$/, '');
    if (piece) out.push(...lineBlocks(ctx, piece, false));
  };
  let afterCode = false;

  while (at < source.length) {
    const open = source.indexOf('```', at);
    if (open === -1) break;
    if (open > 0 && source[open - 1] === '\\') {
      at = open + 3;
      continue;
    }
    const close = source.indexOf('```', open + 3);
    if (close === -1) break;
    let code = source.slice(open + 3, close);
    let language: string | undefined;
    const first = /^([\w+#.-]+)\n/.exec(code);
    // A word alone on the opening line names the language, unless it is all there is.
    if (first && code.slice(first[0].length).trim()) {
      language = first[1];
      code = code.slice(first[0].length);
    } else {
      code = code.replace(/^\n/, '');
    }
    code = code.replace(/\n$/, '');
    if (!code.trim()) {
      at = close + 3;
      continue;
    }
    pushText(open, afterCode, true);
    out.push(
      language ? { kind: 'codeBlock', text: code, language } : { kind: 'codeBlock', text: code },
    );
    at = close + 3;
    textFrom = at;
    afterCode = true;
  }
  pushText(source.length, afterCode, false);
  return out;
}

/** A message's text as blocks of formatted text, with the @mentions it holds. */
export function parseMessage(body: string, mentions: ChatMention[] = []): Block[] {
  const source = body.replace(/\r\n?/g, '\n');
  return blocks(context(source, mentions), source);
}

/**
 * A message's text on one line, formatted, for the excerpt a reply quotes:
 * headings, quotes and lists give their words, and a code block its code.
 */
export function parseExcerpt(body: string, mentions: ChatMention[] = []): Inline[] {
  const out: Inline[] = [];
  const add = (nodes: Inline[]) => {
    if (out.length && nodes.length) out.push({ kind: 'text', text: ' ' });
    out.push(...nodes);
  };
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (block.kind === 'quote') walk(block.blocks);
      else if (block.kind === 'codeBlock') add([{ kind: 'code', text: block.text }]);
      else if (block.kind === 'list') {
        const items = (l: ListBlock) => {
          for (const item of l.items) {
            add(item.children);
            item.lists.forEach(items);
          }
        };
        items(block);
      } else add(block.children);
    }
  };
  walk(parseMessage(body, mentions));
  return out;
}

/**
 * The text with `marker` put around the selection, or taken away when it is
 * already there, as Ctrl+B and the like do in the message box. With nothing
 * selected the pair goes in at the caret, which lands between them. Null when
 * the result would be longer than `max`.
 */
export function toggleMarker(
  text: string,
  start: number,
  end: number,
  marker: string,
  max: number,
): { text: string; start: number; end: number } | null {
  const n = marker.length;
  const c = marker[0]!;
  const selected = text.slice(start, end);
  const run = (from: number, by: 1 | -1, stop: number) => {
    let count = 0;
    for (let i = from; by > 0 ? i < stop : i >= stop; i += by) {
      if (text[i] !== c) break;
      count += 1;
    }
    return count;
  };
  // Runs of one character mix styles: in ***both*** the odd star is italics
  // and the other two bold, so either can be taken off alone.
  const styled = (count: number) => (n === 2 ? count >= 2 : count % 2 === 1);
  const outside = Math.min(run(start - 1, -1, 0), run(end, 1, text.length));
  if (styled(outside)) {
    return {
      text: text.slice(0, start - n) + selected + text.slice(end + n),
      start: start - n,
      end: end - n,
    };
  }
  const lead = run(start, 1, end);
  const trail = run(end - 1, -1, start);
  if (lead + trail < selected.length && styled(Math.min(lead, trail))) {
    const inner = selected.slice(n, -n);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      start,
      end: start + inner.length,
    };
  }
  const next = text.slice(0, start) + marker + selected + marker + text.slice(end);
  if (next.length > max) return null;
  return { text: next, start: start + n, end: end + n };
}

/** The marker a formatting shortcut puts around the selection, or null for other keys. */
export function shortcutMarker(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === 'x' ? '~~' : null;
  return key === 'b' ? '**' : key === 'i' ? '*' : key === 'u' ? '__' : null;
}
