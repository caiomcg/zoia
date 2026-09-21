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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE_NAME = 'zoia_sid';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export function createApp({ config, keyStore, tokenIssuer, stage, logger = console }) {
  const app = express();

  // Behind the caddy front end. Without this every request appears to come from
  // the proxy and the rate limiter throttles all users as one client.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '16kb' }));
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

  function setSession(res, keyId) {
    res.cookie(COOKIE_NAME, keyId, {
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
    const keyId = req.signedCookies?.[COOKIE_NAME];
    if (!keyId) return null;

    const record = await keyStore.getActive(keyId);
    if (!record) {
      clearSession(res);
      return null;
    }
    return record;
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
    setSession(res, record.id);
    keyStore.touch(record.id);
    logger.info(`[auth] ${record.name} (${record.id}, ${record.role}) signed in`);
    return record;
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  /**
   * The entry point people are given: /?k=<key>.
   *
   * Always answers with a redirect that drops the key, so it cannot linger in
   * the URL bar, browser history, or a Referer header sent to a third party.
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
      keyStore.touch(req.user.id);
      res.json({ ...result, quality: config.quality });
    } catch (err) {
      next(err);
    }
  });

  // ---- the stage ---------------------------------------------------------
  // Publishing is a runtime permission, granted only while the stage is free.

  app.get('/api/stage', requireSession, async (_req, res, next) => {
    try {
      res.json({
        holder: await stage.holder(),
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
        return res.status(409).json({ error: 'stage_busy', holder: result.holder });
      }
      res.json({ ok: true, holder: result.holder });
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
