/**
 * Just enough Markdown for release notes: headings, bullet lists, paragraphs,
 * and inline bold, code and links. It produces a tree for React to render,
 * never HTML, so text from GitHub cannot inject markup; and a link is only
 * kept when it is http(s), so it cannot run script either.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] };

export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'list'; items: Inline[][] }
  | { kind: 'paragraph'; children: Inline[] };

const INLINE = /(\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|https?:\/\/[^\s)<>]+)/g;

function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: 'text', text: text.slice(last, index) });
    const [whole, , bold, code, label, target] = match;
    if (bold !== undefined) {
      out.push({ kind: 'bold', children: parseInline(bold) });
    } else if (code !== undefined) {
      out.push({ kind: 'code', text: code });
    } else if (label !== undefined && target !== undefined) {
      const href = safeHref(target);
      out.push(
        href ? { kind: 'link', href, children: parseInline(label) } : { kind: 'text', text: label },
      );
    } else {
      const href = safeHref(whole);
      out.push(
        href
          ? { kind: 'link', href, children: [{ kind: 'text', text: whole }] }
          : { kind: 'text', text: whole },
      );
    }
    last = index + whole.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  // Item text is kept raw until the list ends, so a wrapped item's following
  // lines can join it before it is parsed.
  let list: string[] | null = null;

  const flush = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) });
      paragraph = [];
    }
    if (list) {
      blocks.push({ kind: 'list', items: list.map(parseInline) });
      list = null;
    }
  };

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (!line) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '').length,
        children: parseInline(heading[2] ?? ''),
      });
    } else if (item) {
      if (paragraph.length) flush();
      list ??= [];
      list.push(item[1] ?? '');
    } else if (list && /^\s/.test(raw)) {
      // An indented line under an item continues it, as a hard-wrapped
      // bullet does; GitHub renders it as one item and so must this.
      list[list.length - 1] += ` ${line}`;
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}
