/**
 * Web addresses in a message, found so they can be clicked. Kept free of
 * React so it can be tested.
 *
 * Only http and https, and `www.` names taken as https: anything else a
 * message says stays text, so a link can never open a file or another app.
 * Punctuation that ends a sentence is not part of the address, nor is a
 * closing bracket the address did not open.
 */

export interface TextPart {
  text: string;
  /** Where it goes, for the part that is a link. */
  href?: string;
}

const ADDRESS = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

/** Trailing characters taken as the sentence's, not the address's. */
function trimEnd(candidate: string): string {
  let end = candidate.length;
  for (;;) {
    const last = candidate[end - 1];
    if (!last) break;
    if (/[.,;:!?'*_~]/.test(last)) {
      end -= 1;
      continue;
    }
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
    const open = pairs[last];
    if (open) {
      const kept = candidate.slice(0, end);
      const opened = kept.split(open).length - 1;
      const closed = kept.split(last).length - 1;
      if (closed > opened) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return candidate.slice(0, end);
}

/** Where a found address goes, or null when it is not one worth a link. */
function hrefOf(address: string): string | null {
  const full = /^www\./i.test(address) ? `https://${address}` : address;
  try {
    const url = new URL(full);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.includes('.') ? url.href : null;
  } catch {
    return null;
  }
}

/** `text` split into plain parts and links, in order. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const address = trimEnd(match[0]);
    const href = address ? hrefOf(address) : null;
    if (!href) continue;
    const start = match.index ?? 0;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: address, href });
    at = start + address.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
