import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { answerOnJoin, canJoinEvent } from '../src/renderer/schedule/model.ts';

describe('joining an event counts as going', () => {
  test('joining answers going unless already going', () => {
    assert.equal(answerOnJoin(null), 'going');
    assert.equal(answerOnJoin(undefined), 'going');
    assert.equal(answerOnJoin('maybe'), 'going');
    assert.equal(answerOnJoin('no'), 'going');
    assert.equal(answerOnJoin('going'), null);
  });

  test('only an event that is on can be joined from it', () => {
    assert.equal(canJoinEvent('live'), true);
    assert.equal(canJoinEvent('soon'), false);
    assert.equal(canJoinEvent('later'), false);
    assert.equal(canJoinEvent('ended'), false);
  });
});
