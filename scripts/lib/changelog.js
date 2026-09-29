/**
 * A changelog entry, `changelog/<version>.md`, split into the sentence the
 * update prompt shows and the Markdown the release page and "What's new" show.
 *
 * The sentence lives in a front-matter block at the top of the entry:
 *
 *   ---
 *   summary: Smooth, hardware-encoded game sharing on NVIDIA graphics cards.
 *   ---
 *
 * It is stripped from the body, because the app renders the body and would
 * show the block as text.
 */

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * @param {string} text
 * @returns {{ summary: string | null, body: string }}
 */
export function parseEntry(text) {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { summary: null, body: text };
  const summary = /^summary:[ \t]*(.+)$/m.exec(match[1])?.[1].trim() || null;
  return { summary, body: text.slice(match[0].length) };
}
