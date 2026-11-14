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
import { PASSWORD, signIn, testStores } from './people.js';
import { createEventStore } from '../src/schedule.js';
import { parseBirthday, today } from '../src/birthdays.js';
import { loadConfig } from '../src/config.js';

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

const sweep = () => app.locals.scheduleSweep();
const birthdaysOn = async (agent) =>
  (await agent.get('/api/schedule').expect(200)).body.events.filter((e) => e.kind === 'birthday');

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

  test('the server refuses to start with a time zone it does not know', () => {
    const env = {
      SESSION_SECRET: 'x'.repeat(32),
      LIVEKIT_API_KEY: 'k',
      LIVEKIT_API_SECRET: 's',
      LIVEKIT_WS_URL: 'wss://x',
    };
    assert.equal(loadConfig(env).birthdayZone, ZONE);
    assert.throws(() => loadConfig({ ...env, BIRTHDAY_TZ: 'Mars/Olympus' }), /BIRTHDAY_TZ/);
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

  test('someone without one is told so at every sign-in, until they give it', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    assert.equal((await ana.agent.get('/api/session').expect(200)).body.birthday, null);

    const bad = await ana.agent
      .put('/api/birthday')
      .send({ birthday: { day: 31, month: 6 } })
      .expect(400);
    assert.equal(bad.body.error, 'invalid_birthday');
    assert.equal((await ana.agent.get('/api/session')).body.birthday, null);

    const res = await ana.agent
      .put('/api/birthday')
      .send({ birthday: { day: 30, month: 6 } })
      .expect(200);
    assert.equal(res.body.birthday, '06-30');
    assert.equal((await ana.agent.get('/api/session')).body.birthday, '06-30');
  });

  test('only by the person, signed in', async () => {
    await request(app)
      .put('/api/birthday')
      .send({ birthday: { day: 1, month: 1 } })
      .expect(401);
  });
});

describe('the birthday on the calendar', () => {
  test('is an all-day event on the day, once, under the name they have now', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    await stores.accounts.setBirthday(ana.account.id, { day: 14, month: 11 });
    await stores.accounts.setBirthday(bia.account.id, { day: 15, month: 11 });

    await sweep();
    await sweep();
    const [party, ...rest] = await birthdaysOn(bia.agent);
    assert.deepEqual(rest, []);
    assert.equal(party.subjectId, ana.account.id);
    assert.equal(party.subjectName, 'Ana');
    assert.equal(party.startsAt, '2026-11-14T03:00:00.000Z');
    assert.equal(party.durationMinutes, 1440);
    assert.equal(party.channelId, null);
    assert.equal(party.createdBy, null);

    await stores.accounts.rename(ana.account.id, 'Aninha');
    assert.equal((await birthdaysOn(bia.agent))[0].subjectName, 'Aninha');

    // The next day it is Bia's turn, and Ana's has ended.
    clock += 24 * 3_600_000;
    await sweep();
    assert.deepEqual(
      (await birthdaysOn(ana.agent)).map((e) => e.subjectName),
      ['Bia'],
    );
  });

  test('goes on at once when someone gives today as theirs, and off when they change it', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    await ana.agent
      .put('/api/birthday')
      .send({ birthday: { day: 14, month: 11 } })
      .expect(200);
    await sweep();
    assert.equal((await birthdaysOn(ana.agent)).length, 1);

    await ana.agent
      .put('/api/birthday')
      .send({ birthday: { day: 1, month: 1 } })
      .expect(200);
    await sweep();
    assert.deepEqual(await birthdaysOn(ana.agent), []);
  });

  test('is not for someone pending or disabled', async () => {
    const viewer = await signIn(app, stores.accounts, 'Ana');
    await request(app)
      .post('/api/signup')
      .send({ email: 'p@example.com', password: PASSWORD, birthday: { day: 14, month: 11 } })
      .expect(201);
    const off = await signIn(app, stores.accounts, 'Off');
    await stores.accounts.setBirthday(off.account.id, { day: 14, month: 11 });
    await stores.accounts.setStatus(off.account.id, 'disabled', 'test');

    await sweep();
    assert.deepEqual(await birthdaysOn(viewer.agent), []);
  });

  test('nobody changes, cancels or answers it, admins included', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const boss = await signIn(app, stores.accounts, 'Boss', { role: 'admin' });
    await stores.accounts.setBirthday(ana.account.id, { day: 14, month: 11 });
    await sweep();
    const [party] = await birthdaysOn(boss.agent);

    for (const who of [ana, boss]) {
      await who.agent.patch(`/api/schedule/${party.id}`).send({ title: 'x' }).expect(403);
      await who.agent.delete(`/api/schedule/${party.id}`).expect(403);
      await who.agent.put(`/api/schedule/${party.id}/rsvp`).send({ answer: 'going' }).expect(403);
    }
    assert.equal((await birthdaysOn(ana.agent)).length, 1);
  });

  test('is not announced as an event starting, nor counted against the limit', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    await stores.accounts.setBirthday(ana.account.id, { day: 14, month: 11 });
    const announced = await sweep();
    assert.deepEqual(announced, []);
    assert.equal((await stores.events.list()).length, 1);
  });

  test('goes with its account', async () => {
    const ana = await signIn(app, stores.accounts, 'Ana');
    const bia = await signIn(app, stores.accounts, 'Bia');
    await stores.accounts.setBirthday(ana.account.id, { day: 14, month: 11 });
    await sweep();
    stores.db.sqlite.prepare('DELETE FROM accounts WHERE id = ?').run(ana.account.id);
    assert.deepEqual(await birthdaysOn(bia.agent), []);
  });
});
