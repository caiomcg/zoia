/**
 * GIF search (ADR 0051): the key stays here, KLIPY's answer is trimmed to
 * what the app shows, and only KLIPY's own addresses get through.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

import { GIF_HOST, gifRoutes, slimGif } from '../src/gif-routes.js';

const signedIn = (req, _res, next) => {
  req.user = { accountId: 'acct-1' };
  next();
};

const item = (slug, host = 'https://static.klipy.com') => ({
  id: 1,
  slug,
  title: 'Hello',
  file: {
    md: { gif: { url: `${host}/md/${slug}.gif`, width: 220, height: 160 } },
    sm: { webp: { url: `${host}/sm/${slug}.webp`, width: 110, height: 80 } },
  },
});

function appWith(fetchImpl, apiKey = 'secret-key') {
  const app = express();
  app.use('/api/gifs', gifRoutes({ apiKey, requireSession: signedIn, fetchImpl }));
  return app;
}

describe('slimGif', () => {
  test('keeps a medium GIF to send and a small one to preview', () => {
    assert.deepEqual(slimGif(item('hi')), {
      id: 'hi',
      title: 'Hello',
      url: 'https://static.klipy.com/md/hi.gif',
      preview: 'https://static.klipy.com/sm/hi.webp',
      width: 220,
      height: 160,
    });
  });

  test('drops a GIF from anywhere but KLIPY', () => {
    assert.equal(slimGif(item('x', 'https://evil.example')), null);
    assert.equal(slimGif({}), null);
  });

  test('only KLIPY hosts pass', () => {
    assert.ok(GIF_HOST.test('https://static.klipy.com/a.gif'));
    assert.ok(!GIF_HOST.test('https://klipy.com.evil.example/a.gif'));
    assert.ok(!GIF_HOST.test('http://static.klipy.com/a.gif'));
  });
});

describe('GET /api/gifs', () => {
  test('is off without a key', async () => {
    const res = await request(appWith(async () => assert.fail('no call'), '')).get('/api/gifs');
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'gifs_off');
  });

  test('searches with the query, trending without, the key never returned', async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      return new Response(
        JSON.stringify({
          result: true,
          data: { data: [item('a'), item('b', 'https://x.y')], has_next: true },
        }),
      );
    };
    const app = appWith(fetchImpl);
    const search = await request(app).get('/api/gifs?q=cat%20dance&page=2');
    assert.equal(search.status, 200);
    assert.deepEqual(
      search.body.gifs.map((g) => g.id),
      ['a'],
    );
    assert.equal(search.body.more, true);
    assert.ok(!JSON.stringify(search.body).includes('secret-key'));
    const searchUrl = new URL(asked[0]);
    assert.equal(searchUrl.pathname, '/api/v1/secret-key/gifs/search');
    assert.equal(searchUrl.searchParams.get('q'), 'cat dance');
    assert.equal(searchUrl.searchParams.get('page'), '2');
    assert.ok(!searchUrl.searchParams.get('customer_id').includes('acct-1'));

    await request(app).get('/api/gifs');
    assert.equal(new URL(asked[1]).pathname, '/api/v1/secret-key/gifs/trending');
  });

  test('says it failed when KLIPY does', async () => {
    const res = await request(appWith(async () => new Response('', { status: 500 }))).get(
      '/api/gifs?q=x',
    );
    assert.equal(res.status, 502);
  });
});
