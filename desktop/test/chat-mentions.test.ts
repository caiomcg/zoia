/** @mentions: what is being typed, who it may mean, and how a message shows them. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMention,
  matchPeople,
  mentionQuery,
  mentionedIn,
  splitMentions,
} from '../src/renderer/chat/mentions.ts';

const people = [
  { id: '1', name: 'Ana' },
  { id: '2', name: 'Ana Paula' },
  { id: '3', name: 'Bia Souza' },
  { id: '4', name: 'João' },
];

describe('the query being typed', () => {
  test('starts at an @ at the start or after a space, and ends at the caret', () => {
    assert.deepEqual(mentionQuery('oi @an', 6), { start: 3, query: 'an' });
    assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
    assert.deepEqual(mentionQuery('oi\n@Bia S', 9), { start: 3, query: 'Bia S' });
  });

  test('is not an email address, a finished line, or a run-on', () => {
    assert.equal(mentionQuery('ana@example', 11), null);
    assert.equal(mentionQuery('@ana\nmore', 9), null);
    assert.equal(mentionQuery(`@${'x'.repeat(40)}`, 41), null);
    assert.equal(mentionQuery('no at here', 10), null);
  });
});

describe('who the query may mean', () => {
  test('names it starts first, then a later word, ignoring case and accents', () => {
    assert.deepEqual(
      matchPeople(people, 'ana').map((p) => p.name),
      ['Ana', 'Ana Paula'],
    );
    assert.deepEqual(
      matchPeople(people, 'souza').map((p) => p.name),
      ['Bia Souza'],
    );
    assert.deepEqual(
      matchPeople(people, 'joao').map((p) => p.name),
      ['João'],
    );
    assert.equal(matchPeople(people, '').length, 4);
    assert.equal(matchPeople(people, '', 2).length, 2);
  });

  test('runs past a space while a name still fits', () => {
    assert.deepEqual(
      matchPeople(people, 'bia s').map((p) => p.name),
      ['Bia Souza'],
    );
    assert.deepEqual(matchPeople(people, 'bia x'), []);
  });
});

test('a chosen name replaces the query, with one space after it', () => {
  const query = mentionQuery('oi @bi tudo', 6)!;
  assert.deepEqual(applyMention('oi @bi tudo', query, 'Bia Souza'), {
    text: 'oi @Bia Souza tudo',
    caret: 14,
  });
});

test('only people still named in the text are sent as mentions, once each', () => {
  const picked = [
    { id: '1', name: 'Ana' },
    { id: '3', name: 'Bia Souza' },
    { id: '1', name: 'Ana' },
  ];
  assert.deepEqual(mentionedIn('oi @Ana', picked), [{ id: '1', name: 'Ana' }]);
});

describe('a message shown with its mentions', () => {
  test('splits around each mention, the longest name first', () => {
    const mentions = [
      { id: '1', name: 'Ana' },
      { id: '2', name: 'Ana Paula' },
    ];
    assert.deepEqual(splitMentions('oi @Ana Paula e @Ana!', mentions), [
      { text: 'oi ' },
      { text: '@Ana Paula', mention: mentions[1] },
      { text: ' e ' },
      { text: '@Ana', mention: mentions[0] },
      { text: '!' },
    ]);
  });

  test('leaves text without mentions, or an @ inside a word, as it is', () => {
    assert.deepEqual(splitMentions('oi'), [{ text: 'oi' }]);
    assert.deepEqual(splitMentions('x@Ana', [{ id: '1', name: 'Ana' }]), [{ text: 'x@Ana' }]);
  });
});
