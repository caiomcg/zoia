/**
 * Birthdays (ADR 0055): given at sign-up or later, day and month only, and
 * put on the calendar as an all-day event nobody can change.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createStage } from '../src/stage.js';
import { PASSWORD, testStores } from './people.js';
import { createEventStore } from '../src/schedule.js';
import { parseBirthday, today } from '../src/birthdays.js';

const quiet = { info() {}, warn() {}, error() {} };
const ZONE = 'America/Sao_Paulo';

let dir;
let stores;
let app;
let clock;

function buildApp() {
  return createApp({
    config: {
      sessionSecret: 'test-session-secret-long-enough',
      trustProxy: 1,
      secureCookies: false,
      roomName: 'zoia',
      rateLimit: { windowMs: 60_000, limit: 1000, signupLimit: 1000 },
      chat: {},
      birthdayZone: ZONE,
    },
    accountStore: stores.accounts,
    deviceStore: stores.devices,
    chatStore: stores.chats,
    directChatStore: stores.directChats,
    eventStore: stores.events,
    stage: createStage({
      rooms: { listParticipants: async () => [], updateParticipant: async () => {} },
      roomName: 'zoia',
      logger: quiet,
    }),
    logger: quiet,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-birthdays-'));
  stores = testStores(join(dir, 'zoia.db'));
  // 14 November 2026, ten in the morning in São Paulo.
  clock = Date.parse('2026-11-14T13:00:00Z');
  stores.events = createEventStore({ db: stores.db, logger: quiet, now: () => clock });
  app = buildApp();
});

afterEach(async () => {
  await stores.db.idle();
  stores.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the birthday itself', () => {
  test('is a day and a month that exist, February 29 included', () => {
    assert.equal(parseBirthday({ day: 29, month: 2 }), '02-29');
    assert.equal(parseBirthday({ day: 5, month: 11 }), '11-05');
    assert.equal(parseBirthday('11-05'), '11-05');
    for (const bad of [
      { day: 31, month: 4 },
      { day: 0, month: 1 },
      { day: 1, month: 13 },
      { day: '1', month: 1 },
      '2026-11-05',
      '1-5',
      null,
      42,
    ]) {
      assert.equal(parseBirthday(bad), null, JSON.stringify(bad));
    }
  });

  test('a day runs midnight to midnight in its zone, however long it is', () => {
    assert.deepEqual(today(clock, ZONE), {
      startsAt: '2026-11-14T03:00:00.000Z',
      durationMinutes: 1440,
      birthdays: ['11-14'],
    });
    // Clocks go forward in Lisbon on 29 March 2026: a day of 23 hours.
    assert.equal(today(Date.parse('2026-03-29T12:00:00Z'), 'Europe/Lisbon').durationMinutes, 1380);
  });

  test('February 29 is kept on the 28th when the year has none', () => {
    assert.deepEqual(today(Date.parse('2027-02-28T15:00:00Z'), ZONE).birthdays, ['02-28', '02-29']);
    assert.deepEqual(today(Date.parse('2028-02-28T15:00:00Z'), ZONE).birthdays, ['02-28']);
  });
});

describe('giving it', () => {
  test('at sign-up, kept and told back at sign-in', async () => {
    await request(app)
      .post('/api/signup')
      .send({ email: 'ana@example.com', password: PASSWORD, birthday: { day: 7, month: 3 } })
      .expect(201);
    const [account] = await stores.accounts.list();
    assert.equal(account.birthday, '03-07');
    await stores.accounts.approve(account.id, 'test');
    const login = await request(app)
      .post('/api/login')
      .send({ email: 'ana@example.com', password: PASSWORD, deviceName: 'PC' })
      .expect(200);
    assert.equal(login.body.birthday, '03-07');
  });

  test('a sign-up with a day that does not exist is refused; one with none, from an older app, is not', async () => {
    const res = await request(app)
      .post('/api/signup')
      .send({ email: 'ana@example.com', password: PASSWORD, birthday: { day: 30, month: 2 } })
      .expect(400);
    assert.equal(res.body.error, 'invalid_birthday');
    await request(app)
      .post('/api/signup')
      .send({ email: 'ana@example.com', password: PASSWORD })
      .expect(201);
  });
});
