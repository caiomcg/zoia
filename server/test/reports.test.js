/**
 * Error reports exist so a crash on someone else's machine arrives with its
 * stack rather than as a screenshot. These cover the parts that would let a
 * misbehaving client cause trouble.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createReportStore } from '../src/reports.js';

const quiet = () => ({ error() {}, info() {}, warn() {}, log() {} });

describe('error reports', () => {
  test('records who reported, so a report can be traced to a machine', () => {
    const store = createReportStore({ logger: quiet() });
    store.add({ kind: 'crash', message: 'boom' }, { id: 'dev1', name: 'Yure' });

    const [entry] = store.list();
    assert.equal(entry.device, 'Yure');
    assert.equal(entry.deviceId, 'dev1');
    assert.equal(entry.message, 'boom');
  });

  test('newest first, so the last crash is the one you see', () => {
    const store = createReportStore({ logger: quiet() });
    store.add({ message: 'first' }, { id: 'a', name: 'A' });
    store.add({ message: 'second' }, { id: 'a', name: 'A' });
    assert.equal(store.list()[0].message, 'second');
  });

  test('a client stuck in a crash loop cannot grow the store without bound', () => {
    const store = createReportStore({ logger: quiet() });
    for (let i = 0; i < 500; i++) store.add({ message: `e${i}` }, { id: 'a', name: 'A' });

    const list = store.list();
    assert.ok(list.length <= 200, `expected a bounded store, got ${list.length}`);
    assert.equal(list[0].message, 'e499', 'the most recent must survive');
  });

  test('a diagnostic context survives long enough to be useful', () => {
    // This was clipped to 1000 characters, roughly twelve lines, which cut off
    // everything above ffmpeg's generic final line — the report said
    // "Conversion failed!" and nothing about why.
    const store = createReportStore({ logger: quiet() });
    const log = Array.from({ length: 200 }, (_, i) => `line ${i} of ffmpeg output`).join('\n');
    store.add(
      { kind: 'gpu-broadcast-failed', message: 'Conversion failed!', context: log },
      { id: 'a', name: 'A' },
    );

    const [entry] = store.list();
    assert.ok(entry.context.length > 4000, `context was clipped to ${entry.context.length}`);
    assert.match(entry.context, /line 5 of ffmpeg output/);
  });

  test('an enormous stack is truncated rather than logged whole', () => {
    const store = createReportStore({ logger: quiet() });
    store.add({ message: 'x', stack: 'y'.repeat(50_000) }, { id: 'a', name: 'A' });
    assert.ok(store.list()[0].stack.length < 5000);
  });

  test('a report with nothing useful in it does not throw', () => {
    const store = createReportStore({ logger: quiet() });
    store.add(undefined, undefined);
    store.add({}, null);
    const [entry] = store.list();
    assert.equal(entry.device, 'unknown');
    assert.equal(entry.kind, 'error');
  });

  test('non-string fields are stringified rather than trusted', () => {
    const store = createReportStore({ logger: quiet() });
    store.add({ message: { nested: true }, kind: 42 }, { id: 'a', name: 'A' });
    const [entry] = store.list();
    assert.equal(typeof entry.message, 'string');
    assert.equal(typeof entry.kind, 'string');
  });
});
