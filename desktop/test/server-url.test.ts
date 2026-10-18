/**
 * The server address is the one thing a person types before their password,
 * and the password follows it wherever it points. These pin what an address
 * may be: an https origin, or plain http on this machine only.
 *
 * server-url.ts imports nothing from `electron`, so this runs with plain
 * `node --test`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerUrl, ServerUrlError } from '../src/main/server-url.ts';

describe('a usable address', () => {
  test('an https origin is kept as it is', () => {
    assert.equal(normalizeServerUrl('https://zoia.example.com'), 'https://zoia.example.com');
  });

  test('a trailing slash is dropped, so paths are not doubled up', () => {
    assert.equal(normalizeServerUrl('https://zoia.example.com/'), 'https://zoia.example.com');
    assert.equal(normalizeServerUrl('https://zoia.example.com///'), 'https://zoia.example.com');
  });

  test('surrounding whitespace survives a copy and paste', () => {
    assert.equal(normalizeServerUrl('  https://zoia.example.com  '), 'https://zoia.example.com');
  });

  test('a port is kept', () => {
    assert.equal(
      normalizeServerUrl('https://zoia.example.com:8443'),
      'https://zoia.example.com:8443',
    );
  });

  test('an address typed without a scheme is taken as https', () => {
    assert.equal(normalizeServerUrl('zoia.example.com'), 'https://zoia.example.com');
  });
});

describe('plaintext is refused except on loopback', () => {
  // A password would cross the network in the clear, at the choosing of
  // whoever told someone the address.
  for (const host of ['zoia.example.com', '203.0.113.10', 'internal']) {
    test(`http://${host} is rejected`, () => {
      assert.throws(() => normalizeServerUrl(`http://${host}`), {
        name: 'ServerUrlError',
        message: /Refusing to use http/,
      });
    });
  }

  for (const host of ['localhost', '127.0.0.1']) {
    test(`http://${host} is allowed, so a local server can be tried`, () => {
      assert.equal(normalizeServerUrl(`http://${host}:3000`), `http://${host}:3000`);
    });
  }

  test('a non-http scheme is rejected by name', () => {
    assert.throws(() => normalizeServerUrl('ftp://zoia.example.com'), {
      message: /must start with https/,
    });
  });
});

describe('a bad address says what is wrong', () => {
  test('nothing at all', () => {
    assert.throws(() => normalizeServerUrl('   '), { message: /No server address/ });
  });

  test('a query string, fragment or credentials are refused rather than dropped', () => {
    for (const bad of [
      'https://zoia.example.com/?k=secret',
      'https://zoia.example.com/#x',
      'https://user:pass@zoia.example.com',
    ]) {
      assert.throws(() => normalizeServerUrl(bad), { message: /plain origin/ }, bad);
    }
  });

  test('every rejection is a ServerUrlError, so callers can tell it from a bug', () => {
    assert.throws(
      () => normalizeServerUrl('https://'),
      (err: unknown) => err instanceof ServerUrlError,
    );
  });
});
