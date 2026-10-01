import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { replaceFile } from '../src/store.js';

/** A rename that fails with `codes`, in order, and then succeeds. */
function flakyMove(...codes) {
  const calls = [];
  const move = async (from, to) => {
    calls.push([from, to]);
    const code = codes[calls.length - 1];
    if (code) throw Object.assign(new Error(code), { code });
  };
  return { move, calls };
}

describe('replacing a store file', () => {
  test('a target locked for a moment is replaced once it is free', async () => {
    const { move, calls } = flakyMove('EPERM', 'EBUSY', 'EACCES');
    await replaceFile('a.tmp', 'a', { move, delayMs: 0 });
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[3], ['a.tmp', 'a']);
  });

  test('a target that stays locked still fails, after a bounded number of tries', async () => {
    const { move, calls } = flakyMove(...Array(10).fill('EPERM'));
    await assert.rejects(replaceFile('a.tmp', 'a', { move, delayMs: 0, attempts: 3 }), {
      code: 'EPERM',
    });
    assert.equal(calls.length, 3);
  });

  test('any other error is not retried', async () => {
    const { move, calls } = flakyMove('ENOSPC');
    await assert.rejects(replaceFile('a.tmp', 'a', { move, delayMs: 0 }), { code: 'ENOSPC' });
    assert.equal(calls.length, 1);
  });
});
