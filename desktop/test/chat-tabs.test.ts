import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatTabs, EMPTY_CHAT_TABS } from '../src/renderer/chat/tabs.ts';

test('opens the default chat once and selects existing tabs without duplicates', () => {
  let tabs = chatTabs(EMPTY_CHAT_TABS, { type: 'sync', ids: ['general', 'games'] });
  assert.deepEqual(tabs.ids, ['general']);
  tabs = chatTabs(tabs, { type: 'open', id: 'games' });
  tabs = chatTabs(tabs, { type: 'open', id: 'general' });
  assert.deepEqual(tabs.ids, ['general', 'games']);
  assert.equal(tabs.activeId, 'general');
});

test('closing a background tab keeps the selection; closing the active tab selects a neighbor', () => {
  let tabs = EMPTY_CHAT_TABS;
  for (const id of ['a', 'b', 'c']) tabs = chatTabs(tabs, { type: 'open', id });
  tabs = chatTabs(tabs, { type: 'open', id: 'b' });
  tabs = chatTabs(tabs, { type: 'close', id: 'a' });
  assert.equal(tabs.activeId, 'b');
  tabs = chatTabs(tabs, { type: 'close', id: 'b' });
  assert.equal(tabs.activeId, 'c');
  tabs = chatTabs(tabs, { type: 'open', id: 'd' });
  tabs = chatTabs(tabs, { type: 'close', id: 'd' });
  assert.equal(tabs.activeId, 'c');
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
  tabs = chatTabs(tabs, { type: 'open', id: 'b' });
  tabs = chatTabs(tabs, { type: 'open', id: 'c' });
  tabs = chatTabs(tabs, { type: 'sync', ids: ['a'] });
  assert.deepEqual(tabs.ids, ['a']);
  assert.equal(tabs.activeId, 'a');
  tabs = chatTabs(tabs, { type: 'reset' });
  tabs = chatTabs(tabs, { type: 'sync', ids: ['other'] });
  assert.equal(tabs.activeId, 'other');
});
