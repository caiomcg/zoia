/**
 * The silenced chats, remembered per machine as the sound settings are
 * (see sounds/settings.ts). One store shared by the sidebar, which shows and
 * changes it, and the chat stream, which asks it before playing a cue.
 */

import { useSyncExternalStore } from 'react';
import { parseSilencedChats, serializeSilencedChats, withChatSilenced } from './silence';

const STORAGE_KEY = 'zoia.silencedChats';

function read(): ReadonlySet<string> {
  try {
    return parseSilencedChats(localStorage.getItem(STORAGE_KEY));
  } catch {
    return new Set();
  }
}

let current = read();
const listeners = new Set<() => void>();

export function getSilencedChats(): ReadonlySet<string> {
  return current;
}

export function isChatSilenced(chatId: string): boolean {
  return current.has(chatId);
}

export function setChatSilenced(chatId: string, on: boolean): void {
  const next = withChatSilenced(current, chatId, on);
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, serializeSilencedChats(next));
  } catch {
    // Remembering is a convenience; the change still applies this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSilencedChats(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSilencedChats);
}
