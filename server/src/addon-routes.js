/**
 * The addon API, `/api/addon/v1` (ADR 0041).
 *
 * An addon is its token: `Authorization: Bearer zaddon_<id>_<secret>`. The
 * addon is re-read on every request, so one disabled or uninstalled is
 * refused at once, as a person's session is (AGENTS.md invariant 3). Every
 * route but `/me` needs one permission, from those the super admin granted.
 *
 * Nothing here returns an email, a password hash or a device credential. People
 * are their account id, name, role and picture version; a device id never
 * leaves, since it is someone's LiveKit identity.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';

import { cleanBody, replySnapshot } from './messages.js';
import { effectiveSettings, parseCommand } from './addons.js';
import { isAdmin, isBot } from './accounts.js';
import { botIdentity, isBotIdentity } from './token.js';
import { WHIP_SUFFIX } from './whip.js';

/** How often an open stream re-checks its addon, and says it is alive. */
const HEARTBEAT_MS = 25_000;
/** Streams one addon may hold open. */
const STREAMS_PER_ADDON = 3;
/** Must match MOVE_TOPIC in desktop/src/renderer/livekit/useRoom.ts. */
const MOVE_TOPIC = 'zoia.move';

const ERRORS = {
  unauthenticated: 401,
  forbidden: 403,
  addon_disabled: 403,
  missing_permission: 403,
  not_bound: 403,
  not_found: 404,
  unknown_account: 404,
  unknown_room: 404,
  not_connected: 409,
  bot_limit: 409,
  too_many_streams: 429,
  chat_unavailable: 503,
};

const refuse = (res, reason, extra = {}) =>
  res.status(ERRORS[reason] ?? 400).json({ error: reason, ...extra });

/** Each addon's open event streams, in this process. */
export function createAddonHub() {
  const streams = new Set();
  return {
    add(stream) {
      streams.add(stream);
      return () => streams.delete(stream);
    },
    count(addonId) {
      let n = 0;
      for (const s of streams) if (s.addonId === addonId) n += 1;
      return n;
    },
    /** To one addon. */
    send(addonId, event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const s of streams) if (s.addonId === addonId) s.write(frame);
    },
    /** Ends an addon's streams: it was disabled, updated or uninstalled. */
    close(addonId) {
      for (const s of streams) if (s.addonId === addonId) s.end();
    },
  };
}

/** A person as an addon sees them. */
export const publicPerson = (a) => ({
  id: a.id,
  name: a.name,
  role: a.role,
  status: a.status,
  avatar: a.avatar ?? null,
  bot: isBot(a),
});

/**
 * @param {object} options
 * @param {ReturnType<import('./addons.js').createAddonStore>} options.addons
 * @param {object} options.accountStore
 * @param {object} options.deviceStore
 * @param {object} options.chats
 * @param {() => object | null} options.messages the message store, or null
 * @param {ReturnType<import('./chat-routes.js').createChatHub>} options.chatHub
 * @param {object} options.channelSet
 * @param {object} options.tokenIssuer
 * @param {() => Promise<Map<string, object>>} options.whereAll each device
 *   identity in a channel, and the channel
 * @param {(accountId: string) => Promise<void>} options.disconnectAccount
 */
export function addonRoutes({
  addons,
  accountStore,
  deviceStore,
  chats,
  messages,
  chatHub,
  channelSet,
  tokenIssuer,
  whereAll,
  disconnectAccount,
  serverName = 'Zoia',
  hub = createAddonHub(),
  heartbeatMs = HEARTBEAT_MS,
  limit = { windowMs: 10_000, limit: 50 },
  logger = console,
}) {
  const router = express.Router();

  /** The addon a request is, as it stands now; refused when disabled. */
  async function requireAddon(req, res, next) {
    try {
      const header = req.get('authorization') ?? '';
      const raw = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
      const addon = raw ? await addons.authenticate(raw) : null;
      if (!addon) return refuse(res, 'unauthenticated');
      if (!addon.enabled) return refuse(res, 'addon_disabled');
      req.addon = addon;
      next();
    } catch (err) {
      next(err);
    }
  }

  const need = (permission) => (req, res, next) =>
    req.addon.granted.includes(permission)
      ? next()
      : refuse(res, 'missing_permission', { permission });

  router.use(requireAddon);
  // Per addon: one stuck in a loop must not take the server with it.
  router.use(
    rateLimit({
      ...limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: (req) => req.addon.id,
      message: { error: 'too_many_requests' },
    }),
  );

  /** One of this addon's bots, or null. */
  async function botOf(addon, id) {
    const account = typeof id === 'string' ? await accountStore.get(id) : null;
    return account?.addonId === addon.id && account.status === 'active' ? account : null;
  }

  /** A device's account id, for telling an addon who is in a channel. */
  async function accountOfIdentity(identity, cache) {
    if (!cache.has(identity)) {
      const device = await deviceStore.find(identity);
      cache.set(identity, device?.accountId ?? null);
    }
    return cache.get(identity);
  }

  // ---- who this addon is ---------------------------------------------------

  router.get('/me', async (req, res, next) => {
    try {
      const { addon } = req;
      res.json({
        id: addon.id,
        key: addon.key,
        name: addon.name,
        version: addon.version,
        permissions: addon.granted,
        // Secrets too: the addon is who they were typed for.
        settings: effectiveSettings(addon.manifest.settings, addon.settings),
        commands: addons.commandNames(addon),
        chats: await addons.bindingsOf(addon.id),
        bots: (await accountStore.botsOf(addon.id)).map(publicPerson),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- events --------------------------------------------------------------

  router.get('/events', (req, res) => {
    const { addon } = req;
    if (hub.count(addon.id) >= STREAMS_PER_ADDON) return refuse(res, 'too_many_streams');

    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(': connected\n\n');

    const remove = hub.add({ addonId: addon.id, write: (f) => res.write(f), end: () => res.end() });
    // Disabling or uninstalling ends the stream, as signing out ends a person's.
    const heartbeat = setInterval(async () => {
      const current = await addons.get(addon.id).catch(() => null);
      if (!current?.enabled) return res.end();
      res.write(': heartbeat\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      remove();
    });
  });

  // ---- the server ----------------------------------------------------------

  router.get('/server', need('server.read'), async (_req, res, next) => {
    try {
      res.json({
        name: serverName,
        channels: { count: (await channelSet.list()).length, max: channelSet.max },
        chats: { count: (await chats.list()).length, max: await chats.max() },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/channels', need('channels.read'), async (_req, res, next) => {
    try {
      const cache = new Map();
      const list = await Promise.all(
        (await channelSet.list()).map(async ({ id, name, isDefault, stage }) => {
          const participants = await stage.participants().catch(() => []);
          const people = [];
          for (const p of participants) {
            if (p.identity.endsWith(WHIP_SUFFIX)) continue;
            const bot = isBotIdentity(p.identity);
            const accountId = bot
              ? p.identity.slice('bot-'.length)
              : await accountOfIdentity(p.identity, cache);
            if (!accountId) continue;
            people.push({ accountId, name: p.name, voice: p.voice, bot });
          }
          return { id, name, isDefault: Boolean(isDefault), people };
        }),
      );
      res.json({ channels: list });
    } catch (err) {
      next(err);
    }
  });

  // ---- people --------------------------------------------------------------

  router.get('/users', need('users.read'), async (_req, res, next) => {
    try {
      const people = (await accountStore.list()).filter((a) => a.status !== 'pending');
      res.json({ users: people.map(publicPerson) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Someone an addon may manage: a plain user, never an admin, and never
   * another addon's bot. Narrower than an admin's reach, on purpose.
   */
  async function manageable(req, res) {
    const target = await accountStore.get(req.params.id);
    if (!target || target.status === 'pending') {
      refuse(res, 'unknown_account');
      return null;
    }
    if (isAdmin(target) || (isBot(target) && target.addonId !== req.addon.id)) {
      refuse(res, 'forbidden');
      return null;
    }
    return target;
  }

  for (const [action, status] of [
    ['disable', 'disabled'],
    ['enable', 'active'],
  ]) {
    router.post(`/users/:id/${action}`, need('users.manage'), async (req, res, next) => {
      try {
        const target = await manageable(req, res);
        if (!target) return;
        const result = await accountStore.setStatus(target.id, status, `addon:${req.addon.id}`);
        if (!result.ok) return refuse(res, result.reason);
        if (status === 'disabled') await disconnectAccount(target.id);
        res.json({ user: publicPerson(result.account) });
      } catch (err) {
        next(err);
      }
    });
  }

  // Asks every machine of theirs in a channel to switch, as an admin's drag does.
  router.post('/users/:id/move', need('users.manage'), async (req, res, next) => {
    try {
      const target = await manageable(req, res);
      if (!target) return;
      const destination = await channelSet.get(String(req.body?.channel ?? ''));
      if (!destination) return refuse(res, 'unknown_room');
      const devices = new Set((await deviceStore.listByAccount(target.id)).map((d) => d.id));
      let moved = 0;
      for (const [identity, from] of await whereAll()) {
        if (!devices.has(identity) || from.id === destination.id) continue;
        await from.stage.send(identity, MOVE_TOPIC, { channel: destination.id });
        moved += 1;
      }
      if (moved === 0 && ![...(await whereAll()).keys()].some((i) => devices.has(i))) {
        return refuse(res, 'not_connected');
      }
      logger.info(`[addon] ${req.addon.id} moved ${target.id} to ${destination.id}`);
      res.json({ moved });
    } catch (err) {
      next(err);
    }
  });

  // ---- bots ----------------------------------------------------------------

  router.get('/bots', async (req, res, next) => {
    try {
      res.json({ bots: (await accountStore.botsOf(req.addon.id)).map(publicPerson) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/bots', need('bots.create'), async (req, res, next) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) return refuse(res, 'invalid_name');
      const result = await accountStore.createBot({ addonId: req.addon.id, name });
      if (!result.ok) return refuse(res, result.reason);
      res.status(201).json({ bot: publicPerson(result.account) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/bots/:id', need('bots.create'), async (req, res, next) => {
    try {
      const bot = await botOf(req.addon, req.params.id);
      if (!bot) return refuse(res, 'not_found');
      for (const channel of await channelSet.list()) {
        await channel.stage.disconnect?.([botIdentity(bot.id)]).catch(() => {});
      }
      await accountStore.removeBot(req.addon.id, bot.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- chats ---------------------------------------------------------------

  /** A chat this addon is bound to, or a refusal. */
  async function boundChat(req, res) {
    const chat = await chats.find(req.params.id);
    if (!chat) {
      refuse(res, 'not_found');
      return null;
    }
    if (!(await addons.bindingsOf(req.addon.id)).includes(chat.id)) {
      refuse(res, 'not_bound');
      return null;
    }
    return chat;
  }

  router.post('/chats/:id/messages', need('chat.write'), async (req, res, next) => {
    try {
      const chat = await boundChat(req, res);
      if (!chat) return;
      const bot = await botOf(req.addon, req.body?.bot);
      if (!bot) return refuse(res, 'not_found', { field: 'bot' });
      const body = cleanBody(req.body?.body);
      if (!body) return refuse(res, 'invalid_message');
      const current = messages();
      if (!current) return refuse(res, 'chat_unavailable');

      let replyTo;
      if (typeof req.body?.replyTo === 'string') {
        const original = await current.get({ chatId: chat.id, id: req.body.replyTo });
        if (original) {
          const author = await accountStore.get(original.authorId);
          replyTo = replySnapshot(original, author?.name);
        }
      }
      const message = await current.send({
        chatId: chat.id,
        authorId: bot.id,
        body,
        replyTo,
        mentions: [],
      });
      const author = { name: bot.name, avatar: bot.avatar ?? null, bot: true };
      chatHub.publish('message', { message, author });
      res.status(201).json({ message });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Deletes a message in a bound chat: one of its bots' (with chat.write), or
   * a ! command of its own that someone typed (with commands.delete), as it
   * is typed on this server now. Nothing else; never a photo or a video.
   */
  router.delete('/chats/:id/messages/:messageId', async (req, res, next) => {
    try {
      const chat = await boundChat(req, res);
      if (!chat) return;
      const current = messages();
      if (!current) return refuse(res, 'chat_unavailable');
      const message = await current.get({ chatId: chat.id, id: req.params.messageId });
      if (!message) return refuse(res, 'not_found');

      const author = await accountStore.get(message.authorId);
      const own = author?.addonId === req.addon.id;
      if (own && !req.addon.granted.includes('chat.write')) {
        return refuse(res, 'missing_permission', { permission: 'chat.write' });
      }
      if (!own) {
        const mine = (await addons.commandsIn(chat.id)).filter((c) => c.addonId === req.addon.id);
        if (message.attachment || !parseCommand(message.body, mine))
          return refuse(res, 'forbidden');
        if (!req.addon.granted.includes('commands.delete')) {
          return refuse(res, 'missing_permission', { permission: 'commands.delete' });
        }
      }

      await current.remove({ chatId: chat.id, id: message.id });
      chatHub.publish('deleted', { chatId: chat.id, messageId: message.id });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- voice ---------------------------------------------------------------

  // A token for one of its bots to be in voice in a channel. The addon joins
  // with it itself, from its container, and publishes its audio there.
  router.post('/voice/token', need('voice.publish'), async (req, res, next) => {
    try {
      const video = req.body?.video === true;
      if (video && !req.addon.granted.includes('video.publish')) {
        return refuse(res, 'missing_permission', { permission: 'video.publish' });
      }
      const bot = await botOf(req.addon, req.body?.bot);
      if (!bot) return refuse(res, 'not_found', { field: 'bot' });
      const channel = await channelSet.get(String(req.body?.channel ?? ''));
      if (!channel) return refuse(res, 'unknown_room');
      const issued = await tokenIssuer.issueBot(bot, channel.id, {
        addonName: req.addon.name,
        video,
      });
      logger.info(`[addon] ${req.addon.id} put bot ${bot.id} in voice in ${channel.id}`);
      res.json(issued);
    } catch (err) {
      next(err);
    }
  });

  router.post('/voice/leave', need('voice.publish'), async (req, res, next) => {
    try {
      const bot = await botOf(req.addon, req.body?.bot);
      if (!bot) return refuse(res, 'not_found', { field: 'bot' });
      const channel = await channelSet.get(String(req.body?.channel ?? ''));
      if (!channel) return refuse(res, 'unknown_room');
      await channel.stage.disconnect?.([botIdentity(bot.id)]).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Tells addons about a message just written in a chat: the command it is,
   * to the addon that owns it, and the message itself to those that read the
   * chat. Called by the chat routes after the message is stored; a failure
   * here is logged and never fails the message.
   */
  async function onMessage({ chat, message, author, user }) {
    try {
      // A bot's own message is never a command, so two bots cannot loop.
      const sender = await accountStore.get(user.accountId);
      if (!sender || isBot(sender)) return;

      const event = {
        chatId: chat.id,
        messageId: message.id,
        body: message.body,
        author: { id: sender.id, name: author.name, role: sender.role },
      };
      for (const addonId of await addons.readersOf(chat.id)) hub.send(addonId, 'message', event);

      const parsed = parseCommand(message.body, await addons.commandsIn(chat.id));
      if (!parsed) return;
      // Where the person is in voice, so a music addon knows where to play.
      const where = (await whereAll()).get(user.id);
      const inVoice = where
        ? (await where.stage.participants().catch(() => [])).some(
            (p) => p.identity === user.id && p.voice,
          )
        : false;
      for (const hit of parsed.hits) {
        hub.send(hit.addonId, 'command', {
          ...event,
          command: hit.command,
          name: hit.name,
          args: parsed.args,
          voice: inVoice ? { channel: where.id } : null,
        });
      }
    } catch (err) {
      logger.warn(`[addon] message ${message?.id} not passed to addons: ${err.message}`);
    }
  }

  return { router, hub, onMessage };
}
