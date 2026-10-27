/**
 * The chat's live stream (ADR 0036): the server's Server-Sent Events at
 * /api/chats/events, read here because the session cookie lives in this
 * process, and handed to the window one event at a time.
 *
 * It reconnects on its own, backing off up to a minute, and says when it is
 * connected or lost so the window can catch up on what it missed: on every
 * reconnect it re-reads the list and the open chat.
 */

import { net } from 'electron';
import type { ChatEvent } from '../shared/ipc';
import { getServerUrl } from './config';
import { parseSse, toChatEvent } from './chat-sse';

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

/** Listens until stopped, passing every event to `emit`. */
export function createChatStream(emit: (event: ChatEvent) => void) {
  let controller: AbortController | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let delay = FIRST_RETRY_MS;

  async function connect() {
    const base = getServerUrl();
    if (!running || !base) return;
    controller = new AbortController();
    let connected = false;
    try {
      const res = await net.fetch(`${base}/api/chats/events`, {
        credentials: 'include',
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      if (!res.ok || !res.body) throw new Error(`stream refused: ${res.status}`);
      connected = true;
      delay = FIRST_RETRY_MS;
      emit({ type: 'stream', connected: true });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const { event, data } of parsed.events) {
          const chatEvent = toChatEvent(event, data);
          if (chatEvent) emit(chatEvent);
        }
      }
    } catch {
      // Refused, unreachable or aborted: all end the same way, below.
    }
    if (connected) emit({ type: 'stream', connected: false });
    if (!running) return;
    timer = setTimeout(() => void connect(), delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }

  return {
    start() {
      if (running) return;
      running = true;
      delay = FIRST_RETRY_MS;
      void connect();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      controller?.abort();
      controller = null;
    },
  };
}
