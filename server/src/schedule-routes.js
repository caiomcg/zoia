/**
 * The schedule API (ADR 0050), mounted at /api/schedule by app.js.
 *
 * Anyone let in sees the events, schedules one, and says whether they are
 * going. Changing or cancelling an event is for whoever scheduled it and for
 * admins, checked here on every request (AGENTS.md invariant 4). Every change
 * goes out on the chat's stream as `schedule`, and an event that starts goes
 * out as `event_starting` to whoever said they would come.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';

import { isAdmin, isBot } from './accounts.js';
import { DEFAULT_BIRTHDAY_TZ } from './birthdays.js';
import { DEFAULT_DURATION_MINUTES, audienceOf, isBirthday } from './schedule.js';

/** How often the sweep looks for events that have started. */
const SWEEP_MS = 20_000;

const ERRORS = {
  invalid_title: 400,
  invalid_time: 400,
  invalid_description: 400,
  invalid_channel: 400,
  invalid_duration: 400,
  invalid_recurrence: 400,
  invalid_answer: 400,
  forbidden: 403,
  not_found: 404,
  event_limit: 409,
};

const refuse = (res, reason) => res.status(ERRORS[reason] ?? 400).json({ error: reason });

/**
 * @param {object} options
 * @param {ReturnType<import('./schedule.js').createEventStore>} options.events
 * @param {{ list(): Promise<{ id: string }[]> } | null} options.channels
 *   the channels, so an event can only point at one that exists
 * @param {ReturnType<import('./chat-routes.js').createChatHub>} options.hub
 * @param {string} [options.birthdayZone] the time zone a birthday's day is counted in (ADR 0055)
 */
export function scheduleRoutes({
  events,
  channels = null,
  accountStore,
  hub,
  requireSession,
  writeLimit = { windowMs: 60_000, limit: 30 },
  birthdayZone = DEFAULT_BIRTHDAY_TZ,
}) {
  const router = express.Router();

  const writeLimiter = rateLimit({
    ...writeLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.user.accountId,
    message: { error: 'too_many_requests' },
  });

  async function isChannelFn() {
    if (!channels) return () => false;
    const ids = new Set((await channels.list()).map((c) => c.id));
    return (id) => ids.has(id);
  }

  /** How an event is sent: who scheduled it by name, never by email. */
  async function shown(event) {
    const creator = event.createdBy ? await accountStore.get(event.createdBy) : null;
    // A birthday by whose it is, under the name they have now.
    const subject = isBirthday(event) ? await accountStore.get(event.subjectId) : null;
    return {
      kind: isBirthday(event) ? 'birthday' : null,
      subjectId: subject?.id ?? null,
      subjectName: subject?.name ?? null,
      id: event.id,
      title: event.title,
      description: event.description ?? null,
      startsAt: event.startsAt,
      durationMinutes: event.durationMinutes ?? DEFAULT_DURATION_MINUTES,
      recurrence: event.recurrence ?? null,
      channelId: event.channelId ?? null,
      createdBy: event.createdBy ?? null,
      creatorName: creator?.name ?? null,
      rsvps: event.rsvps ?? {},
    };
  }

  const changed = () => hub.publish('schedule', {});

  /** The event, if `req.user` may change it: whoever scheduled it, or an admin. */
  async function ownEvent(req, res) {
    const event = await events.find(req.params.id);
    if (!event) {
      refuse(res, 'not_found');
      return null;
    }
    // A birthday is the sweep's: nobody changes or cancels it, admins included.
    if (isBirthday(event) || (event.createdBy !== req.user.accountId && !isAdmin(req.user))) {
      refuse(res, 'forbidden');
      return null;
    }
    return event;
  }

  router.get('/', requireSession, async (_req, res) => {
    const list = await events.list();
    res.json({ events: await Promise.all(list.map(shown)) });
  });

  router.post('/', requireSession, writeLimiter, async (req, res) => {
    const result = await events.add(req.body ?? {}, {
      by: req.user.accountId,
      isChannel: await isChannelFn(),
    });
    if (!result.ok) return refuse(res, result.reason);
    changed();
    res.status(201).json({ event: await shown(result.event) });
  });

  router.patch('/:id', requireSession, writeLimiter, async (req, res) => {
    if (!(await ownEvent(req, res))) return;
    const result = await events.update(req.params.id, req.body ?? {}, {
      by: req.user.accountId,
      isChannel: await isChannelFn(),
    });
    if (!result.ok) return refuse(res, result.reason);
    changed();
    res.json({ event: await shown(result.event) });
  });

  router.delete('/:id', requireSession, writeLimiter, async (req, res) => {
    if (!(await ownEvent(req, res))) return;
    const result = await events.remove(req.params.id, { by: req.user.accountId });
    if (!result.ok) return refuse(res, result.reason);
    changed();
    res.json({ ok: true });
  });

  // Going, maybe, or not; null takes the answer back.
  router.put('/:id/rsvp', requireSession, writeLimiter, async (req, res) => {
    const answer = req.body?.answer ?? null;
    const result = await events.answer(req.params.id, req.user.accountId, answer);
    if (!result.ok) return refuse(res, result.reason);
    changed();
    res.json({ event: await shown(result.event) });
  });

  /**
   * Announces the events that have just started to whoever is coming, and
   * forgets those long past. Resolves to the events announced.
   */
  async function sweep() {
    // Whose birthday may come up: people let in, never a bot.
    const people = (await accountStore.list())
      .filter((a) => a.status === 'active' && !isBot(a) && a.birthday)
      .map(({ id, name, birthday }) => ({ id, name, birthday }));
    const { starting, rolled } = await events.sweep({ people, zone: birthdayZone });
    for (const event of starting) {
      hub.publish('event_starting', { event: await shown(event) }, audienceOf(event));
    }
    if (starting.length > 0 || rolled) changed();
    return starting;
  }

  return { router, sweep };
}

/** Runs `sweep` every so often until stopped; a failure waits for the next turn. */
export function startScheduleSweep(sweep, { everyMs = SWEEP_MS, logger = console } = {}) {
  const timer = setInterval(() => {
    sweep().catch((err) => logger.warn(`[schedule] sweep failed: ${err.message}`));
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
