/**
 * GIF search (ADR 0051), mounted at /api/gifs by app.js.
 *
 * The app asks here and this asks KLIPY, so the key stays on the server and
 * never ships in the app. Each person is known to KLIPY only by a hash of
 * their account, the same one each time, as its API asks. Without a key the
 * route says GIFs are off, and the app hides its GIF button.
 */

import { createHash } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';

const KLIPY_API = 'https://api.klipy.com';
const PER_PAGE = 24;
const MAX_QUERY = 100;
const TIMEOUT_MS = 8000;

/** Where a GIF may come from, for the app to show it inline (and nothing else). */
export const GIF_HOST = /^https:\/\/([a-z0-9-]+\.)*klipy\.com\//i;

/**
 * One GIF, as the app needs it: a small one for the picker, a medium one to
 * send, and its size so the chat keeps its place while it loads.
 */
export function slimGif(item) {
  const file = item?.file ?? {};
  const pick = (size) => file[size]?.gif ?? file[size]?.webp ?? null;
  const send = pick('md') ?? pick('hd') ?? pick('sm');
  const preview = file.sm?.webp ?? file.sm?.gif ?? file.xs?.gif ?? send;
  if (!send?.url || !GIF_HOST.test(send.url) || !preview?.url || !GIF_HOST.test(preview.url)) {
    return null;
  }
  return {
    id: String(item.slug ?? item.id),
    title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
    url: send.url,
    preview: preview.url,
    width: Number(send.width) || 0,
    height: Number(send.height) || 0,
  };
}

/**
 * @param {object} options
 * @param {string | undefined} options.apiKey KLIPY's app key; none turns GIFs off
 * @param {import('express').RequestHandler} options.requireSession
 * @param {typeof fetch} [options.fetchImpl]
 * @param {object} [options.limit] express-rate-limit options, per account
 */
export function gifRoutes({ apiKey, requireSession, fetchImpl = fetch, limit }) {
  const router = express.Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    ...limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.user.accountId,
    message: { error: 'too_many_requests' },
  });

  router.get('/', requireSession, limiter, async (req, res) => {
    if (!apiKey) return res.status(503).json({ error: 'gifs_off' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, MAX_QUERY) : '';
    const page = Math.min(Math.max(Number.parseInt(String(req.query.page ?? '1'), 10) || 1, 1), 50);
    const customer = createHash('sha256')
      .update(`zoia:${req.user.accountId}`)
      .digest('hex')
      .slice(0, 32);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(PER_PAGE),
      customer_id: customer,
      content_filter: 'medium',
      format_filter: 'gif,webp',
    });
    if (q) params.set('q', q);
    const url = `${KLIPY_API}/api/v1/${encodeURIComponent(apiKey)}/gifs/${q ? 'search' : 'trending'}?${params}`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) return res.status(502).json({ error: 'gifs_failed' });
      const body = await response.json();
      const items = Array.isArray(body?.data?.data) ? body.data.data : [];
      res.json({
        gifs: items.map(slimGif).filter(Boolean),
        more: Boolean(body?.data?.has_next),
        page,
      });
    } catch {
      res.status(502).json({ error: 'gifs_failed' });
    }
  });

  return router;
}
