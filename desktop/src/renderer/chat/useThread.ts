/**
 * One open thread (ADR 0048): the replies to a message, in the panel beside
 * its chat. The server keeps them as a chat of their own, `<chat>~<message>`,
 * so this reads and writes them through the same calls as any chat, and hands
 * ChatView the same shape useChat does.
 *
 * The message it answers lives in the chat, not the thread: its edits,
 * reactions and deletion arrive as the chat's, and are applied here too.
 * Deleted, it takes the thread with it, and the panel says so.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatAuthor,
  ChatInfo,
  ChatMessage,
  ChatPerson,
  ChatSendExtras,
} from '../../shared/ipc';
import { threadIdOf } from '../../shared/ipc';
import { applyEdit, applyReaction, atOrAfter, laterMarker, mergeMessages } from './model';
import type { ChatThread } from './useChat';

export function useThread({
  chatId,
  rootId,
  chatName,
  me,
  visible,
  available,
  people,
  knownAuthors,
}: {
  /** The chat the thread is in, and the message it answers; null for no thread open. */
  chatId: string | null;
  rootId: string | null;
  chatName: string;
  me: string | null;
  visible: boolean;
  available: boolean;
  /** Who can be @mentioned: whoever can read the chat. */
  people: ChatPerson[];
  /** Authors the chat already knows, so names show before the page arrives. */
  knownAuthors: Record<string, ChatAuthor>;
}) {
  const id = chatId && rootId ? threadIdOf(chatId, rootId) : null;
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [root, setRoot] = useState<ChatMessage | null>(null);
  const [rootGone, setRootGone] = useState(false);
  const [authors, setAuthors] = useState<Record<string, ChatAuthor>>({});
  const [readers, setReaders] = useState<Record<string, string>>({});
  const idRef = useRef(id);
  idRef.current = id;
  const threadRef = useRef(thread);
  threadRef.current = thread;

  const load = useCallback(async (threadId: string) => {
    setThread({
      chatId: threadId,
      messages: [],
      hasMore: false,
      loading: true,
      loadingOlder: false,
      error: null,
    });
    const result = await window.zoia.chat.messages(threadId);
    if (idRef.current !== threadId) return;
    if (!result.ok) {
      if (result.error === 'not_found') setRootGone(true);
      setThread((t) => t && { ...t, loading: false, error: result.error });
      return;
    }
    const page = result.value;
    setThread({
      chatId: threadId,
      messages: mergeMessages(page.messages),
      hasMore: page.hasMore,
      loading: false,
      loadingOlder: false,
      error: null,
    });
    if (page.root) setRoot(page.root);
    setAuthors((known) => ({ ...known, ...page.authors }));
    setReaders(page.readers);
  }, []);

  useEffect(() => {
    setRoot(null);
    setRootGone(false);
    setReaders({});
    if (id && available) void load(id);
    else setThread(null);
  }, [id, available, load]);

  const patchMessages = useCallback((change: (list: ChatMessage[]) => ChatMessage[]) => {
    setThread((t) => t && { ...t, messages: change(t.messages) });
  }, []);

  useEffect(
    () =>
      window.zoia.chat.onEvent((event) => {
        const current = idRef.current;
        if (!current) return;
        switch (event.type) {
          case 'message':
            if (event.message.chatId !== current) return;
            if (event.author) {
              const { author } = event;
              setAuthors((known) => ({ ...known, [event.message.authorId]: author }));
            }
            patchMessages((list) => mergeMessages(list, [event.message]));
            break;
          case 'deleted':
            if (event.chatId === current) {
              patchMessages((list) =>
                list
                  .filter((m) => m.id !== event.messageId)
                  .map((m) =>
                    m.replyTo?.id === event.messageId
                      ? {
                          ...m,
                          replyTo: {
                            id: m.replyTo.id,
                            authorId: m.replyTo.authorId,
                            deleted: true,
                          },
                        }
                      : m,
                  ),
              );
            } else if (event.chatId === chatId && event.messageId === rootId) {
              setRootGone(true);
            }
            break;
          case 'edited':
            if (event.chatId === current) patchMessages((list) => applyEdit(list, event.message));
            else if (event.chatId === chatId && event.message.id === rootId) {
              setRoot((r) => (r ? (applyEdit([r], event.message)[0] ?? r) : r));
            }
            break;
          case 'reaction': {
            if (event.reactor) {
              const { reactor } = event;
              setAuthors((known) => ({ ...known, [event.accountId]: reactor }));
            }
            const apply = (m: ChatMessage) =>
              m.id === event.messageId
                ? {
                    ...m,
                    reactions: applyReaction(m.reactions, event.emoji, event.accountId, event.on),
                  }
                : m;
            if (event.chatId === current) patchMessages((list) => list.map(apply));
            else if (event.chatId === chatId && event.messageId === rootId) {
              setRoot((r) => r && apply(r));
            }
            break;
          }
          case 'read':
            if (event.chatId !== current) return;
            setReaders((r) => ({
              ...r,
              [event.accountId]: laterMarker(r[event.accountId], event.messageId),
            }));
            break;
          case 'stream':
            if (event.connected) void load(current);
            break;
        }
      }),
    [chatId, rootId, load, patchMessages],
  );

  // On screen means read, up to the newest reply.
  const latest = thread?.chatId === id ? thread.messages.at(-1)?.id : undefined;
  const myMarker = me ? readers[me] : undefined;
  useEffect(() => {
    if (!visible || !id || !latest || !me) return;
    if (myMarker && atOrAfter(myMarker, latest)) return;
    setReaders((r) => ({ ...r, [me]: laterMarker(r[me], latest) }));
    void window.zoia.chat.read(id, latest);
  }, [visible, id, latest, me, myMarker]);

  const loadOlder = useCallback(async () => {
    const t = threadRef.current;
    if (!t || !t.hasMore || t.loadingOlder || t.loading) return;
    setThread({ ...t, loadingOlder: true });
    const result = await window.zoia.chat.messages(t.chatId, t.messages[0]?.id);
    if (idRef.current !== t.chatId) return;
    if (!result.ok) {
      setThread((x) => x && { ...x, loadingOlder: false });
      return;
    }
    const page = result.value;
    setThread(
      (x) =>
        x && {
          ...x,
          messages: mergeMessages(page.messages, x.messages),
          hasMore: page.hasMore,
          loadingOlder: false,
        },
    );
    setAuthors((known) => ({ ...known, ...page.authors }));
  }, []);

  const send = useCallback(
    async (body: string, file?: File, extras: ChatSendExtras = {}): Promise<string | null> => {
      const threadId = idRef.current;
      if (!threadId) return 'not_found';
      const result = file
        ? await window.zoia.chat.sendMedia(
            threadId,
            new Uint8Array(await file.arrayBuffer()),
            file.name,
            body,
            extras,
          )
        : await window.zoia.chat.send(threadId, body, extras);
      if (!result.ok) return result.error;
      const { message, author } = result.value;
      if (author) setAuthors((known) => ({ ...known, [message.authorId]: author }));
      patchMessages((list) => mergeMessages(list, [message]));
      return null;
    },
    [patchMessages],
  );

  const deleteMessage = useCallback(
    async (messageId: string): Promise<string | null> => {
      const threadId = idRef.current;
      if (!threadId) return 'not_found';
      const result = await window.zoia.chat.deleteMessage(threadId, messageId);
      if (!result.ok) return result.error;
      patchMessages((list) => list.filter((m) => m.id !== messageId));
      return null;
    },
    [patchMessages],
  );

  const editMessage = useCallback(
    async (messageId: string, body: string, mentions: string[]): Promise<string | null> => {
      const threadId = idRef.current;
      if (!threadId) return 'not_found';
      const result = await window.zoia.chat.editMessage(threadId, messageId, body, mentions);
      if (!result.ok) return result.error;
      patchMessages((list) => applyEdit(list, result.value));
      return null;
    },
    [patchMessages],
  );

  const react = useCallback(
    async (messageId: string, emoji: string, on: boolean): Promise<string | null> => {
      const threadId = idRef.current;
      if (!threadId || !me) return 'not_found';
      const result = await window.zoia.chat.react(threadId, messageId, emoji, on);
      if (!result.ok) return result.error;
      patchMessages((list) =>
        list.map((m) =>
          m.id === messageId ? { ...m, reactions: applyReaction(m.reactions, emoji, me, on) } : m,
        ),
      );
      return null;
    },
    [me, patchMessages],
  );

  const openChat: ChatInfo | null = id
    ? { id, name: chatName, isDefault: false, unread: 0, mentions: 0 }
    : null;

  return {
    available,
    openChat,
    openId: id,
    thread: thread?.chatId === id ? thread : null,
    authors: { ...knownAuthors, ...authors },
    readers,
    people,
    readWhenOpened: undefined as string | null | undefined,
    send,
    deleteMessage,
    editMessage,
    react,
    loadOlder,
    /** The message the thread answers, once loaded. */
    root,
    /** That message was deleted, and the thread with it. */
    rootGone,
  };
}

export type ThreadController = ReturnType<typeof useThread>;
