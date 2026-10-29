/** ! commands: what is being typed, which commands it may mean, and putting one in. */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, commandQuery, matchCommands } from '../src/renderer/chat/commands.ts';

const commands = [
  { name: 'play', description: 'Plays', addon: 'Zouve' },
  { name: 'pause', description: 'Pauses', addon: 'Zouve' },
  { name: 'skip', description: 'Skips', addon: 'Zouve' },
  { name: 'shuffle', description: 'Shuffles', addon: 'Zouve' },
];

describe('the query', () => {
  test('is the first word, from the !, while the caret is in it', () => {
    assert.deepEqual(commandQuery('!pl', 3), { query: 'pl' });
    assert.deepEqual(commandQuery('!', 1), { query: '' });
    assert.deepEqual(commandQuery('!play lofi', 3), { query: 'pl' });
  });

  test('is nothing once the arguments are being typed, or with no ! first', () => {
    assert.equal(commandQuery('!play lofi', 8), null);
    assert.equal(commandQuery('hey !play', 9), null);
    assert.equal(commandQuery('', 0), null);
    assert.equal(commandQuery('!play', 0), null);
  });
});

describe('matching', () => {
  test('by how the name starts, alphabetical', () => {
    assert.deepEqual(
      matchCommands(commands, 'p').map((c) => c.name),
      ['pause', 'play'],
    );
    assert.deepEqual(
      matchCommands(commands, '').map((c) => c.name),
      ['pause', 'play', 'shuffle', 'skip'],
    );
    assert.deepEqual(matchCommands(commands, 'x'), []);
  });

  test('ignores case and accents', () => {
    const named = [{ name: 'música', description: 'm', addon: 'a' }];
    assert.equal(matchCommands(named, 'MUSI').length, 1);
  });
});

describe('applying', () => {
  test('puts the name in, with a space, and keeps what followed', () => {
    assert.deepEqual(applyCommand('!pl', 'play'), { text: '!play ', caret: 6 });
    assert.deepEqual(applyCommand('!pl lofi beats', 'play'), {
      text: '!play lofi beats',
      caret: 6,
    });
  });
});
