/**
 * ! commands in the chat (ADR 0041), kept free of React so they can be
 * tested: finding the "!query" being typed, the commands it may mean, and
 * putting a chosen one in its place. The commands are the addons' bound to
 * the chat, under the names the super admin gave them on this server.
 *
 * A command is only ever the start of a message, as the server only reads it
 * there, so a ! anywhere else is just a !.
 */

import type { ChatCommand } from '../../shared/ipc';

/** What is being typed after the !, which starts the message. */
export interface CommandQuery {
  query: string;
}

/** The !query at the caret, or null: the message's first word, while it is being typed. */
export function commandQuery(text: string, caret: number): CommandQuery | null {
  if (!text.startsWith('!')) return null;
  const word = /^!(\S*)/.exec(text)![1]!;
  // Past the first word, the arguments are being typed instead.
  if (caret < 1 || caret > word.length + 1) return null;
  return { query: text.slice(1, caret) };
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Commands whose name starts with the query, alphabetical. */
export function matchCommands(commands: ChatCommand[], query: string, limit = 8): ChatCommand[] {
  const q = fold(query);
  return commands
    .filter((c) => fold(c.name).startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The text with its first word replaced by "!name ", and where the caret goes. */
export function applyCommand(text: string, name: string): { text: string; caret: number } {
  const rest = text.replace(/^!\S*/, '').replace(/^ /, '');
  const inserted = `!${name} `;
  return { text: inserted + rest, caret: inserted.length };
}
