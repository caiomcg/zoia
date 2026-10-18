/**
 * HTTP layer.
 *
 * Two rules shape everything here:
 *   1. The raw invite key never survives past the request that presented it —
 *      not in the URL, not in a log line, not in the cookie.
 *   2. The session cookie holds only a key id, and that id is re-resolved
 *      against the store on every request, so revocation is immediate.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { NotStageHolderError, WHIP_SUFFIX } from './whip.js';
import { fixedChannels } from './channels.js';
import { AVATAR_MAX_BYTES, imageType, isAvatarId } from './avatars.js';
import { canManage, isAdmin } from './accounts.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE_NAME = 'zoia_sid';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createApp({
  config,
  keyStore,
  tokenIssuer,
  stage,
  whip = null,
  channels = null,
  reports = null,
  pairingStore = null,
  deviceStore = null,
  avatarStore = null,
  accountStore = null,
  logger = console,
}) {
  const app = express();

  // How many machines one person may have, and how long one may sit unused,
  // before it stops counting. See ADR 0031.
  const deviceCap = config.accounts?.deviceCap ?? 5;
  const deviceIdleMs = (config.accounts?.deviceIdleDays ?? 60) * DAY_MS;

  // Each channel is its own LiveKit room, with its own stage and WHIP
  // publisher; see src/channels.js. A single-room caller (the tests, mostly)
  // passes stage and whip, and gets one fixed channel made of them.
  const channelSet =
    channels ?? fixedChannels([{ id: config.roomName ?? 'zoia', name: 'Geral', stage, whip }]);

  /**
   * The channel a request is about: `room` in the body or query, or the
   * default channel when it names none, which is what a client from before
   * channels sends. Anything else is refused rather than guessed at.
   */
  async function channelOf(req, res) {
    const id = req.body?.room ?? req.query?.room ?? channelSet.defaultId;
    const channel = typeof id === 'string' ? await channelSet.get(id) : null;
    if (!channel) res.status(404).json({ error: 'unknown_room' });
    return channel;
  }

  const CHANNEL_ERRORS = {
    invalid_name: 400,
    unknown_room: 404,
    room_limit: 409,
    room_is_default: 409,
    room_not_empty: 409,
    channels_fixed: 501,
  };
  const refuse = (res, reason) => res.status(CHANNEL_ERRORS[reason] ?? 400).json({ error: reason });

  // Behind the caddy front end. Without this every request appears to come from
  // the proxy and the rate limiter throttles all users as one client.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // 32kb rather than 16: a crash report now carries a tail of ffmpeg output,
  // and JSON escaping of 12k characters of log can pass 16kb on its own. Every
  // route that accepts a body still requires a session.
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(cookieParser(config.sessionSecret));

  const loginLimiter = rateLimit({
    windowMs: config.rateLimit?.windowMs ?? 60_000,
    limit: config.rateLimit?.limit ?? 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_attempts' },
    // Only failed attempts count. The point is to blunt guessing, not to
    // punish someone for reloading the page.
    skipSuccessfulRequests: true,
  });

  /**
   * Rate limiting belongs on credential checks, not on serving the page.
   * Applying it to every GET / meant an ordinary reload consumed the budget
   * and locked people out of their own room.
   */
  const limitKeyAttempts = (req, res, next) =>
    typeof req.query.k === 'string' && req.query.k.length > 0
      ? loginLimiter(req, res, next)
      : next();

  /**
   * Sessions carry `<kind>:<id>` so a device and an invite key can both hold
   * one. A bare id is read as a key, which keeps cookies issued before the
   * desktop app existed working.
   */
  function setSession(res, kind, id) {
    res.cookie(COOKIE_NAME, `${kind}:${id}`, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'lax',
      signed: true,
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });
  }

  function clearSession(res) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
  }

  /**
   * Resolves the session to a live record. Deliberately hits the store on
   * every request: trusting the cookie until it expires would mean `keytool
   * revoke` does nothing for up to a month.
   *
   * A device that belongs to an account is that account's person: the name,
   * picture, role and status come from the account, which is re-read too, so
   * disabling someone takes effect on their next request. The id stays the
   * device's, since it is the LiveKit identity and two machines of one person
   * must not share it.
   */
  async function currentUser(req, res) {
    const value = req.signedCookies?.[COOKIE_NAME];
    if (!value) return null;

    const [kind, id] = value.includes(':') ? value.split(':', 2) : ['key', value];
    const store = kind === 'device' ? deviceStore : keyStore;

    const record = await store?.getActive(id);
    if (!record) {
      clearSession(res);
      return null;
    }
    if (kind !== 'device') return { ...record, kind };

    const user = await deviceUser(record);
    if (!user) clearSession(res);
    return user;
  }

  /** The person a live device is: itself, or its account while that is not disabled. */
  async function deviceUser(record) {
    if (!record.accountId) return { ...record, kind: 'device' };
    const account = await accountStore?.get(record.accountId);
    if (!account || account.status === 'disabled') return null;
    return {
      ...record,
      kind: 'device',
      name: account.name,
      avatar: account.avatar ?? null,
      accountId: account.id,
      email: account.email,
      role: account.role,
      status: account.status,
    };
  }

  /** Records activity against whichever store the session belongs to. */
  function touchFor(user) {
    if (user.kind !== 'device') return keyStore?.touch(user.id);
    if (!user.accountId) return deviceStore?.touch(user.id);
    // In use, so not idle: the device's expiry moves forward with it.
    deviceStore?.touch(user.id, { expiresAt: new Date(Date.now() + deviceIdleMs).toISOString() });
    accountStore?.touch(user.accountId);
  }

  /** Any live session, pending accounts included. Only for what a pending account may do. */
  async function requireAnySession(req, res, next) {
    try {
      const user = await currentUser(req, res);
      if (!user) return res.status(401).json({ error: 'unauthenticated' });
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  }

  /** A session that may use the server: not an account still waiting for approval. */
  function requireSession(req, res, next) {
    requireAnySession(req, res, (err) => {
      if (err) return next(err);
      if (req.user.status === 'pending') {
        return res.status(403).json({ error: 'pending_approval' });
      }
      next();
    });
  }

  function requireAccount(req, res, next) {
    requireSession(req, res, (err) => {
      if (err) return next(err);
      if (!req.user.accountId) return res.status(403).json({ error: 'no_account' });
      next();
    });
  }

  /** Every admin action is checked here, on the server; the app hiding a button is not enough. */
  function requireAdmin(req, res, next) {
    requireAccount(req, res, (err) => {
      if (err) return next(err);
      if (!isAdmin(req.user)) return res.status(403).json({ error: 'forbidden' });
      next();
    });
  }

  /** What a client is told about who it is signed in as. */
  async function describe(user) {
    const about = { name: user.name, id: user.id, avatar: user.avatar ?? null };
    if (!user.accountId) return about;
    return {
      ...about,
      accountId: user.accountId,
      email: user.email,
      role: user.role,
      status: user.status,
      // Migrated before accounts: active, but with no email or password yet.
      needsClaim: !user.email,
      ...(isAdmin(user) ? { pendingApprovals: await accountStore.countPending() } : {}),
    };
  }

  /** Names in use by the other kind of record, for keeping names unique across both. */
  async function namesTakenOutside(store) {
    if (store === 'accounts') return (await deviceStore?.legacyNameKeys()) ?? new Set();
    return (await accountStore?.nameKeys()) ?? new Set();
  }

  /** Verifies a presented key and starts a session. Returns the record or null. */
  async function login(rawKey, req, res) {
    const record = await keyStore.verify(rawKey);
    if (!record) {
      // Log the source, never the key.
      logger.warn(`[auth] rejected login attempt from ${req.ip}`);
      return null;
    }
    setSession(res, 'key', record.id);
    keyStore.touch(record.id);
    logger.info(`[auth] ${record.name} (${record.id}) signed in`);
    return record;
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  /**
   * What a browser gets: a static page saying where the app is.
   *
   * The browser client is retired. Sharing one window's own audio needs APIs
   * a page does not get, which is the whole reason the desktop app exists.
   * This host still serves that app's API — pairing, tokens, the stage,
   * WHIP publishing, crash reports — so only the human-facing half is gone.
   *
   * /?k=<key> still signs a session in and strips the key from the URL, so it
   * cannot linger in history or a Referer header. Nothing consumes that
   * session in a browser any more, but the key store is still real and still
   * managed by keytool, so the path is left working rather than half-removed.
   */
  app.get('/', limitKeyAttempts, async (req, res, next) => {
    try {
      const rawKey = req.query.k;
      if (typeof rawKey === 'string' && rawKey.length > 0) {
        const record = await login(rawKey, req, res);
        return res.redirect(302, record ? '/' : '/?error=invalid_key');
      }
      res.sendFile(join(PUBLIC_DIR, 'index.html'));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/login', loginLimiter, async (req, res, next) => {
    try {
      if (req.body?.email !== undefined) return await accountLogin(req, res);
      const record = await login(req.body?.key ?? '', req, res);
      if (!record) return res.status(401).json({ error: 'invalid_key' });
      res.json({ name: record.name, id: record.id });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/logout', (_req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  // A pending account may ask this, so the app can tell when it is approved.
  app.get('/api/session', requireAnySession, async (req, res, next) => {
    try {
      res.json(await describe(req.user));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/token', requireSession, async (req, res, next) => {
    try {
      const channel = await channelOf(req, res);
      if (!channel) return;
      const result = await tokenIssuer.issue(req.user, channel.id);
      // Against the store the session actually came from. A device only hits
      // /api/device/session once per launch, so if this touched the key store
      // unconditionally a machine left running for weeks would keep reporting
      // the lastSeen it had on the day it started — and `device:list` is what
      // the runbook says to read before revoking something as idle.
      touchFor(req.user);
      res.json({ ...result, quality: config.quality });
    } catch (err) {
      next(err);
    }
  });

  // ---- device pairing ----------------------------------------------------
  // A pairing token is spent once per machine for a device credential. It is
  // guessed at far more aggressively than a login would be, so it gets its own
  // tighter budget.

  const pairLimiter = rateLimit({
    windowMs: config.rateLimit?.windowMs ?? 60_000,
    limit: config.rateLimit?.pairLimit ?? 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_attempts' },
    skipSuccessfulRequests: true,
  });

  const requirePairing = (_req, res, next) =>
    pairingStore && deviceStore
      ? next()
      : res.status(501).json({ error: 'pairing_not_configured' });

  const requireDevices = (_req, res, next) =>
    deviceStore ? next() : res.status(501).json({ error: 'pairing_not_configured' });

  app.post('/api/pair', pairLimiter, requirePairing, async (req, res, next) => {
    try {
      const deviceName = String(req.body?.deviceName ?? '').trim();
      if (!deviceName) return res.status(400).json({ error: 'device_name_required' });

      const claim = await pairingStore.claimActivation(req.body?.pairingToken ?? '', {
        seatsInUse: (pairingId) => deviceStore.countActiveByPairing(pairingId),
      });
      if (!claim.ok) {
        // Never log the token itself, only where the attempt came from.
        logger.warn(`[pair] rejected (${claim.reason}) from ${req.ip}`);
        return res.status(claim.reason === 'exhausted' ? 409 : 401).json({ error: claim.reason });
      }

      const { record, raw } = await deviceStore.issue({
        name: deviceName,
        pairingId: claim.pairing.id,
        alsoTaken: await namesTakenOutside('devices'),
      });

      // The credential is returned exactly once; the app stores it in the OS
      // keychain and we keep only its hash.
      res.json({ deviceCredential: raw, deviceId: record.id, name: record.name });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/device/session', loginLimiter, requireDevices, async (req, res, next) => {
    try {
      const record = await deviceStore.verify(req.body?.deviceCredential ?? '');
      if (!record) {
        logger.warn(`[device] rejected session from ${req.ip}`);
        return res.status(401).json({ error: 'invalid_credential' });
      }

      const user = await deviceUser(record);
      if (!user) {
        // A device whose account was disabled or removed.
        logger.warn(`[device] ${record.id} refused: its account is not active`);
        return res.status(403).json({ error: 'account_disabled' });
      }
      setSession(res, 'device', record.id);
      touchFor(user);
      logger.info(`[device] ${record.id} signed in`);
      res.json(await describe(user));
    } catch (err) {
      next(err);
    }
  });

  // ---- accounts ----------------------------------------------------------
  // See ADR 0031. Sign-up and login are reachable by anyone who knows the
  // host, so each has its own budget, and no route logs an email, a password
  // or a code: the account id is what identifies someone in the log.

  const requireAccounts = (_req, res, next) =>
    accountStore && deviceStore
      ? next()
      : res.status(501).json({ error: 'accounts_not_configured' });

  // Counts every attempt, successful or not: what this blunts is someone
  // filling the approval queue, and their sign-ups succeed.
  const signupLimiter = rateLimit({
    windowMs: config.rateLimit?.signupWindowMs ?? 60 * 60_000,
    limit: config.rateLimit?.signupLimit ?? 3,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_attempts' },
  });

  const LOGIN_ERRORS = {
    invalid_login: [401, 'invalid_login'],
    locked: [429, 'too_many_attempts'],
    disabled: [403, 'account_disabled'],
  };

  async function accountLogin(req, res) {
    if (!accountStore || !deviceStore) {
      return res.status(501).json({ error: 'accounts_not_configured' });
    }
    const deviceName = String(req.body?.deviceName ?? '').trim();
    if (!deviceName) return res.status(400).json({ error: 'device_name_required' });

    const result = await accountStore.authenticate(req.body.email, req.body.password);
    if (!result.ok) {
      logger.warn(`[account] rejected login (${result.reason}) from ${req.ip}`);
      const [status, error] = LOGIN_ERRORS[result.reason] ?? [401, 'invalid_login'];
      return res.status(status).json({ error });
    }

    const { account } = result;
    const { record, raw } = await deviceStore.issueForAccount({
      name: deviceName,
      accountId: account.id,
      cap: deviceCap,
      idleMs: deviceIdleMs,
    });
    setSession(res, 'device', record.id);
    accountStore.touch(account.id);
    logger.info(`[account] ${account.id} signed in on device ${record.id}`);
    // The credential is returned exactly once, as pairing does; the app keeps
    // it in the OS keychain so the password is typed once per machine.
    res.json({
      deviceCredential: raw,
      deviceId: record.id,
      ...(await describe(await deviceUser(record))),
    });
  }

  app.post('/api/signup', signupLimiter, requireAccounts, async (req, res, next) => {
    try {
      const result = await accountStore.signup({
        email: req.body?.email,
        password: req.body?.password,
        ip: req.ip,
        alsoTaken: await namesTakenOutside('accounts'),
      });
      if (!result.ok) {
        const status = { email_taken: 409, signup_closed: 503 }[result.reason] ?? 400;
        return res.status(status).json({ error: result.reason });
      }
      res.status(201).json({ status: result.account.status });
    } catch (err) {
      next(err);
    }
  });

  // A reset code sets a forgotten password and signs every device out; a
  // claim code is how someone from before accounts adds an email and a
  // password, and their devices carry on. Either way the app logs in after.
  app.post('/api/reset', pairLimiter, requireAccounts, async (req, res, next) => {
    try {
      const result = await accountStore.redeemCode(req.body?.code, {
        password: req.body?.password,
        email: req.body?.email ?? null,
      });
      if (!result.ok) {
        logger.warn(`[account] rejected code (${result.reason}) from ${req.ip}`);
        const status = { invalid_code: 401, email_taken: 409 }[result.reason] ?? 400;
        return res.status(status).json({ error: result.reason });
      }
      if (result.kind === 'reset') await deviceStore.revokeByAccount(result.account.id);
      res.json({ ok: true, email: result.account.email });
    } catch (err) {
      next(err);
    }
  });

  // Changing your password signs out every other machine of yours, which is
  // usually why someone changes it.
  app.post('/api/password', requireAccount, async (req, res, next) => {
    try {
      if (!(await accountStore.checkPassword(req.user.accountId, req.body?.currentPassword))) {
        return res.status(401).json({ error: 'invalid_login' });
      }
      const result = await accountStore.setPassword(req.user.accountId, req.body?.newPassword);
      if (!result.ok) return res.status(400).json({ error: result.reason });
      const signedOut = await deviceStore.revokeByAccount(req.user.accountId, {
        except: req.user.id,
      });
      res.json({ ok: true, signedOut });
    } catch (err) {
      next(err);
    }
  });

  // Your own machines, so you can see what is signed in as you.
  app.get('/api/devices', requireAccount, async (req, res, next) => {
    try {
      const devices = await deviceStore.listByAccount(req.user.accountId);
      res.json({
        devices: devices.map(({ id, name, createdAt, lastSeen }) => ({
          id,
          name,
          createdAt,
          lastSeen,
          current: id === req.user.id,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/devices/:id', requireAccount, async (req, res, next) => {
    try {
      const mine = await deviceStore.listByAccount(req.user.accountId);
      if (!mine.some((d) => d.id === req.params.id)) {
        return res.status(404).json({ error: 'unknown_device' });
      }
      await deviceStore.revoke(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- administration ----------------------------------------------------
  // Admins approve sign-ups and look after users; only the super admin makes
  // admins, and nothing here can touch the super admin. Which accounts are
  // admins is read from the store on every request, like everything else.

  const ADMIN_ERRORS = {
    unknown_account: 404,
    forbidden: 403,
    not_pending: 409,
    pending: 409,
    not_active: 409,
    invalid_role: 400,
  };
  const adminRefuse = (res, reason) =>
    res.status(ADMIN_ERRORS[reason] ?? 400).json({ error: reason });

  /** The target account, if `req.user` may manage it; refuses otherwise. */
  async function manageable(req, res) {
    const target = await accountStore.get(req.params.id);
    if (!target) return adminRefuse(res, 'unknown_account') && null;
    if (!canManage(req.user, target)) return adminRefuse(res, 'forbidden') && null;
    return target;
  }

  app.get('/api/admin/accounts', requireAdmin, async (_req, res, next) => {
    try {
      const accounts = await accountStore.list();
      const rows = await Promise.all(
        accounts.map(async (a) => ({
          id: a.id,
          email: a.email,
          name: a.name,
          role: a.role,
          status: a.status,
          createdAt: a.createdAt,
          lastSeen: a.lastSeen,
          signupIp: a.signupIp ?? null,
          devices: (await deviceStore.listByAccount(a.id)).length,
        })),
      );
      res.json({ accounts: rows });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/accounts/:id/approve', requireAdmin, async (req, res, next) => {
    try {
      const result = await accountStore.approve(req.params.id, req.user.accountId);
      if (!result.ok) return adminRefuse(res, result.reason);
      res.json({ account: result.account });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/accounts/:id/reject', requireAdmin, async (req, res, next) => {
    try {
      const result = await accountStore.reject(req.params.id, req.user.accountId);
      if (!result.ok) return adminRefuse(res, result.reason);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  for (const [action, status] of [
    ['disable', 'disabled'],
    ['enable', 'active'],
  ]) {
    app.post(`/api/admin/accounts/:id/${action}`, requireAdmin, async (req, res, next) => {
      try {
        if (!(await manageable(req, res))) return;
        const result = await accountStore.setStatus(req.params.id, status, req.user.accountId);
        if (!result.ok) return adminRefuse(res, result.reason);
        res.json({ account: result.account });
      } catch (err) {
        next(err);
      }
    });
  }

  // The code is shown once, to the admin, who passes it on. It is never logged.
  app.post('/api/admin/accounts/:id/reset', requireAdmin, async (req, res, next) => {
    try {
      const target = await manageable(req, res);
      if (!target) return;
      const issued = await accountStore.issueCode(target.id, target.email ? 'reset' : 'claim');
      if (!issued) return adminRefuse(res, 'unknown_account');
      logger.info(`[admin] ${req.user.accountId} issued a ${issued.kind} code for ${target.id}`);
      res.json(issued);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/accounts/:id/role', requireAdmin, async (req, res, next) => {
    try {
      if (req.user.role !== 'super_admin') return adminRefuse(res, 'forbidden');
      if (req.params.id === req.user.accountId) return adminRefuse(res, 'forbidden');
      const result = await accountStore.setRole(req.params.id, req.body?.role, req.user.accountId);
      if (!result.ok) return adminRefuse(res, result.reason);
      res.json({ account: result.account });
    } catch (err) {
      next(err);
    }
  });

  // ---- broadcast slots ---------------------------------------------------
  // Publishing is a runtime permission, granted independently per participant.

  // Every channel, who is in it and who is live, so a client can show where
  // people are before joining one.
  app.get('/api/rooms', requireSession, async (_req, res, next) => {
    try {
      const rooms = await Promise.all(
        (await channelSet.list()).map(async ({ id, name, isDefault, stage: channelStage }) => {
          const [participants, broadcasters] = await Promise.all([
            channelStage.participants(),
            channelStage.broadcasters(),
          ]);
          return {
            id,
            name,
            isDefault,
            // A WHIP publisher is its owner's broadcast, not another person.
            participants: participants
              .filter((p) => !p.identity.endsWith(WHIP_SUFFIX))
              .map(({ identity, name: who, avatar }) => ({
                identity,
                name: who,
                // Only a version to fetch the picture by; see src/avatars.js.
                ...(avatar ? { avatar } : {}),
              })),
            broadcasters: broadcasters.map(({ identity, name: who }) => ({ identity, name: who })),
          };
        }),
      );
      res.json({ rooms, max: channelSet.max });
    } catch (err) {
      next(err);
    }
  });

  // Anyone may add a channel (up to the server's limit), rename any channel,
  // and remove an empty one that is not the default.
  app.post('/api/rooms', requireSession, async (req, res, next) => {
    try {
      const result = await channelSet.create(req.body?.name, req.user);
      if (!result.ok) return refuse(res, result.reason);
      res.status(201).json({ room: result.channel });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/rooms/:id', requireSession, async (req, res, next) => {
    try {
      const result = await channelSet.rename(req.params.id, req.body?.name, req.user);
      if (!result.ok) return refuse(res, result.reason);
      res.json({ room: result.channel });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/rooms/:id', requireSession, async (req, res, next) => {
    try {
      const channel = await channelSet.get(req.params.id);
      if (!channel) return refuse(res, 'unknown_room');
      if (channel.isDefault) return refuse(res, 'room_is_default');
      // Nobody is thrown out of a channel by someone deleting it.
      if ((await channel.stage.participants()).length > 0) return refuse(res, 'room_not_empty');
      const result = await channelSet.remove(channel.id, req.user);
      if (!result.ok) return refuse(res, result.reason);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/stage', requireSession, async (req, res, next) => {
    try {
      const channel = await channelOf(req, res);
      if (!channel) return;
      res.json({
        broadcasters: await channel.stage.broadcasters(),
        participants: await channel.stage.participants(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/stage/claim', requireSession, async (req, res, next) => {
    try {
      const channel = await channelOf(req, res);
      if (!channel) return;
      // One broadcast per person across all channels: a slot held elsewhere
      // (a client that switched channel without releasing) is released first.
      for (const other of await channelSet.list()) {
        if (other.id === channel.id) continue;
        if (await other.stage.isBroadcaster(req.user.id).catch(() => false)) {
          await other.stage.release(req.user);
        }
      }
      const result = await channel.stage.claim(req.user);
      if (!result.ok) {
        return res.status(409).json({ error: result.reason });
      }
      res.json({ ok: true, broadcaster: result.broadcaster });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/stage/release', requireSession, async (req, res, next) => {
    try {
      const channel = await channelOf(req, res);
      if (!channel) return;
      res.json(await channel.stage.release(req.user));
    } catch (err) {
      next(err);
    }
  });

  // ---- hardware-encoded publishing ---------------------------------------
  // The desktop app asks for somewhere to push NVENC output, because
  // Chromium's own WebRTC encoder is software-only on Windows. Claiming the
  // stage still goes through /api/stage — this only hands out the endpoint.

  const requireWhip = async (_req, res, next) =>
    (await channelSet.get(channelSet.defaultId))?.whip
      ? next()
      : res.status(501).json({ error: 'whip_not_configured' });

  // Hardware-encoded broadcasts publish to the SFU over WHIP. The endpoint is
  // the SFU's own; what this hands out is permission, and only to whoever
  // has claimed their own broadcast slot. See src/whip.js.
  app.post('/api/whip', requireSession, requireWhip, async (req, res, next) => {
    try {
      const channel = await channelOf(req, res);
      if (!channel) return;
      res.json(await channel.whip.endpointFor(req.user, req.body));
    } catch (err) {
      if (err instanceof NotStageHolderError) {
        return res.status(409).json({ error: 'not_stage_holder' });
      }
      next(err);
    }
  });

  app.post('/api/whip/release', requireSession, requireWhip, async (req, res, next) => {
    try {
      const channel = await channelOf(req, res);
      if (!channel) return;
      res.json(await channel.whip.release(req.user));
    } catch (err) {
      next(err);
    }
  });

  // ---- client error reports ----------------------------------------------
  // Rate-limited like a login: a client stuck in a crash loop must not be
  // able to fill the log, and an unauthenticated one cannot report at all.

  app.post('/api/report', requireSession, (req, res) => {
    if (!reports) return res.status(501).json({ error: 'reports_not_configured' });
    reports.add(req.body, req.user);
    res.json({ ok: true });
  });

  app.get('/api/reports', requireSession, (_req, res) => {
    if (!reports) return res.status(501).json({ error: 'reports_not_configured' });
    res.json({ reports: reports.list() });
  });

  // ---- display name ------------------------------------------------------

  app.post('/api/name', requireSession, async (req, res, next) => {
    try {
      const name = String(req.body?.name ?? '').trim();
      if (!name) return res.status(400).json({ error: 'name_required' });
      if (name.length > 32) return res.status(400).json({ error: 'name_too_long' });

      // An account's name is the person's, on every machine of theirs; a
      // device from before accounts still carries its own.
      let result = null;
      if (req.user.accountId) {
        result = await accountStore
          .rename(req.user.accountId, name, { alsoTaken: await namesTakenOutside('accounts') })
          .catch(() => null);
      } else if (deviceStore) {
        result = await deviceStore
          .rename(req.user.id, name, { alsoTaken: await namesTakenOutside('devices') })
          .catch(() => null);
      }
      // One name per server, so nobody is mistaken for someone else.
      if (result?.reason === 'name_taken') return res.status(409).json({ error: 'name_taken' });
      if (!result?.ok) return res.status(404).json({ error: 'unknown_device' });

      // No separate session state to update: the name is read back out of
      // the store on every request, so the record *is* the source of truth
      // and the next token issued carries the new name.
      res.json({ ok: true, name });
    } catch (err) {
      next(err);
    }
  });

  // ---- profile picture ---------------------------------------------------
  // The bytes arrive raw rather than as JSON, under their own limit: the
  // global JSON parser's 32kb is sized for crash reports, not pictures.

  const requireAvatars = (_req, res, next) =>
    avatarStore && deviceStore ? next() : res.status(501).json({ error: 'avatars_not_configured' });

  /** Where a person's picture is kept: their account, or a device from before accounts. */
  const pictureOwner = (user) =>
    user.accountId
      ? { id: user.accountId, store: accountStore }
      : { id: user.id, store: deviceStore };

  const rawAvatar = express.raw({ type: () => true, limit: AVATAR_MAX_BYTES });
  // Answered here rather than by the error handler below, which would call an
  // oversized picture an internal error.
  const readAvatarBody = (req, res, next) =>
    rawAvatar(req, res, (err) => {
      if (!err) return next();
      const tooLarge = err.type === 'entity.too.large';
      res
        .status(tooLarge ? 413 : 400)
        .json({ error: tooLarge ? 'avatar_too_large' : 'invalid_image' });
    });

  app.put('/api/avatar', requireSession, requireAvatars, readAvatarBody, async (req, res, next) => {
    try {
      // Like a rename, a picture belongs to the account, or to a device from
      // before accounts.
      if (req.user.kind !== 'device') return res.status(404).json({ error: 'unknown_device' });
      if (!imageType(req.body)) return res.status(400).json({ error: 'invalid_image' });

      const owner = pictureOwner(req.user);
      const avatar = await avatarStore.save(owner.id, req.body);
      const updated = await owner.store.setAvatar(owner.id, avatar);
      if (!updated) {
        await avatarStore.remove(owner.id);
        return res.status(404).json({ error: 'unknown_device' });
      }
      res.json({ ok: true, avatar });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/avatar', requireSession, requireAvatars, async (req, res, next) => {
    try {
      if (req.user.kind !== 'device') return res.status(404).json({ error: 'unknown_device' });
      const owner = pictureOwner(req.user);
      const updated = await owner.store.setAvatar(owner.id, null);
      if (!updated) return res.status(404).json({ error: 'unknown_device' });
      await avatarStore.remove(owner.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Anyone signed in may see anyone's picture, as they see their name. The
  // id is a participant identity — a device — checked against the device
  // store before anything goes near a path, and a revoked device's picture
  // goes with it. A device of an account shows the account's picture.
  app.get('/api/avatar/:id', requireSession, requireAvatars, async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!isAvatarId(id)) return res.status(404).json({ error: 'no_avatar' });
      const record = await deviceStore.getActive(id);
      const holder = record?.accountId ? await accountStore?.get(record.accountId) : record;
      if (!holder?.avatar) return res.status(404).json({ error: 'no_avatar' });
      const picture = await avatarStore.read(holder.id);
      if (!picture) return res.status(404).json({ error: 'no_avatar' });

      // The type is the one sniffed from the stored bytes, never one a client
      // supplied, and nosniff keeps anything from reading it as something else.
      res.set('Content-Type', picture.type);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'");
      // Clients ask with ?v=<version>, so a new picture is a new URL.
      res.set('Cache-Control', 'private, max-age=86400');
      res.send(picture.bytes);
    } catch (err) {
      next(err);
    }
  });

  // maxAge 0 with etags means the browser revalidates and gets a 304 when
  // nothing changed. An hour of caching meant a deploy did not reach anyone
  // already holding the page — they kept running the previous build.
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0, etag: true }));

  app.use((err, req, res, _next) => {
    logger.error(`[error] ${req.method} ${req.path}: ${err?.message ?? err}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
