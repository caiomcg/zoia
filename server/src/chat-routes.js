/**
 * The chat API (ADR 0035): the list of chats, their messages, who has read
 * what, and a Server-Sent Events stream that pushes each change as it
 * happens. Mounted at /api/chats by app.js, which owns sessions.
 *
 * The list is always there (SQLite). Messages need ScyllaDB, which may still
 * be starting or not configured at all; until it answers, routes that need it
 * say `chat_unavailable` and the list carries `available: false`.
 *
 * Every route needs an approved session. Adding, renaming and removing chats
 * needs an admin, and the limit needs the super admin, checked here on every
 * request rather than trusted from the app (AGENTS.md invariant 4).
 */

import express from 'express';
import rateLimit from 'express-rate-limit';

import { CHAT_CEILING } from './chats.js';
import { cleanBody } from './messages.js';

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
  forbidden: 403,
  not_found: 404,
  chat_limit: 409,
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
    publish(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const s of streams) s.write(frame);
    },
  };
}

/**
 * @param {object} options
 * @param {ReturnType<import('./chats.js').createChatStore>} options.chats
 * @param {() => ReturnType<import('./messages.js').createMessageStore> | null} options.messages
 *   the message store, or null while ScyllaDB is not connected
 * @param {object} options.accountStore
 * @param {Function} options.requireSession
 * @param {Function} options.requireAdmin
 * @param {(req) => Promise<object | null>} options.recheck the request's
 *   session as it stands now, for a stream that outlives its request
 */
export function chatRoutes({
  chats,
  messages,
  accountStore,
  requireSession,
  requireAdmin,
  recheck,
  hub = createChatHub(),
  heartbeatMs = HEARTBEAT_MS,
  sendLimit = { windowMs: 10_000, limit: 20 },
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

  /** The message store, or a refusal when ScyllaDB is not there. */
  function store(res) {
    const current = messages();
    if (!current) refuse(res, 'chat_unavailable');
    return current;
  }

  async function chatOf(req, res) {
    const chat = await chats.find(req.params.id);
    if (!chat) refuse(res, 'not_found');
    return chat;
  }

  /** How an author is shown: name and picture version, never the email. */
  async function authorsOf(ids) {
    const authors = {};
    for (const id of new Set(ids)) {
      const account = await accountStore.get(id);
      authors[id] = account ? { name: account.name, avatar: account.avatar ?? null } : null;
    }
    return authors;
  }

  const publicChat = ({ id, name, isDefault }) => ({ id, name, isDefault });

  // ---- the list ----------------------------------------------------------

  router.get('/', requireSession, async (req, res) => {
    const current = messages();
    const list = await chats.list();
    const unread = current
      ? await Promise.all(
          list.map((chat) =>
            current
              .unread({ chatId: chat.id, accountId: req.user.accountId, since: chat.createdAt })
              .catch(() => null),
          ),
        )
      : [];
    res.json({
      chats: list.map((chat, i) => ({ ...publicChat(chat), unread: unread[i] ?? null })),
      max: await chats.max(),
      ceiling: CHAT_CEILING,
      available: Boolean(current),
    });
  });

  router.post('/', requireAdmin, async (req, res) => {
    const result = await chats.add({ name: req.body?.name, by: req.user.accountId });
    if (!result.ok) return refuse(res, result.reason);
    hub.publish('chats', {});
    res.status(201).json({ chat: publicChat(result.chat) });
  });

  // Only the super admin decides how many chats there may be.
  router.put('/limit', requireAdmin, async (req, res) => {
    if (req.user.role !== 'super_admin') return refuse(res, 'forbidden');
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
    const list = page.slice(0, limit);
    const readers = await current.readMarkers(chat.id);
    res.json({
      messages: list,
      hasMore: page.length > limit,
      // Readers too, so "seen by" can name someone who has not written.
      authors: await authorsOf([...list.map((m) => m.authorId), ...readers.keys()]),
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

    const { accountId } = req.user;
    const message = await current.send({ chatId: chat.id, authorId: accountId, body });
    // Whoever wrote it has read up to it.
    await current.markRead({ chatId: chat.id, accountId, messageId: message.id });

    const author = { name: req.user.name, avatar: req.user.avatar ?? null };
    hub.publish('message', { message, author });
    hub.publish('read', { chatId: chat.id, accountId, messageId: message.id, reader: author });
    res.status(201).json({ message, author });
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
    hub.publish('read', { chatId: chat.id, accountId, messageId, reader });
    res.json({ ok: true });
  });

  return router;
}

/** A message id as a paging cursor: the timeuuid's canonical text form. */
function isMessageCursor(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
