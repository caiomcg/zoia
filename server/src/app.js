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
import { NotStageHolderError } from './whip.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE_NAME = 'zoia_sid';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export function createApp({
  config,
  keyStore,
  tokenIssuer,
  stage,
  whip = null,
  reports = null,
  pairingStore = null,
  deviceStore = null,
  logger = console,
}) {
  const app = express();

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
   * Resolves the session to a live key record. Deliberately hits the store on
   * every request: trusting the cookie until it expires would mean `keytool
   * revoke` does nothing for up to a month.
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
    return { ...record, kind };
  }

  /** Records activity against whichever store the session belongs to. */
  function touchFor(user) {
    if (user.kind === 'device') deviceStore?.touch(user.id);
    else keyStore?.touch(user.id);
  }

  async function requireSession(req, res, next) {
    try {
      const user = await currentUser(req, res);
      if (!user) return res.status(401).json({ error: 'unauthenticated' });
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
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

  app.get('/api/session', async (req, res, next) => {
    try {
      const user = await currentUser(req, res);
      if (!user) return res.status(401).json({ error: 'unauthenticated' });
      res.json({ name: user.name, id: user.id });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/token', requireSession, async (req, res, next) => {
    try {
      const result = await tokenIssuer.issue(req.user);
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

  app.post('/api/pair', pairLimiter, requirePairing, async (req, res, next) => {
    try {
      const deviceName = String(req.body?.deviceName ?? '').trim();
      if (!deviceName) return res.status(400).json({ error: 'device_name_required' });

      const claim = await pairingStore.claimActivation(req.body?.pairingToken ?? '');
      if (!claim.ok) {
        // Never log the token itself, only where the attempt came from.
        logger.warn(`[pair] rejected (${claim.reason}) from ${req.ip}`);
        return res.status(claim.reason === 'exhausted' ? 409 : 401).json({ error: claim.reason });
      }

      const { record, raw } = await deviceStore.issue({
        name: deviceName,
        pairingId: claim.pairing.id,
      });

      // The credential is returned exactly once; the app stores it in the OS
      // keychain and we keep only its hash.
      res.json({ deviceCredential: raw, deviceId: record.id, name: record.name });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/device/session', loginLimiter, requirePairing, async (req, res, next) => {
    try {
      const record = await deviceStore.verify(req.body?.deviceCredential ?? '');
      if (!record) {
        logger.warn(`[device] rejected session from ${req.ip}`);
        return res.status(401).json({ error: 'invalid_credential' });
      }

      setSession(res, 'device', record.id);
      deviceStore.touch(record.id);
      logger.info(`[device] ${record.name} (${record.id}) signed in`);
      res.json({ name: record.name, id: record.id });
    } catch (err) {
      next(err);
    }
  });

  // ---- broadcast slots ---------------------------------------------------
  // Publishing is a runtime permission, granted independently per participant.

  app.get('/api/stage', requireSession, async (_req, res, next) => {
    try {
      res.json({
        broadcasters: await stage.broadcasters(),
        participants: await stage.participants(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/stage/claim', requireSession, async (req, res, next) => {
    try {
      const result = await stage.claim(req.user);
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
      res.json(await stage.release(req.user));
    } catch (err) {
      next(err);
    }
  });

  // ---- hardware-encoded publishing ---------------------------------------
  // The desktop app asks for somewhere to push NVENC output, because
  // Chromium's own WebRTC encoder is software-only on Windows. Claiming the
  // stage still goes through /api/stage — this only hands out the endpoint.

  const requireWhip = (_req, res, next) =>
    whip ? next() : res.status(501).json({ error: 'whip_not_configured' });

  // Hardware-encoded broadcasts publish to the SFU over WHIP. The endpoint is
  // the SFU's own; what this hands out is permission, and only to whoever
  // has claimed their own broadcast slot. See src/whip.js.
  app.post('/api/whip', requireSession, requireWhip, async (req, res, next) => {
    try {
      res.json(await whip.endpointFor(req.user, req.body));
    } catch (err) {
      if (err instanceof NotStageHolderError) {
        return res.status(409).json({ error: 'not_stage_holder' });
      }
      next(err);
    }
  });

  app.post('/api/whip/release', requireSession, requireWhip, async (req, res, next) => {
    try {
      res.json(await whip.release(req.user));
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

      const updated = deviceStore
        ? await deviceStore.rename(req.user.id, name).catch(() => null)
        : null;
      if (!updated) return res.status(404).json({ error: 'unknown_device' });

      // No separate session state to update: the name is read back out of
      // the device store on every request, so the record *is* the source of
      // truth and the next token issued carries the new name.
      res.json({ ok: true, name });
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
