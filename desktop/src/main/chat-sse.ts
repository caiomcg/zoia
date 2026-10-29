/**
 * Reading the chat's Server-Sent Events (ADR 0036). Kept apart from the
 * stream itself, which needs Electron, so it can be tested on its own.
 */

import type { ChatEvent, ShownPresence } from '../shared/ipc';

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
  if (event === 'people') return { type: 'people' };
  if (event === 'deleted' && typeof payload.chatId === 'string') {
    return { type: 'deleted', chatId: payload.chatId, messageId: String(payload.messageId) };
  }
  if (
    event === 'edited' &&
    typeof payload.chatId === 'string' &&
    payload.message &&
    typeof payload.message === 'object'
  ) {
    return {
      type: 'edited',
      chatId: payload.chatId,
      message: payload.message as Extract<ChatEvent, { type: 'edited' }>['message'],
    };
  }
  if (event === 'reaction' && typeof payload.chatId === 'string') {
    return {
      type: 'reaction',
      chatId: payload.chatId,
      messageId: String(payload.messageId),
      emoji: String(payload.emoji),
      accountId: String(payload.accountId),
      on: payload.on !== false,
      reactor: (payload.reactor ?? null) as Extract<ChatEvent, { type: 'reaction' }>['reactor'],
    };
  }
  if (
    event === 'renamed' &&
    typeof payload.accountId === 'string' &&
    typeof payload.name === 'string'
  ) {
    return { type: 'renamed', accountId: payload.accountId, name: payload.name };
  }
  if (event === 'presence' && typeof payload.accountId === 'string') {
    const status = SHOWN.find((s) => s === payload.status);
    return status ? { type: 'presence', accountId: payload.accountId, status } : null;
  }
  return null;
}

const SHOWN: readonly ShownPresence[] = ['online', 'busy', 'away', 'offline'];
