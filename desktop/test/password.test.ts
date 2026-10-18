/**
 * The app's copy of the server's password rule. The server decides; this is
 * what tells someone what is missing as they type, so the two must agree —
 * these are the server's own cases from server/test/accounts.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStrongPassword, meetsRule } from '../src/shared/password.ts';

test('six characters with an uppercase, a lowercase, a digit and a symbol', () => {
  assert.equal(isStrongPassword('Ab1-xy'), true);
  assert.equal(isStrongPassword('Ção-9x'), true, 'letters beyond ASCII count');
});

test('each missing kind is named', () => {
  for (const [password, rule] of [
    ['Ab1-x', 'length'],
    ['abcde1-', 'upper'],
    ['ABCDE1-', 'lower'],
    ['Abcdef-', 'digit'],
    ['Abcdef1', 'symbol'],
  ] as const) {
    assert.equal(isStrongPassword(password), false, password);
    assert.equal(meetsRule(password, rule), false, `${password} should miss ${rule}`);
  }
});
