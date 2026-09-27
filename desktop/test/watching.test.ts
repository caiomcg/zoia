/**
 * The watch list is the only evidence a broadcaster has of who is looking, so
 * a wrong answer here is a wrong eye count on someone's screen.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WATCHING_ATTRIBUTE, isWatching, watchingValue } from '../src/renderer/livekit/watching.ts';

describe('watchingValue', () => {
  test('lists selected broadcasts, sorted', () => {
    assert.equal(watchingValue(new Set(['b', 'a']), new Set()), 'a,b');
  });

  test('leaves out paused thumbnails', () => {
    assert.equal(watchingValue(new Set(['a', 'b']), new Set(['b'])), 'a');
  });

  test('is empty when watching nothing', () => {
    assert.equal(watchingValue(new Set(), new Set()), '');
  });
});

describe('isWatching', () => {
  test('finds an identity in the list', () => {
    assert.equal(isWatching({ [WATCHING_ATTRIBUTE]: 'a,b' }, 'b'), true);
  });

  test('does not match on a prefix', () => {
    assert.equal(isWatching({ [WATCHING_ATTRIBUTE]: 'alice2' }, 'alice'), false);
  });

  test('is false with no attribute, or an empty one', () => {
    assert.equal(isWatching(undefined, 'a'), false);
    assert.equal(isWatching({}, 'a'), false);
    assert.equal(isWatching({ [WATCHING_ATTRIBUTE]: '' }, ''), false);
  });
});
