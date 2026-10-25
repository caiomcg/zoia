/**
 * Photos and videos in chats (ADR 0036): what a file is comes from its bytes,
 * files live under their chat, and removing a chat removes them.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanFileName, createMediaStore, mediaType, MEDIA_MAX_BYTES } from '../src/chat-media.js';

const bytes = (...values) => Buffer.from(values);
const ascii = (text) => Buffer.from(text, 'latin1');

describe('what a file is', () => {
  test('images: png, jpeg, gif and webp', () => {
    assert.equal(
      mediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)).type,
      'image/png',
    );
    assert.equal(mediaType(bytes(0xff, 0xd8, 0xff, 0xe0)).type, 'image/jpeg');
    assert.equal(mediaType(ascii('GIF89a......')).type, 'image/gif');
    assert.equal(mediaType(ascii('RIFF\0\0\0\0WEBPVP8 ')).type, 'image/webp');
  });

  test('videos: mp4 that Chromium plays, and webm', () => {
    const mp4 = mediaType(Buffer.concat([bytes(0, 0, 0, 0x20), ascii('ftypisom')]));
    assert.deepEqual(mp4, { type: 'video/mp4', kind: 'video' });
    assert.equal(mediaType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01)).type, 'video/webm');
  });

  test('QuickTime, html, svg, executables and nothing at all are not media', () => {
    assert.equal(mediaType(Buffer.concat([bytes(0, 0, 0, 0x14), ascii('ftypqt  ')])), null);
    assert.equal(mediaType(ascii('<svg xmlns="http://www.w3.org/2000/svg">')), null);
    assert.equal(mediaType(ascii('<html>')), null);
    assert.equal(mediaType(ascii('MZ\x90\0')), null);
    assert.equal(mediaType(Buffer.alloc(0)), null);
  });
});

describe('file names', () => {
  test('lose slashes and control characters, and are kept short', () => {
    assert.equal(cleanFileName('../../etc/passwd'), '....etcpasswd');
    assert.equal(cleanFileName('a\u0000b.png'), 'ab.png');
    assert.equal(cleanFileName('x'.repeat(300)).length, 100);
    assert.equal(cleanFileName('   '), null);
    assert.equal(cleanFileName(undefined), null);
  });
});

describe('the store', () => {
  let dir;
  let store;
  const PNG = Buffer.concat([
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    Buffer.alloc(32),
  ]);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zoia-media-'));
    store = createMediaStore({ dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('keeps a file under its chat and finds it again, typed by its bytes', async () => {
    const saved = await store.save('aaaa0000', PNG);
    assert.deepEqual(
      { ...saved, id: undefined },
      { id: undefined, type: 'image/png', kind: 'image', size: PNG.length },
    );
    const found = await store.find('aaaa0000', saved.id);
    assert.equal(found.type, 'image/png');
    assert.equal(found.size, PNG.length);
    assert.equal(await store.find('bbbb0000', saved.id), null);
  });

  test('refuses what is not media, and what is too large', async () => {
    assert.equal(await store.save('aaaa0000', ascii('hello world, not a picture')), null);
    assert.equal(
      await store.save('aaaa0000', Buffer.concat([PNG, Buffer.alloc(MEDIA_MAX_BYTES)])),
      null,
    );
    assert.deepEqual(await readdir(dir), []);
  });

  test('ids and chat ids are checked before going near a path', async () => {
    assert.equal(await store.find('aaaa0000', '../../../etc'), null);
    assert.equal(await store.find('../x', 'aaaaaaaaaaaaaaaa'), null);
    await assert.rejects(store.save('../escape', PNG));
  });

  test('removing a chat removes its files, and only its own', async () => {
    const mine = await store.save('aaaa0000', PNG);
    const theirs = await store.save('bbbb0000', PNG);
    await store.removeChat('aaaa0000');
    await store.removeChat('../nope');
    assert.equal(await store.find('aaaa0000', mine.id), null);
    assert.ok(await store.find('bbbb0000', theirs.id));
  });
});
