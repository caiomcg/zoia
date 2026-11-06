import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isDucked, setDucked, subscribeDucked } from '../src/renderer/voice/duck.ts';

describe('ducking while you hear yourself', () => {
  test('starts unducked and tells listeners only on a change', () => {
    assert.equal(isDucked(), false);
    let calls = 0;
    const stop = subscribeDucked(() => calls++);
    setDucked(true);
    setDucked(true);
    assert.equal(isDucked(), true);
    setDucked(false);
    assert.equal(isDucked(), false);
    assert.equal(calls, 2);
    stop();
    setDucked(true);
    assert.equal(calls, 2);
    setDucked(false);
  });
});
