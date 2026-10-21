/**
 * Reading the chat's Server-Sent Events (ADR 0035). Kept apart from the
 * stream itself, which needs Electron, so it can be tested on its own.
 */

import type { ChatEvent } from '../shared/ipc';

/**
 * Splits Server-Sent Events text into events. Returns the ones complete in
 * `buffer` and what is left over, which the next chunk continues. Comments
 * (lines starting with ':') are the server's heartbeats and are skipped.
 */
export function parseSse(buffer: string): {
  events: Array<{ event: string; data: string }>;
  rest: string;
} {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = buffer.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/** A server event as the window receives it, or null for one it does not know. */
export function toChatEvent(event: string, data: string): ChatEvent | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event === 'message' && payload.message) {
    return {
      type: 'message',
      message: payload.message as Extract<ChatEvent, { type: 'message' }>['message'],
      author: (payload.author ?? null) as Extract<ChatEvent, { type: 'message' }>['author'],
    };
  }
  if (event === 'read' && typeof payload.chatId === 'string') {
    return {
      type: 'read',
      chatId: payload.chatId,
      accountId: String(payload.accountId),
      messageId: String(payload.messageId),
      reader: (payload.reader ?? null) as Extract<ChatEvent, { type: 'read' }>['reader'],
    };
  }
  if (event === 'chats') return { type: 'chats' };
  return null;
}
