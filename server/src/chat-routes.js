/**
 * The chat API (ADR 0036): the list of chats, their messages, who has read
 * what, and a Server-Sent Events stream that pushes each change as it
 * happens. Mounted at /api/chats by app.js, which owns sessions.
 *
 * The list is always there (SQLite). Messages need ScyllaDB, which may still
 * be starting or not configured at all; until it answers, routes that need it
 * say `chat_unavailable` and the list carries `available: false`.
 *
 * Every route needs an approved session. Adding, renaming and removing chats,
 * and how many there may be, need an admin, checked here on every request
 * rather than trusted from the app (AGENTS.md invariant 4).
 */

import express from 'express';
import rateLimit from 'express-rate-limit';

import { CHAT_CEILING } from './chats.js';
import { isAdmin } from './accounts.js';
import {
  MENTIONS_MAX,
  REACTIONS_MAX,
  cleanBody,
  cleanEmoji,
  replySnapshot,
  threadIdOf,
} from './messages.js';
import { MEDIA_MAX_BYTES, cleanFileName } from './chat-media.js';
import { isDirectId, isMember, peerOf } from './direct-chats.js';

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

/** How often an open stream is kept alive, and its session checked again. */
const HEARTBEAT_MS = 25_000;

/** Streams one account may hold open: a few windows and machines, not a flood. */
const STREAMS_PER_ACCOUNT = 10;

const ERRORS = {
  invalid_name: 400,
  invalid_limit: 400,
  invalid_message: 400,
  invalid_cursor: 400,
  invalid_reply: 400,
  invalid_reaction: 400,
  invalid_person: 400,
  unsupported_media: 415,
  media_too_large: 413,
  forbidden: 403,
  not_found: 404,
  chat_limit: 409,
  too_many_reactions: 409,
  default_chat: 409,
  too_many_streams: 429,
  chat_unavailable: 503,
};

const refuse = (res, reason) => res.status(ERRORS[reason] ?? 400).json({ error: reason });

/** Everyone listening, in this process. One app server, so no broker is needed. */
export function createChatHub() {
  const streams = new Set();
  return {
    add(stream) {
      streams.add(stream);
      return () => streams.delete(stream);
    },
    count(accountId) {
      let n = 0;
      for (const s of streams) if (s.accountId === accountId) n += 1;
      return n;
    },
    /**
     * Sends an event to every stream, or, with `to`, only to those of these
     * account ids: a direct chat's events never reach anyone else (ADR 0047).
     */
    publish(event, data, to = null) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const only = to ? new Set(to) : null;
      for (const s of streams) if (!only || only.has(s.accountId)) s.write(frame);
    },
  };
}

/**
 * @param {object} options
 * @param {ReturnType<import('./chats.js').createChatStore>} options.chats
 * @param {() => ReturnType<import('./messages.js').createMessageStore> | null} options.messages
 *   the message store, or null while ScyllaDB is not connected
 * @param {ReturnType<import('./chat-media.js').createMediaStore> | null} [options.media]
 *   where photos and videos are kept; without it, sending them is refused
 * @param {object} options.accountStore
 * @param {Function} options.requireSession
 * @param {Function} options.requireAdmin
 * @param {(req) => Promise<object | null>} options.recheck the request's
 *   session as it stands now, for a stream that outlives its request
 * @param {ReturnType<import('./presence.js').createPresence> | null} [options.presence]
 *   told of each stream, since having one open is being on the server
 */
export function chatRoutes({
  chats,
  // Direct messages (ADR 0047); without it there are none.
  directChats = null,
  messages,
  media = null,
  accountStore,
  requireSession,
  requireAdmin,
  recheck,
  presence = null,
  hub = createChatHub(),
  onMessage = null,
  commandsIn = null,
  heartbeatMs = HEARTBEAT_MS,
  sendLimit = { windowMs: 10_000, limit: 20 },
  reactLimit = { windowMs: 10_000, limit: 30 },
  typingLimit = { windowMs: 10_000, limit: 20 },
  logger = console,
}) {
  const router = express.Router();

  // Per person, not per address: everyone behind one router must not share it.
  const sendLimiter = rateLimit({
    ...sendLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.user.accountId,
    message: { error: 'too_many_messages' },
  });
  // Apart from sending, so reacting a lot never stops anyone answering.
  const reactLimiter = rateLimit({
    ...reactLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.user.accountId,
    message: { error: 'too_many_reactions' },
  });
  // Typing is said every few seconds while it lasts: generous, but bounded.
  const typingLimiter = rateLimit({
    ...typingLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.user.accountId,
    message: { error: 'too_many_requests' },
  });

  /** The message store, or a refusal when ScyllaDB is not there. */
  function store(res) {
    const current = messages();
    if (!current) refuse(res, 'chat_unavailable');
    return current;
  }

  /**
   * What a chat id names, as `accountId` may see it, or null:
   *
   * - a chat (eight hex characters), which everyone sees;
   * - a direct chat (`dm-…`, ADR 0047), only to its two members: to anyone
   *   else it is not there at all, admins included;
   * - a thread (`<chat>~<message id>`, ADR 0048): the replies to one message,
   *   seen by whoever sees its chat. Its photos and videos go in its chat's
   *   folder, so they go with the chat.
   *
   * `members` is who may see it, or null for everyone; `folder` is where its
   * files are kept. `unavailable` is a thread asked for while ScyllaDB, which
   * knows whether its message exists, is not there.
   */
  async function resolveChat(id, accountId) {
    if (typeof id !== 'string') return null;
    const tilde = id.indexOf('~');
    if (tilde !== -1) {
      const parent = await resolveChat(id.slice(0, tilde), accountId);
      const rootId = id.slice(tilde + 1);
      if (!parent || parent.unavailable || parent.kind === 'thread') return null;
      if (!isMessageCursor(rootId)) return null;
      const current = messages();
      if (!current) return { unavailable: true };
      const root = await current.get({ chatId: parent.id, id: rootId });
      if (!root) return null;
      return {
        kind: 'thread',
        id: threadIdOf(parent.id, root.id),
        name: parent.name,
        createdAt: root.sentAt,
        members: parent.members,
        folder: parent.folder,
        parent,
        root,
      };
    }
    if (isDirectId(id)) {
      const direct = directChats ? await directChats.find(id) : null;
      if (!direct || !isMember(direct, accountId)) return null;
      return {
        kind: 'direct',
        id: direct.id,
        name: null,
        createdAt: direct.createdAt,
        members: [direct.memberA, direct.memberB],
        folder: direct.id,
        direct,
      };
    }
    const chat = await chats.find(id);
    return chat ? { ...chat, kind: 'public', members: null, folder: chat.id } : null;
  }

  async function chatOf(req, res) {
    const chat = await resolveChat(req.params.id, req.user.accountId);
    if (!chat) {
      refuse(res, 'not_found');
      return null;
    }
    if (chat.unavailable) {
      refuse(res, 'chat_unavailable');
      return null;
    }
    return chat;
  }

  /** Tells whoever may see `chat` what happened in it. */
  const tell = (chat, event, data) => hub.publish(event, data, chat.members);

  /** How an author is shown: name and picture version, never the email. */
  async function authorsOf(ids) {
    const authors = {};
    for (const id of new Set(ids)) {
      const account = await accountStore.get(id);
      authors[id] = account
        ? {
            name: account.name,
            avatar: account.avatar ?? null,
            // An addon's bot, so the app can set its messages apart (ADR 0041).
            ...(account.addonId ? { bot: true } : {}),
          }
        : null;
    }
    return authors;
  }

  const publicChat = ({ id, name, isDefault }) => ({ id, name, isDefault });

  /**
   * The snapshot of the message `replyTo` names, in this chat; undefined for
   * no reply, null for one that is not there to answer.
   */
  async function replyOf(current, chat, replyTo) {
    if (replyTo === undefined || replyTo === null || replyTo === '') return undefined;
    if (typeof replyTo !== 'string') return null;
    const original = await current.get({ chatId: chat.id, id: replyTo });
    if (!original) return null;
    const author = await accountStore.get(original.authorId);
    return replySnapshot(original, author?.name);
  }

  /**
   * A reply keeps the opening words of what it answers. When that message has
   * since been deleted, its words go with it: the quote only says so. When it
   * has been edited, the quote shows it as it reads now (ADR 0043). One read
   * by full key per reply on the page, and none for a page without replies.
   */
  async function withCurrentReplies(current, chat, list) {
    const answered = [...new Set(list.filter((m) => m.replyTo).map((m) => m.replyTo.id))];
    if (answered.length === 0) return list;
    const originals = new Map();
    await Promise.all(
      answered.map(async (id) => {
        originals.set(id, await current.get({ chatId: chat.id, id }));
      }),
    );
    return list.map((m) => {
      if (!m.replyTo) return m;
      const original = originals.get(m.replyTo.id);
      if (!original) {
        return { ...m, replyTo: { id: m.replyTo.id, authorId: m.replyTo.authorId, deleted: true } };
      }
      if (!original.editedAt) return m;
      return { ...m, replyTo: replySnapshot(original, m.replyTo.authorName) };
    });
  }

  /**
   * Each message that has replies with its thread's summary (ADR 0048):
   * { count, lastReplyAt, participants }. A thread's own replies have none.
   */
  async function withThreads(current, chat, list) {
    if (list.length === 0 || chat.kind === 'thread' || !current.threads) return list;
    const found = await current.threads({ chatId: chat.id, rootIds: list.map((m) => m.id) });
    return list.map((m) => (found[m.id] ? { ...m, thread: found[m.id] } : m));
  }

  /**
   * After a reply in a thread is written or deleted: counts the thread again
   * and tells whoever sees its chat, so the message it answers shows how many.
   */
  async function threadChanged(current, chat) {
    if (chat.kind !== 'thread' || !current.refreshThread) return;
    const thread = await current.refreshThread({ chatId: chat.parent.id, rootId: chat.root.id });
    tell(chat.parent, 'thread', { chatId: chat.parent.id, rootId: chat.root.id, thread });
  }

  /** After a message is written in a direct chat, it shows for both, newest first. */
  async function directTouched(chat) {
    if (chat.kind === 'direct') await directChats.touch(chat.id).catch(() => {});
  }

  /** Each message with its reactions, as [{ emoji, accountIds }]; none is []. */
  async function withReactions(current, chat, list) {
    if (list.length === 0) return list;
    const found = await current.reactions({ chatId: chat.id, ids: list.map((m) => m.id) });
    return list.map((m) => ({ ...m, reactions: found[m.id] ?? [] }));
  }

  /**
   * Who a message @mentions, as { id, name }: people who exist and are let
   * in, and whose @name is in what was written, so a mention cannot be
   * slipped in unseen. Anything else asked for is dropped, not refused.
   */
  async function mentionsOf(ids, body, chat) {
    if (!Array.isArray(ids) || !body) return [];
    const mentions = [];
    for (const id of new Set(ids.filter((x) => typeof x === 'string').slice(0, MENTIONS_MAX))) {
      // In a direct chat only its two can be called: nobody else may read it.
      if (chat?.members && !chat.members.includes(id)) continue;
      const account = await accountStore.get(id);
      if (account?.status === 'active' && account.name && body.includes(`@${account.name}`)) {
        mentions.push({ id: account.id, name: account.name });
      }
    }
    return mentions;
  }

  // ---- the list ----------------------------------------------------------

  router.get('/', requireSession, async (req, res) => {
    const current = messages();
    const list = await chats.list();
    const counts = current
      ? await Promise.all(
          list.map((chat) =>
            current
              .unreadCounts({
                chatId: chat.id,
                accountId: req.user.accountId,
                since: chat.createdAt,
              })
              .catch(() => null),
          ),
        )
      : [];
    res.json({
      // Mentions: how many of the unread @mention you, for a badge of their own.
      chats: list.map((chat, i) => ({
        ...publicChat(chat),
        unread: counts[i]?.unread ?? null,
        mentions: counts[i]?.mentions ?? null,
      })),
      // Yours alone (ADR 0047): nobody else is told they exist.
      direct: await directList(current, req.user.accountId),
      max: await chats.max(),
      ceiling: CHAT_CEILING,
      available: Boolean(current),
    });
  });

  /** A direct chat as its member `accountId` sees it: who it is with. */
  async function directInfo(direct, accountId) {
    const peer = await accountStore.get(peerOf(direct, accountId));
    if (!peer) return null;
    return {
      id: direct.id,
      peer: { id: peer.id, name: peer.name, avatar: peer.avatar ?? null },
      lastMessageAt: direct.lastMessageAt ?? null,
    };
  }

  async function directList(current, accountId) {
    if (!directChats) return [];
    const list = await directChats.listFor(accountId);
    const out = [];
    for (const direct of list) {
      const info = await directInfo(direct, accountId);
      if (!info) continue;
      const counts = current
        ? await current
            .unreadCounts({ chatId: direct.id, accountId, since: direct.createdAt })
            .catch(() => null)
        : null;
      out.push({ ...info, unread: counts?.unread ?? null, mentions: counts?.mentions ?? null });
    }
    return out;
  }

  // Opens a direct chat with someone, or finds the one there is (ADR 0047).
  // Anyone let in, never yourself, and never a bot: an addon must not be
  // handed anyone's private conversation.
  router.post('/direct', requireSession, async (req, res) => {
    if (!directChats) return refuse(res, 'not_found');
    const { accountId } = req.user;
    const otherId = req.body?.accountId;
    const other = typeof otherId === 'string' ? await accountStore.get(otherId) : null;
    if (!other || other.id === accountId || other.status !== 'active' || other.addonId) {
      return refuse(res, 'invalid_person');
    }
    const direct = await directChats.open(accountId, other.id);
    res.json({ chat: { ...(await directInfo(direct, accountId)), unread: 0, mentions: 0 } });
  });

  router.post('/', requireAdmin, async (req, res) => {
    const result = await chats.add({ name: req.body?.name, by: req.user.accountId });
    if (!result.ok) return refuse(res, result.reason);
    hub.publish('chats', {});
    res.status(201).json({ chat: publicChat(result.chat) });
  });

  // Admins decide how many chats there may be.
  router.put('/limit', requireAdmin, async (req, res) => {
    const result = await chats.setMax(req.body?.max, { by: req.user.accountId });
    if (!result.ok) return refuse(res, result.reason);
    hub.publish('chats', {});
    res.json({ max: result.max });
  });

  router.patch('/:id', requireAdmin, async (req, res) => {
    const result = await chats.rename(req.params.id, req.body?.name, { by: req.user.accountId });
    if (!result.ok) return refuse(res, result.reason);
    hub.publish('chats', {});
    res.json({ chat: publicChat(result.chat) });
  });

  // The chat goes from the list at once. Its messages follow when ScyllaDB
  // can take the delete; if it cannot, they are orphans under an id that is
  // never reused, and nobody can reach them.
  router.delete('/:id', requireAdmin, async (req, res) => {
    const result = await chats.remove(req.params.id, { by: req.user.accountId });
    if (!result.ok) return refuse(res, result.reason);
    hub.publish('chats', {});
    res.json({ ok: true });
    const current = messages();
    if (current) {
      current
        .removeChat({ chatId: result.chat.id, since: result.chat.createdAt })
        .catch((err) =>
          logger.warn(`[chat] messages of ${result.chat.id} not deleted: ${err.message}`),
        );
    }
    media
      ?.removeChat(result.chat.id)
      .catch((err) => logger.warn(`[chat] media of ${result.chat.id} not deleted: ${err.message}`));
  });

  // Who can be @mentioned: everyone let in, by name, picture and role (the
  // People tab crowns admins), never by email. Before /:id, like /events.
  router.get('/people', requireSession, async (_req, res) => {
    const people = (await accountStore.list())
      .filter((a) => a.status === 'active' && a.name)
      .map((a) => ({
        id: a.id,
        name: a.name,
        avatar: a.avatar ?? null,
        role: a.role,
        // An addon's bot, so the app can say so (ADR 0041).
        ...(a.addonId ? { bot: true } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ people });
  });

  // ---- live updates --------------------------------------------------------
  // Before /:id, which would otherwise take "events" for a chat id.

  router.get('/events', requireSession, (req, res) => {
    const { accountId } = req.user;
    if (hub.count(accountId) >= STREAMS_PER_ACCOUNT) return refuse(res, 'too_many_streams');

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(': connected\n\n');

    const stream = { accountId, write: (frame) => res.write(frame) };
    const remove = hub.add(stream);
    // An open stream is the app being open: the person is on the server.
    const leave = presence?.connect(accountId, req.user.id);

    // A stream lives far longer than a session check. Signing the machine out
    // or disabling the account must end it, as it ends every other request.
    const heartbeat = setInterval(async () => {
      const user = await recheck(req).catch(() => null);
      if (!user || user.status !== 'active') return res.end();
      res.write(': heartbeat\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      remove();
      leave?.();
    });
  });

  // ---- messages ------------------------------------------------------------

  router.get('/:id/messages', requireSession, async (req, res) => {
    const chat = await chatOf(req, res);
    if (!chat) return;
    const current = store(res);
    if (!current) return;

    const before = req.query.before;
    if (before !== undefined && (typeof before !== 'string' || !isMessageCursor(before))) {
      return refuse(res, 'invalid_cursor');
    }
    const asked = Number(req.query.limit ?? PAGE_DEFAULT);
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, PAGE_MAX) : PAGE_DEFAULT;

    // One more than asked, to know whether there is another page.
    const page = await current.page({
      chatId: chat.id,
      since: chat.createdAt,
      before: before ?? null,
      limit: limit + 1,
    });
    const list = await withThreads(
      current,
      chat,
      await withReactions(
        current,
        chat,
        await withCurrentReplies(current, chat, page.slice(0, limit)),
      ),
    );
    const readers = await current.readMarkers(chat.id);
    // A thread's page comes with the message it answers, as it reads now.
    const root =
      chat.kind === 'thread'
        ? (await withReactions(current, chat.parent, [chat.root]))[0]
        : undefined;
    res.json({
      messages: list,
      hasMore: page.length > limit,
      ...(root ? { root } : {}),
      // Readers and who reacted too, so each can be named.
      authors: await authorsOf([
        ...list.map((m) => m.authorId),
        ...readers.keys(),
        ...list.flatMap((m) => m.reactions.flatMap((r) => r.accountIds)),
        ...(root ? [root.authorId, ...root.reactions.flatMap((r) => r.accountIds)] : []),
        ...list.flatMap((m) => m.thread?.participants ?? []),
      ]),
      readers: Object.fromEntries(readers),
    });
  });

  router.post('/:id/messages', requireSession, sendLimiter, async (req, res) => {
    const chat = await chatOf(req, res);
    if (!chat) return;
    const current = store(res);
    if (!current) return;
    const body = cleanBody(req.body?.body);
    if (!body) return refuse(res, 'invalid_message');
    const replyTo = await replyOf(current, chat, req.body?.replyTo);
    if (replyTo === null) return refuse(res, 'invalid_reply');
    const mentions = await mentionsOf(req.body?.mentions, body, chat);

    const { accountId } = req.user;
    const message = await current.send({
      chatId: chat.id,
      authorId: accountId,
      body,
      replyTo,
      mentions,
    });
    // Whoever wrote it has read up to it.
    await current.markRead({ chatId: chat.id, accountId, messageId: message.id });
    await directTouched(chat);

    const author = { name: req.user.name, avatar: req.user.avatar ?? null };
    tell(chat, 'message', { message, author });
    tell(chat, 'read', { chatId: chat.id, accountId, messageId: message.id, reader: author });
    res.status(201).json({ message, author });
    await threadChanged(current, chat).catch((err) =>
      logger.warn(`[chat] thread ${chat.id} not counted: ${err.message}`),
    );
    // After answering: an addon's command is the addon's business, not the
    // sender's. Only in the chats everyone sees: never a direct chat, nor a thread.
    if (chat.kind === 'public') void onMessage?.({ chat, message, author, user: req.user });
  });

  // The ! commands that may be typed in a chat, under this server's names,
  // for autocomplete (ADR 0041).
  router.get('/:id/commands', requireSession, async (req, res) => {
    const chat = await chatOf(req, res);
    if (!chat) return;
    const commands = commandsIn && chat.kind === 'public' ? await commandsIn(chat.id) : [];
    res.json({
      commands: commands.map(({ name, description, usage, addon }) => ({
        name,
        description,
        addon,
        ...(usage ? { usage } : {}),
      })),
    });
  });

  // Only its author may edit a message, an admin included (ADR 0043): an
  // admin may take someone's words down, never put others in their mouth.
  // The new text is held to the rules of sending it, and its mentions are
  // read again from it. A photo or video stays; its caption may go. Nobody
  // is notified again: an edit changes what was said, not who was called.
  router.patch('/:id/messages/:messageId', requireSession, sendLimiter, async (req, res) => {
    const chat = await chatOf(req, res);
    if (!chat) return;
    const current = store(res);
    if (!current) return;
    const message = await current.get({ chatId: chat.id, id: req.params.messageId });
    if (!message) return refuse(res, 'not_found');
    if (message.authorId !== req.user.accountId) return refuse(res, 'forbidden');

    const asked = req.body?.body;
    if (typeof asked !== 'string') return refuse(res, 'invalid_message');
    const body = !asked.trim() && message.attachment ? '' : cleanBody(asked);
    if (body === null) return refuse(res, 'invalid_message');
    const mentions = await mentionsOf(req.body?.mentions, body, chat);
    // The same words again change nothing, and are not marked as an edit.
    const same = (a, b) =>
      JSON.stringify(a.map((m) => m.id)) === JSON.stringify(b.map((m) => m.id));
    if (body === message.body && same(mentions, message.mentions ?? [])) {
      return res.json({ message });
    }

    const editedAt = new Date();
    if (!(await current.edit({ chatId: chat.id, id: message.id, body, mentions, editedAt }))) {
      return refuse(res, 'not_found');
    }
    const edited = { ...message, body, mentions, editedAt: editedAt.toISOString() };
    tell(chat, 'edited', { chatId: chat.id, message: edited });
    res.json({ message: edited });
  });

  // Its author may delete a message, and so may any admin, anyone's. The
  // message goes, with its photo or video, and every open app is told.
  router.delete('/:id/messages/:messageId', requireSession, async (req, res) => {
    const chat = await chatOf(req, res);
    if (!chat) return;
    const current = store(res);
    if (!current) return;
    const message = await current.get({ chatId: chat.id, id: req.params.messageId });
    if (!message) return refuse(res, 'not_found');
    const { accountId } = req.user;
    if (message.authorId !== accountId && !isAdmin(req.user)) return refuse(res, 'forbidden');

    await current.remove({ chatId: chat.id, id: message.id });
    if (message.attachment?.id) {
      await media?.remove(chat.folder, message.attachment.id).catch(() => {});
    }
    if (message.authorId !== accountId) {
      logger.info(`[chat] ${accountId} deleted a message by ${message.authorId} in ${chat.id}`);
    }
    tell(chat, 'deleted', { chatId: chat.id, messageId: message.id });
    res.json({ ok: true });
    // A message's thread goes with it; a reply's going is counted.
    if (chat.kind === 'thread') {
      await threadChanged(current, chat).catch(() => {});
    } else if (current.threads) {
      const had = await current
        .threads({ chatId: chat.id, rootIds: [message.id] })
        .catch(() => ({}));
      if (had[message.id]) {
        current
          .removeThread({ chatId: chat.id, rootId: message.id })
          .catch((err) =>
            logger.warn(`[chat] thread of ${message.id} not deleted: ${err.message}`),
          );
      }
    }
  });

  // Anyone may react to any message with an emoji, and take their own
  // reaction off again. A message carries at most REACTIONS_MAX different
  // emoji; adding to one already there is always allowed. Both are harmless
  // to repeat, and only a change goes out on the stream.
  async function react(req, res, on) {
    const chat = await chatOf(req, res);
    if (!chat) return;
    const current = store(res);
    if (!current) return;
    const emoji = cleanEmoji(req.params.emoji);
    if (!emoji) return refuse(res, 'invalid_reaction');
    const message = await current.get({ chatId: chat.id, id: req.params.messageId });
    if (!message) return refuse(res, 'not_found');

    const { accountId } = req.user;
    const now = (await current.reactions({ chatId: chat.id, ids: [message.id] }))[message.id] ?? [];
    const group = now.find((r) => r.emoji === emoji);
    if (Boolean(group?.accountIds.includes(accountId)) === on) return res.json({ ok: true });
    if (on && !group && now.length >= REACTIONS_MAX) return refuse(res, 'too_many_reactions');

    await current.react({ chatId: chat.id, messageId: message.id, accountId, emoji, on });
    const reactor = { name: req.user.name, avatar: req.user.avatar ?? null };
    tell(chat, 'reaction', {
      chatId: chat.id,
      messageId: message.id,
      emoji,
      accountId,
      on,
      reactor,
    });
    res.json({ ok: true });
  }

  const reaction = '/:id/messages/:messageId/reactions/:emoji';
  router.put(reaction, requireSession, reactLimiter, (req, res) => react(req, res, true));
  router.delete(reaction, requireSession, reactLimiter, (req, res) => react(req, res, false));

  // ---- photos and videos ---------------------------------------------------
  // A file is a message of its own, with an optional caption. The bytes come
  // raw, under their own limit: the JSON parser's 32kb is for text. The name
  // and caption ride in the query, encoded, since the body is the file.

  const rawMedia = express.raw({ type: () => true, limit: MEDIA_MAX_BYTES });
  const readMedia = (req, res, next) =>
    rawMedia(req, res, (err) => {
      if (!err) return next();
      refuse(res, err.type === 'entity.too.large' ? 'media_too_large' : 'unsupported_media');
    });

  router.post('/:id/media', requireSession, sendLimiter, readMedia, async (req, res) => {
    if (!media) return refuse(res, 'chat_unavailable');
    const chat = await chatOf(req, res);
    if (!chat) return;
    const current = store(res);
    if (!current) return;

    const caption = typeof req.query.caption === 'string' ? req.query.caption : '';
    const body = caption.trim() ? cleanBody(caption) : '';
    if (body === null) return refuse(res, 'invalid_message');
    const replyTo = await replyOf(current, chat, req.query.replyTo);
    if (replyTo === null) return refuse(res, 'invalid_reply');
    const asked = typeof req.query.mentions === 'string' ? req.query.mentions.split(',') : [];
    const mentions = await mentionsOf(asked, body, chat);
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const saved = await media.save(chat.folder, bytes);
    if (!saved) return refuse(res, 'unsupported_media');

    const { accountId } = req.user;
    const attachment = { ...saved, name: cleanFileName(req.query.name) };
    const message = await current.send({
      chatId: chat.id,
      authorId: accountId,
      body,
      attachment,
      replyTo,
      mentions,
    });
    await current.markRead({ chatId: chat.id, accountId, messageId: message.id });
    await directTouched(chat);
    logger.info(`[chat] ${accountId} sent ${saved.kind} ${saved.id} (${saved.size} bytes)`);

    const author = { name: req.user.name, avatar: req.user.avatar ?? null };
    tell(chat, 'message', { message, author });
    tell(chat, 'read', { chatId: chat.id, accountId, messageId: message.id, reader: author });
    res.status(201).json({ message, author });
    await threadChanged(current, chat).catch(() => {});
  });

  // Anyone signed in may see what was sent, as they read the messages. The
  // type is the one judged from the stored bytes, and nosniff and a closed
  // CSP keep the browser from reading it as anything else. Range requests
  // are answered, so a video can be scrubbed.
  router.get('/:id/media/:mediaId', requireSession, async (req, res) => {
    // Only whoever may read the chat: a direct chat's files are its two's.
    const chat = await chatOf(req, res);
    if (!chat) return;
    const file = media ? await media.find(chat.folder, req.params.mediaId) : null;
    if (!file) return refuse(res, 'not_found');
    res.sendFile(file.path, {
      headers: {
        'Content-Type': file.type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        // A file never changes under its id.
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  });

  router.post('/:id/read', requireSession, async (req, res) => {
    const chat = await chatOf(req, res);
    if (!chat) return;
    const current = store(res);
    if (!current) return;
    const { messageId } = req.body ?? {};
    const { accountId } = req.user;
    if (!(await current.markRead({ chatId: chat.id, accountId, messageId }))) {
      return refuse(res, 'invalid_cursor');
    }
    // With who read it, so "seen by" can name someone the page never showed.
    const reader = { name: req.user.name, avatar: req.user.avatar ?? null };
    tell(chat, 'read', { chatId: chat.id, accountId, messageId, reader });
    res.json({ ok: true });
  });

  // Someone is writing in a chat (ADR 0049): said every few seconds while they
  // type, never stored, and told only to whoever may read the chat. The app
  // shows it until a few seconds pass without another, or their message comes.
  router.post('/:id/typing', requireSession, typingLimiter, async (req, res) => {
    const chat = await chatOf(req, res);
    if (!chat) return;
    const { accountId } = req.user;
    tell(chat, 'typing', { chatId: chat.id, accountId, name: req.user.name });
    res.status(204).end();
  });

  return router;
}

/** A message id as a paging cursor: the timeuuid's canonical text form. */
function isMessageCursor(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
