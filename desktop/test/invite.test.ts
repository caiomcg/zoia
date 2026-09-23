/**
 * The invite file is the one thing a user is asked to handle by hand, and the
 * one input that arrives from outside the machine. These tests are mostly
 * about refusing bad ones clearly.
 *
 * Run directly by `node --test`: Node strips the types, so there is no build
 * step between this file and the module it exercises. That only works while
 * invite.ts imports nothing from `electron`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseInvite, InviteError, INVITE_FILENAME } from '../src/main/invite.ts';

const TOKEN = `zpair_a1b2c3d4_${'x'.repeat(43)}`;

function invite(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    serverUrl: 'https://zoia.example.com',
    pairingToken: TOKEN,
    ...overrides,
  });
}

describe('a well-formed invite', () => {
  test('yields the server and the token', () => {
    const result = parseInvite(invite());
    assert.equal(result.serverUrl, 'https://zoia.example.com');
    assert.equal(result.pairingToken, TOKEN);
  });

  test('a trailing slash is dropped, so paths are not doubled up', () => {
    // Every caller appends a path starting with "/", and https://host//api/pair
    // is a different request from https://host/api/pair.
    assert.equal(
      parseInvite(invite({ serverUrl: 'https://zoia.example.com/' })).serverUrl,
      'https://zoia.example.com',
    );
    assert.equal(
      parseInvite(invite({ serverUrl: 'https://zoia.example.com///' })).serverUrl,
      'https://zoia.example.com',
    );
  });

  test('surrounding whitespace survives a copy and paste', () => {
    const result = parseInvite(
      invite({ serverUrl: '  https://zoia.example.com  ', pairingToken: `  ${TOKEN}  ` }),
    );
    assert.equal(result.serverUrl, 'https://zoia.example.com');
    assert.equal(result.pairingToken, TOKEN);
  });

  test('a port is kept', () => {
    assert.equal(
      parseInvite(invite({ serverUrl: 'https://zoia.example.com:8443' })).serverUrl,
      'https://zoia.example.com:8443',
    );
  });

  test('the filename is the one the docs tell people to use', () => {
    assert.equal(INVITE_FILENAME, 'zoia-invite.json');
  });
});

describe('plaintext is refused except on loopback', () => {
  // The invite arrives from somewhere else. Honouring http:// in it would put
  // a device credential on the wire in the clear at the file author's
  // choosing, which is the one thing this validation exists to stop.
  for (const host of ['zoia.example.com', '203.0.113.10', 'internal']) {
    test(`http://${host} is rejected`, () => {
      assert.throws(() => parseInvite(invite({ serverUrl: `http://${host}` })), {
        name: 'InviteError',
        message: /Refusing to use http/,
      });
    });
  }

  for (const host of ['localhost', '127.0.0.1']) {
    test(`http://${host} is allowed, so a local server can be tried`, () => {
      assert.equal(
        parseInvite(invite({ serverUrl: `http://${host}:3000` })).serverUrl,
        `http://${host}:3000`,
      );
    });
  }

  test('a non-http scheme is rejected by name', () => {
    assert.throws(() => parseInvite(invite({ serverUrl: 'ftp://zoia.example.com' })), {
      message: /must start with https/,
    });
  });
});

describe('a malformed invite says what is actually wrong', () => {
  test('not JSON at all', () => {
    assert.throws(() => parseInvite('not json'), { message: /not valid JSON/ });
  });

  test('JSON, but not an object', () => {
    assert.throws(() => parseInvite('[]'), { message: /JSON object/ });
    assert.throws(() => parseInvite('"hello"'), { message: /JSON object/ });
    assert.throws(() => parseInvite('null'), { message: /JSON object/ });
  });

  test('a missing or empty serverUrl is named as such', () => {
    assert.throws(() => parseInvite(JSON.stringify({ pairingToken: TOKEN })), {
      message: /no serverUrl/,
    });
    assert.throws(() => parseInvite(invite({ serverUrl: '   ' })), { message: /no serverUrl/ });
  });

  test('a missing or empty pairingToken is named as such', () => {
    assert.throws(() => parseInvite(JSON.stringify({ serverUrl: 'https://zoia.example.com' })), {
      message: /no pairingToken/,
    });
    assert.throws(() => parseInvite(invite({ pairingToken: '  ' })), {
      message: /no pairingToken/,
    });
  });

  test('a serverUrl that is not a URL', () => {
    assert.throws(() => parseInvite(invite({ serverUrl: 'zoia.example.com' })), {
      message: /not a valid URL/,
    });
  });

  test('a token of the wrong shape is caught here, not as a 401 later', () => {
    for (const bad of [
      'zpair_nothex1_' + 'x'.repeat(43),
      'zdev_a1b2c3d4_' + 'x'.repeat(43),
      'zpair_a1b2c3d4_short',
      TOKEN.replace('zpair', 'pair'),
    ]) {
      assert.throws(() => parseInvite(invite({ pairingToken: bad })), {
        message: /not in the expected format/,
      });
    }
  });

  test('a query string or fragment is refused rather than silently dropped', () => {
    assert.throws(() => parseInvite(invite({ serverUrl: 'https://zoia.example.com/?k=secret' })), {
      message: /plain origin/,
    });
  });

  test('every rejection is an InviteError, so callers can tell it from a bug', () => {
    assert.throws(
      () => parseInvite('{'),
      (err: unknown) => err instanceof InviteError,
    );
  });
});
