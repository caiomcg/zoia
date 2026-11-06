import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatTabs, EMPTY_CHAT_TABS } from '../src/renderer/chat/tabs.ts';

test('opens the default chat once, and opening another takes the unpinned tab', () => {
  let tabs = chatTabs(EMPTY_CHAT_TABS, { type: 'sync', ids: ['general', 'games'] });
  assert.deepEqual(tabs.ids, ['general']);
  tabs = chatTabs(tabs, { type: 'open', id: 'games' });
  assert.deepEqual(tabs.ids, ['games']);
  tabs = chatTabs(tabs, { type: 'open', id: 'general' });
  assert.deepEqual(tabs.ids, ['general']);
  assert.equal(tabs.activeId, 'general');
});

test('pinned tabs stay while the unpinned one cycles, and opening a tab already there only selects it', () => {
  let tabs = chatTabs(EMPTY_CHAT_TABS, { type: 'open', id: 'a' });
  tabs = chatTabs(tabs, { type: 'pin', id: 'a', pinned: true });
  tabs = chatTabs(tabs, { type: 'open', id: 'b' });
  tabs = chatTabs(tabs, { type: 'open', id: 'c' });
  assert.deepEqual(tabs.ids, ['a', 'c']);
  tabs = chatTabs(tabs, { type: 'open', id: 'a' });
  assert.deepEqual(tabs.ids, ['a', 'c']);
  assert.equal(tabs.activeId, 'a');
});

test('closing a background tab keeps the selection; closing the active tab selects a neighbor', () => {
  let tabs = EMPTY_CHAT_TABS;
  for (const id of ['a', 'b']) {
    tabs = chatTabs(tabs, { type: 'open', id });
    tabs = chatTabs(tabs, { type: 'pin', id, pinned: true });
  }
  tabs = chatTabs(tabs, { type: 'open', id: 'c' });
  tabs = chatTabs(tabs, { type: 'open', id: 'b' });
  tabs = chatTabs(tabs, { type: 'close', id: 'a' });
  assert.equal(tabs.activeId, 'b');
  tabs = chatTabs(tabs, { type: 'close', id: 'b' });
  assert.equal(tabs.activeId, 'c');
  tabs = chatTabs(tabs, { type: 'open', id: 'd' });
  tabs = chatTabs(tabs, { type: 'close', id: 'd' });
  assert.equal(tabs.activeId, null);
});

test('closing all tabs stays closed across refreshes and allows reopening from the sidebar', () => {
  let tabs = chatTabs(EMPTY_CHAT_TABS, { type: 'sync', ids: ['general'] });
  tabs = chatTabs(tabs, { type: 'close', id: 'general' });
  tabs = chatTabs(tabs, { type: 'sync', ids: ['general', 'new'] });
  assert.deepEqual(tabs.ids, []);
  assert.equal(tabs.activeId, null);
  tabs = chatTabs(tabs, { type: 'open', id: 'general' });
  assert.equal(tabs.activeId, 'general');
});

test('server deletions close tabs and sign-out resets the initial selection', () => {
  let tabs = chatTabs(EMPTY_CHAT_TABS, { type: 'sync', ids: ['a', 'b', 'c'] });
  tabs = chatTabs(tabs, { type: 'pin', id: 'a', pinned: true });
  tabs = chatTabs(tabs, { type: 'open', id: 'b' });
  tabs = chatTabs(tabs, { type: 'open', id: 'c' });
  tabs = chatTabs(tabs, { type: 'sync', ids: ['a'] });
  assert.deepEqual(tabs.ids, ['a']);
  assert.equal(tabs.activeId, 'a');
  tabs = chatTabs(tabs, { type: 'reset' });
  tabs = chatTabs(tabs, { type: 'sync', ids: ['other'] });
  assert.equal(tabs.activeId, 'other');
});

test('pinning groups zabas at the start while preserving selection and open tabs', () => {
  let tabs = EMPTY_CHAT_TABS;
  for (const id of ['c', 'b']) {
    tabs = chatTabs(tabs, { type: 'open', id });
    tabs = chatTabs(tabs, { type: 'pin', id, pinned: true });
  }
  tabs = chatTabs(tabs, { type: 'open', id: 'd' });
  assert.deepEqual(tabs.ids, ['c', 'b', 'd']);
  assert.deepEqual(tabs.pinned, ['c', 'b']);
  assert.equal(tabs.activeId, 'd');
  tabs = chatTabs(tabs, { type: 'open', id: 'e' });
  assert.deepEqual(tabs.pinned, ['c', 'b']);
  assert.deepEqual(tabs.ids, ['c', 'b', 'e']);
  tabs = chatTabs(tabs, { type: 'pin', id: 'c', pinned: false });
  assert.deepEqual(tabs.ids, ['b', 'c', 'e']);
  assert.deepEqual(tabs.pinned, ['b']);
});

test('closed or deleted zabas lose their pins; nonexistent zabas cannot be pinned', () => {
  let tabs = chatTabs(EMPTY_CHAT_TABS, { type: 'open', id: 'a' });
  tabs = chatTabs(tabs, { type: 'pin', id: 'a', pinned: true });
  tabs = chatTabs(tabs, { type: 'close', id: 'a' });
  assert.deepEqual(tabs.pinned, []);
  tabs = chatTabs(tabs, { type: 'open', id: 'b' });
  tabs = chatTabs(tabs, { type: 'pin', id: 'b', pinned: true });
  tabs = chatTabs(tabs, { type: 'sync', ids: [] });
  assert.deepEqual(tabs.pinned, []);
  assert.equal(chatTabs(tabs, { type: 'pin', id: 'missing', pinned: true }), tabs);
});

test('saved pins come back first, in order, when they still exist', () => {
  const tabs = chatTabs(EMPTY_CHAT_TABS, {
    type: 'sync',
    ids: ['general', 'b', 'c'],
    saved: ['c', 'gone', 'b'],
  });
  assert.deepEqual(tabs.pinned, ['c', 'b']);
  assert.deepEqual(tabs.ids, ['c', 'b', 'general']);
  assert.equal(tabs.activeId, 'general');
});

test('a dragged tab takes the place of the one it lands on, only within its own group', () => {
  let tabs = chatTabs(EMPTY_CHAT_TABS, {
    type: 'sync',
    ids: ['general', 'a', 'b', 'c'],
    saved: ['a', 'b', 'c'],
  });
  tabs = chatTabs(tabs, { type: 'move', id: 'c', to: 'a' });
  assert.deepEqual(tabs.ids, ['c', 'a', 'b', 'general']);
  assert.deepEqual(tabs.pinned, ['c', 'a', 'b']);
  tabs = chatTabs(tabs, { type: 'move', id: 'c', to: 'b' });
  assert.deepEqual(tabs.pinned, ['a', 'b', 'c']);
  assert.equal(chatTabs(tabs, { type: 'move', id: 'general', to: 'a' }), tabs);
});
