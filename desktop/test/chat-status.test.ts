/**
 * Statuses in the sidebar (ADR 0038): your own dot, and who is listed first.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { byPresence, ownDot } from '../src/renderer/chat/status.ts';

describe('ownDot', () => {
  test('nothing until the server has said', () => {
    assert.equal(ownDot(null, {}, 'me'), null);
  });

  test('invisible is yours alone to see', () => {
    assert.equal(ownDot('invisible', {}, 'me'), 'invisible');
  });

  test('what others see, so an idle machine shows you away', () => {
    assert.equal(ownDot('online', { me: 'away' }, 'me'), 'away');
    assert.equal(ownDot('busy', {}, 'me'), 'busy', 'before the server has told');
  });
});

describe('byPresence', () => {
  test('those on the server first, each group by name', () => {
    const people = ['Caio', 'Ana', 'Bia', 'Duda'].map((name) => ({
      id: name.toLowerCase(),
      name,
      avatar: null,
    }));
    const listed = byPresence(people, { duda: 'away', bia: 'busy' });
    assert.deepEqual(
      listed.map((p) => [p.name, p.status]),
      [
        ['Bia', 'busy'],
        ['Duda', 'away'],
        ['Ana', 'offline'],
        ['Caio', 'offline'],
      ],
    );
  });
});
