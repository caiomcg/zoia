/**
 * Someone leaving fades out where they were. Getting the order wrong makes
 * the whole list jump just as the fade starts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLeaving, type Leaving } from '../src/renderer/presence.ts';

const keyOf = (item: string) => item;
const gone = (entries: [string, number][]) =>
  new Map<string, Leaving<string>>(
    entries.map(([item, index]) => [item, { item, index, until: 0 }]),
  );

test('nothing leaving is the list as it is', () => {
  assert.deepEqual(
    mergeLeaving(['a', 'b'], keyOf, new Map()).map((p) => [p.key, p.leaving]),
    [
      ['a', false],
      ['b', false],
    ],
  );
});

test('a leaving item fades out where it was', () => {
  const merged = mergeLeaving(['a', 'c'], keyOf, gone([['b', 1]]));
  assert.deepEqual(
    merged.map((p) => [p.key, p.leaving]),
    [
      ['a', false],
      ['b', true],
      ['c', false],
    ],
  );
});

test('several leaving at once keep their order', () => {
  const merged = mergeLeaving(
    ['b'],
    keyOf,
    gone([
      ['c', 2],
      ['a', 0],
    ]),
  );
  assert.deepEqual(
    merged.map((p) => p.key),
    ['a', 'b', 'c'],
  );
});

test('someone who comes back is not also shown leaving', () => {
  assert.deepEqual(
    mergeLeaving(['a', 'b'], keyOf, gone([['b', 1]])).map((p) => [p.key, p.leaving]),
    [
      ['a', false],
      ['b', false],
    ],
  );
});
