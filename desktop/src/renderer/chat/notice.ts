/**
 * Which new chat messages call you: a notification under the bell, from the
 * system, and the mention sound (see notify.ts). This module is pure, so the
 * rule can be tested without a window; useChat applies it to the stream.
 *
 * A message calls you when someone else wrote it to you, in a direct chat
 * (ADR 0047) or in a thread of one (ADR 0048), or when it @mentions you
 * anywhere. Never your own, from this machine or another, and never one you
 * are reading as it arrives: its chat, or its thread in the panel, on screen
 * with the window in front.
 */

import type { ChatMessage } from '../../shared/ipc';
import { isDirectChatId, threadParts } from '../../shared/ipc.ts';

export interface ChatCall {
  kind: 'direct' | 'mention';
  /** Where to go to read it: the chat, or the chat its thread is in. */
  chatId: string;
}

export function chatCallFor({
  message,
  me,
  openId,
  openThreadId,
  visible,
}: {
  message: Pick<ChatMessage, 'chatId' | 'authorId' | 'mentions'>;
  /** Your account id; unknown, nothing can be told apart from your own. */
  me: string | null;
  /** The chat open in the main area. */
  openId: string | null;
  /** The thread open in the panel beside it, as `<chat>~<message>`. */
  openThreadId: string | null;
  /** Whether the open chat, and its panel, are on screen with the window in front. */
  visible: boolean;
}): ChatCall | null {
  if (!me || message.authorId === me) return null;
  const thread = threadParts(message.chatId);
  const chatId = thread ? thread.chatId : message.chatId;
  const reading = visible && message.chatId === (thread ? openThreadId : openId);
  if (reading) return null;
  if (isDirectChatId(chatId)) return { kind: 'direct', chatId };
  if (message.mentions?.some((m) => m.id === me)) return { kind: 'mention', chatId };
  return null;
}
