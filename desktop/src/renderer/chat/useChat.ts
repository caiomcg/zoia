/**
 * The text chats (ADR 0035), as the window sees them: the list with unread
 * counts, the open chat's messages, who has read what, and the live stream
 * that keeps all of it current.
 *
 * A chat is read when its messages are on screen: `visible` says so, and
 * then the newest message is marked read. Until then a message from someone
 * else counts as unread.
 *
 * Against a server without chat (older, or no message database configured
 * at all) `enabled` stays false and nothing here shows.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAuthor, ChatInfo, ChatList, ChatMessage } from '../../shared/ipc';
import { atOrAfter, laterMarker, mergeMessages } from './model';

export interface ChatThread {
  chatId: string;
  /** Oldest first. */
  messages: ChatMessage[];
  hasMore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

/** How long "new messages" stays once the chat is on screen. */
const DIVIDER_SEEN_MS = 3_000;

/** Codes a server without chat answers with: the route is not there. */
const NO_CHAT = new Set(['http_404', 'http_501']);

export function useChat({
  usable,
  me,
  visible,
}: {
  /** Signed in and approved. */
  usable: boolean;
  /** Your account id. */
  me: string | null;
  /** Whether the open chat's messages are on screen and the window has focus. */
  visible: boolean;
}) {
  const [list, setList] = useState<ChatList | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [authors, setAuthors] = useState<Record<string, ChatAuthor>>({});
  const [readers, setReaders] = useState<Record<string, string>>({});
  // Your read marker when you last came to the chat: where "new messages"
  // begins. The line shows until you have had the chat on screen for a
  // moment, or have answered, and comes back for what arrives while away.
  const [readWhenOpened, setReadWhenOpened] = useState<string | null>(null);
  const [showDivider, setShowDivider] = useState(true);

  const openRef = useRef(openId);
  openRef.current = openId;
  const meRef = useRef(me);
  meRef.current = me;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const threadRef = useRef(thread);
  threadRef.current = thread;

  const refresh = useCallback(async () => {
    const result = await window.zoia.chat.list();
    if (result.ok) {
      setEnabled(true);
      setList(result.value);
    } else if (NO_CHAT.has(result.error)) {
      setEnabled(false);
    }
  }, []);

  const loadThread = useCallback(async (chatId: string) => {
    setThread({
      chatId,
      messages: [],
      hasMore: false,
      loading: true,
      loadingOlder: false,
      error: null,
    });
    const result = await window.zoia.chat.messages(chatId);
    if (openRef.current !== chatId) return;
    if (!result.ok) {
      setThread((t) => t && { ...t, loading: false, error: result.error });
      return;
    }
    const page = result.value;
    setThread({
      chatId,
      messages: mergeMessages(page.messages),
      hasMore: page.hasMore,
      loading: false,
      loadingOlder: false,
      error: null,
    });
    setAuthors((known) => ({ ...known, ...page.authors }));
    setReaders(page.readers);
    setReadWhenOpened(meRef.current ? (page.readers[meRef.current] ?? null) : null);
    setShowDivider(true);
  }, []);

  // The list, and the stream that keeps it current, while signed in.
  useEffect(() => {
    if (!usable) {
      setList(null);
      setEnabled(false);
      return undefined;
    }
    void refresh();
    void window.zoia.chat.listen(true);
    return () => void window.zoia.chat.listen(false);
  }, [usable, refresh]);

  // The default chat is open until another is chosen, and again if the open
  // one is removed.
  useEffect(() => {
    if (!list) return;
    if (!openId || !list.chats.some((c) => c.id === openId)) {
      setOpenId(list.chats[0]?.id ?? null);
    }
  }, [list, openId]);

  const available = list?.available ?? false;
  useEffect(() => {
    if (openId && available) void loadThread(openId);
    else setThread(null);
  }, [openId, available, loadThread]);

  const setUnread = useCallback((chatId: string, next: (n: number) => number) => {
    setList(
      (l) =>
        l && {
          ...l,
          chats: l.chats.map((c) =>
            c.id === chatId && c.unread !== null ? { ...c, unread: next(c.unread) } : c,
          ),
        },
    );
  }, []);

  useEffect(
    () =>
      window.zoia.chat.onEvent((event) => {
        switch (event.type) {
          case 'chats':
            void refresh();
            break;
          case 'stream':
            // Reconnected: whatever happened while it was down was not pushed.
            if (event.connected) {
              void refresh();
              if (openRef.current) void loadThread(openRef.current);
            }
            break;
          case 'message': {
            const { message, author } = event;
            if (author) setAuthors((known) => ({ ...known, [message.authorId]: author }));
            const isOpen = message.chatId === openRef.current;
            if (isOpen) {
              setThread((t) =>
                t && t.chatId === message.chatId
                  ? { ...t, messages: mergeMessages(t.messages, [message]) }
                  : t,
              );
            }
            if (message.authorId !== meRef.current && !(isOpen && visibleRef.current)) {
              setUnread(message.chatId, (n) => Math.min(n + 1, 100));
            }
            break;
          }
          case 'read':
            if (event.reader) {
              const { reader } = event;
              setAuthors((known) => ({ ...known, [event.accountId]: reader }));
            }
            if (event.chatId === openRef.current) {
              setReaders((r) => ({
                ...r,
                [event.accountId]: laterMarker(r[event.accountId], event.messageId),
              }));
            }
            // Read on another of your machines: its count is out of date here.
            if (event.accountId === meRef.current && event.chatId !== openRef.current) {
              void refresh();
            }
            break;
        }
      }),
    [refresh, loadThread, setUnread],
  );

  // On screen means read, up to the newest message.
  const latest = thread?.messages.at(-1)?.id;
  const myMarker = me ? readers[me] : undefined;
  useEffect(() => {
    if (!visible || !openId || !latest || !me) return;
    if (myMarker && atOrAfter(myMarker, latest)) return;
    setReaders((r) => ({ ...r, [me]: laterMarker(r[me], latest) }));
    setUnread(openId, () => 0);
    void window.zoia.chat.read(openId, latest);
  }, [visible, openId, latest, me, myMarker, setUnread]);

  // Leaving the chat, or the window, starts a new "new messages": whatever
  // arrives from here on is past the line when you come back.
  const markerRef = useRef(myMarker);
  markerRef.current = myMarker;
  useEffect(() => {
    if (visible) return;
    setReadWhenOpened(markerRef.current ?? null);
    setShowDivider(true);
  }, [visible]);

  // Seen for a moment, the line has done its job.
  const loaded = thread !== null && !thread.loading;
  useEffect(() => {
    if (!visible || !showDivider || !loaded) return undefined;
    const timer = setTimeout(() => setShowDivider(false), DIVIDER_SEEN_MS);
    return () => clearTimeout(timer);
  }, [visible, showDivider, loaded, openId]);

  const loadOlder = useCallback(async () => {
    const t = threadRef.current;
    if (!t || !t.hasMore || t.loadingOlder || t.loading) return;
    setThread({ ...t, loadingOlder: true });
    const result = await window.zoia.chat.messages(t.chatId, t.messages[0]?.id);
    if (openRef.current !== t.chatId) return;
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

  /**
   * Sends to the open chat: text, or a photo or video with `body` as its
   * caption. Resolves to the server's refusal code, or null.
   */
  const send = useCallback(async (body: string, file?: File): Promise<string | null> => {
    const chatId = openRef.current;
    if (!chatId) return 'not_found';
    const result = file
      ? await window.zoia.chat.sendMedia(
          chatId,
          new Uint8Array(await file.arrayBuffer()),
          file.name,
          body,
        )
      : await window.zoia.chat.send(chatId, body);
    if (!result.ok) return result.error;
    const { message, author } = result.value;
    if (author) setAuthors((known) => ({ ...known, [message.authorId]: author }));
    // Answering is the surest sign the new messages were read.
    setShowDivider(false);
    setThread((t) =>
      t && t.chatId === chatId ? { ...t, messages: mergeMessages(t.messages, [message]) } : t,
    );
    return null;
  }, []);

  /** Runs an admin change, then re-reads the list. Resolves to a refusal code, or null. */
  const change = useCallback(
    async (request: Promise<{ ok: true } | { ok: false; error: string }>) => {
      const result = await request;
      void refresh();
      return result.ok ? null : result.error;
    },
    [refresh],
  );

  const chats: ChatInfo[] = list?.chats ?? [];
  return {
    enabled,
    available,
    chats,
    max: list?.max ?? 1,
    ceiling: list?.ceiling ?? 1,
    openId,
    openChat: chats.find((c) => c.id === openId) ?? null,
    open: setOpenId,
    thread,
    authors,
    readers,
    /** Where "new messages" begins, or null for no line at all. */
    readWhenOpened: showDivider ? readWhenOpened : undefined,
    send,
    loadOlder,
    create: (name: string) => change(window.zoia.chat.create(name)),
    rename: (id: string, name: string) => change(window.zoia.chat.rename(id, name)),
    remove: (id: string) => change(window.zoia.chat.remove(id)),
    setLimit: (max: number) => change(window.zoia.chat.setLimit(max)),
    /** Unread across every chat, for a badge on the way back to the chat. */
    totalUnread: chats.reduce((sum, c) => sum + (c.unread ?? 0), 0),
  };
}

export type ChatController = ReturnType<typeof useChat>;
