/**
 * The chat's bookkeeping. Ids here are real version 1 uuids, whose text puts
 * the time's low bits first: string order is not time order.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEdit,
  applyReaction,
  compareIds,
  continues,
  lastOwnMessage,
  laterMarker,
  mergeMessages,
  newMessagesIndex,
  replyExcerpt,
  seenBy,
  uuidTime,
} from '../src/renderer/chat/model.ts';
import type { ChatMessage } from '../src/shared/ipc.ts';

/** A v1 uuid for a 60-bit time, laid out as the spec does. */
function idAt(time: bigint, node = '8000-000000000000'): string {
  const hex = time.toString(16).padStart(15, '0');
  const high = hex.slice(0, 3);
  const mid = hex.slice(3, 7);
  const low = hex.slice(7, 15);
  return `${low}-${mid}-1${high}-${node}`;
}

function message(time: bigint, authorId: string, sentAt = '2026-10-21T12:00:00Z'): ChatMessage {
  return { id: idAt(time), chatId: 'c', authorId, body: String(time), sentAt };
}

describe('message ids', () => {
  test('order by the time inside them, not as text', () => {
    // 0x1_0000_0000 has a smaller low field than 0xffff_ffff, so it sorts
    // first as text while being later in time.
    const earlier = idAt(0xffffffffn);
    const later = idAt(0x100000000n);
    assert.ok(later < earlier, 'as text, the later id sorts first');
    assert.ok(compareIds(earlier, later) < 0);
    assert.ok(compareIds(later, earlier) > 0);
    assert.equal(compareIds(earlier, earlier), 0);
  });

  test('anything but a time-based uuid has no time', () => {
    assert.equal(uuidTime('nope'), -1n);
    assert.equal(uuidTime('9b2b6c5e-6f1a-4d7e-9a43-2f1b0c8d9e7a'), -1n);
  });
});

describe('merging', () => {
  test('pages and live messages become one list, oldest first, each once', () => {
    const a = message(1n, 'ana');
    const b = message(0x100000000n, 'bia');
    const c = message(0x200000000n, 'ana');
    assert.deepEqual(
      mergeMessages([c, b], [b, a], [c]).map((m) => m.authorId + m.body),
      [a, b, c].map((m) => m.authorId + m.body),
    );
  });
});

describe('the new messages line', () => {
  const list = [message(1n, 'ana'), message(2n, 'bia'), message(3n, 'ana'), message(4n, 'bia')];

  test('goes before the first message from someone else after the marker', () => {
    assert.equal(newMessagesIndex(list, list[1]!.id, 'ana'), 3);
    assert.equal(newMessagesIndex(list, list[0]!.id, 'ana'), 1);
  });

  test('is nowhere when everything is read, and at the first message never read', () => {
    assert.equal(newMessagesIndex(list, list[3]!.id, 'ana'), -1);
    assert.equal(newMessagesIndex(list, null, 'ana'), 1);
  });
});

describe('seen by', () => {
  test('is everyone but the author whose marker reached the message', () => {
    const m = message(5n, 'ana');
    const readers = {
      ana: idAt(5n),
      bia: idAt(5n),
      caio: idAt(6n),
      davi: idAt(4n),
    };
    assert.deepEqual(seenBy(m, readers).sort(), ['bia', 'caio']);
  });

  test('a marker only moves forward', () => {
    assert.equal(laterMarker(undefined, idAt(2n)), idAt(2n));
    assert.equal(laterMarker(idAt(3n), idAt(2n)), idAt(3n));
    assert.equal(laterMarker(idAt(1n), idAt(2n)), idAt(2n));
  });
});

describe('grouping', () => {
  test('one author within five minutes is one group', () => {
    const a = message(1n, 'ana', '2026-10-21T12:00:00Z');
    assert.equal(continues(a, message(2n, 'ana', '2026-10-21T12:04:59Z')), true);
    assert.equal(continues(a, message(2n, 'ana', '2026-10-21T12:05:00Z')), false);
    assert.equal(continues(a, message(2n, 'bia', '2026-10-21T12:01:00Z')), false);
    assert.equal(continues(undefined, a), false);
  });
});

describe('reactions', () => {
  test('add and take off, each harmless twice, an emptied emoji going', () => {
    let r = applyReaction(undefined, '👍', 'ana', true);
    r = applyReaction(r, '👍', 'ana', true);
    r = applyReaction(r, '🎉', 'bia', true);
    r = applyReaction(r, '👍', 'bia', true);
    assert.deepEqual(r, [
      { emoji: '👍', accountIds: ['ana', 'bia'] },
      { emoji: '🎉', accountIds: ['bia'] },
    ]);
    r = applyReaction(r, '🎉', 'bia', false);
    r = applyReaction(r, '🎉', 'bia', false);
    r = applyReaction(r, '👍', 'ana', false);
    assert.deepEqual(r, [{ emoji: '👍', accountIds: ['bia'] }]);
  });

  test('an unchanged list is the same list', () => {
    const r = [{ emoji: '👍', accountIds: ['ana'] }];
    assert.equal(applyReaction(r, '👍', 'ana', true), r);
    assert.equal(applyReaction(r, '🎉', 'ana', false), r);
  });
});

describe('edits', () => {
  test('the edited message takes its new words, keeping its place and reactions', () => {
    const a = { ...message(1n, 'ana'), reactions: [{ emoji: '👍', accountIds: ['bia'] }] };
    const b = message(2n, 'bia');
    const edited = { ...a, body: 'novo', mentions: [{ id: 'bia', name: 'Bia' }], reactions: [] };
    const after = applyEdit([a, b], { ...edited, editedAt: '2026-10-29T12:00:00Z' });
    assert.equal(after[0]!.body, 'novo');
    assert.deepEqual(after[0]!.mentions, [{ id: 'bia', name: 'Bia' }]);
    assert.equal(after[0]!.editedAt, '2026-10-29T12:00:00Z');
    assert.deepEqual(after[0]!.reactions, a.reactions);
    assert.equal(after[1], b);
  });

  test('a reply quotes the new words; a message not shown changes nothing', () => {
    const a = message(1n, 'ana');
    const reply = {
      ...message(2n, 'bia'),
      replyTo: { id: a.id, authorId: 'ana', authorName: 'Ana', body: 'velho' },
    };
    const long = `novo ${'x'.repeat(300)}`;
    const after = applyEdit([a, reply], { ...a, body: long, editedAt: '2026-10-29T12:00:00Z' });
    assert.equal(after[1]!.replyTo!.body, replyExcerpt(long));
    assert.equal(after[1]!.replyTo!.authorName, 'Ana');
    const list = [reply];
    assert.equal(applyEdit(list, { ...a, body: 'x' }), list);
  });

  test('an older edit arriving late does not undo a newer one', () => {
    const a = { ...message(1n, 'ana'), body: 'segunda', editedAt: '2026-10-29T12:00:02Z' };
    const list = [a];
    assert.equal(
      applyEdit(list, { ...a, body: 'primeira', editedAt: '2026-10-29T12:00:01Z' }),
      list,
    );
    assert.equal(
      applyEdit(list, { ...a, body: 'terceira', editedAt: '2026-10-29T12:00:03Z' })[0]!.body,
      'terceira',
    );
  });

  test('a quote is one line, cut where the server cuts it', () => {
    assert.equal(replyExcerpt('  oi\n\n  gente '), 'oi gente');
    const cut = replyExcerpt('y'.repeat(250));
    assert.equal(cut.length, 200);
    assert.ok(cut.endsWith('…'));
  });

  test('Up edits your newest message, whoever wrote after it', () => {
    const mine = message(1n, 'ana');
    const list = [message(0n, 'ana'), mine, message(2n, 'bia')];
    assert.equal(lastOwnMessage(list, 'ana'), mine);
    assert.equal(lastOwnMessage(list, 'caio'), undefined);
  });
});
