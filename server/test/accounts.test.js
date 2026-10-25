/**
 * Accounts, ADR 0031. Sign-up is open to anyone who knows the host, so most of
 * what is worth testing is what it does *not* let through: a pending account
 * reaching the room, an admin reaching further than their role, a password or
 * a code reaching the disk or the log.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { openDatabase } from '../src/database.js';
import { databaseOnDisk } from './database-files.js';
import { createDeviceStore } from '../src/devices.js';
import { createAccountStore, canManage, normalizeEmail } from '../src/accounts.js';
import { createTokenIssuer, decodeTokenPayload } from '../src/token.js';
import { createStage } from '../src/stage.js';
import { fixedChannels } from '../src/channels.js';
import { AVATAR_ATTRIBUTE, AVATAR_MAX_BYTES, createAvatarStore } from '../src/avatars.js';

const PASSWORD = 'Correct-horse-1';

let dir;
let db;
let accounts;
let devices;
let app;
let logLines;
/** The LiveKit room the app sees, so a test can tell who is still in it. */
let rooms;

const quiet = () => {
  logLines = [];
  const capture = (line) => logLines.push(String(line));
  return { info: capture, warn: capture, error: capture };
};

function buildApp({ accounts: accountConfig, rateLimit, channels } = {}) {
  const logger = quiet();
  rooms = {
    participants: [],
    listParticipants: async () => rooms.participants,
    updateParticipant: async () => {},
    removeParticipant: async (_room, identity) => {
      rooms.participants = rooms.participants.filter((p) => p.identity !== identity);
    },
  };
  return createApp({
    config: {
      sessionSecret: 'test-session-secret-long-enough',
      trustProxy: 1,
      secureCookies: false,
      roomName: 'zoia',
      rateLimit: {
        windowMs: 60_000,
        limit: 1000,
        codeLimit: 1000,
        signupLimit: 1000,
        ...rateLimit,
      },
      accounts: { deviceCap: 5, deviceIdleDays: 60, ...accountConfig },
    },
    deviceStore: devices,
    accountStore: accounts,
    avatarStore: createAvatarStore({ dir: join(dir, 'avatars') }),
    tokenIssuer: createTokenIssuer({
      apiKey: 'devkey',
      apiSecret: 'a-secret-long-enough-for-hmac-signing',
      wsUrl: 'wss://sfu.example.com',
      roomName: 'zoia',
      roomService: { createRoom: async () => {} },
      logger,
    }),
    stage: createStage({ rooms, roomName: 'zoia', logger }),
    channels: channels?.(logger),
    logger,
  });
}

function stores({ maxPending = 20 } = {}) {
  db?.close();
  db = openDatabase(join(dir, `zoia-${maxPending}.db`));
  accounts = createAccountStore({ db, maxPending, logger: quiet() });
  devices = createDeviceStore({ db, logger: quiet() });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-accounts-'));
  stores();
  app = buildApp();
});

afterEach(async () => {
  await db.idle();
  db.close();
  db = null;
  await rm(dir, { recursive: true, force: true });
});

const signup = (email, password = PASSWORD) =>
  request(app).post('/api/signup').send({ email, password });

/** Logs in on a fresh machine; the agent carries the session cookie. */
async function login(email, password = PASSWORD, deviceName = 'Laptop') {
  const agent = request.agent(app);
  const res = await agent.post('/api/login').send({ email, password, deviceName });
  return { agent, res, id: res.body.deviceId, credential: res.body.deviceCredential };
}

/** An approved account with this role, signed in on one machine. */
async function person(email, role = 'user') {
  assert.equal((await signup(email)).status, 201);
  const account = (await accounts.list()).find((a) => a.email === normalizeEmail(email));
  await accounts.approve(account.id, 'test');
  if (role === 'admin') await accounts.setRole(account.id, 'admin', 'test');
  if (role === 'super_admin') await accounts.setSuper(email);
  return { account, ...(await login(email)) };
}

describe('passwords people choose', () => {
  test('need six characters: an uppercase, a lowercase, a digit and a symbol', async () => {
    for (const [password, why] of [
      ['Ab1-x', 'too short'],
      ['abcde1-', 'no uppercase'],
      ['ABCDE1-', 'no lowercase'],
      ['Abcdef-', 'no digit'],
      ['Abcdef1', 'no symbol'],
    ]) {
      const res = await signup(`${why.replace(/ /g, '.')}@example.com`, password);
      assert.equal(res.body.error, 'weak_password', why);
    }
    assert.equal((await signup('ok@example.com', 'Ab1-xy')).status, 201);
    // Letters and digits beyond ASCII count as what they are.
    assert.equal((await signup('ok2@example.com', 'Ção-9x')).status, 201);
  });

  test('the same rule holds for a new password and a reset', async () => {
    const alice = await person('alice@example.com');
    const weak = await alice.agent
      .post('/api/password')
      .send({ currentPassword: PASSWORD, newPassword: 'alllowercase1!' });
    assert.equal(weak.body.error, 'weak_password');

    const { code } = await accounts.issueCode(alice.account.id);
    const reset = await request(app).post('/api/reset').send({ code, password: 'NoDigits!' });
    assert.equal(reset.body.error, 'weak_password');
  });
});

describe('signing up', () => {
  test('a new account waits for approval, named by the part before the @', async () => {
    const res = await signup('Diego.Silva@Example.com');
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'pending');

    const [account] = await accounts.list();
    assert.equal(account.email, 'diego.silva@example.com');
    assert.equal(account.name, 'diego.silva');
    assert.equal(account.role, 'user');
  });

  test('an email is taken however it is written', async () => {
    await signup('ana@example.com');
    const again = await signup('  ANA@Example.COM ');
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'email_taken');
  });

  test('a malformed email or a short password is refused', async () => {
    assert.equal((await signup('not-an-email')).body.error, 'invalid_email');
    assert.equal((await signup('a@example.com', 'x'.repeat(129))).body.error, 'weak_password');
    assert.equal((await request(app).post('/api/signup').send({})).status, 400);
    assert.equal((await accounts.list()).length, 0);
  });

  test('a name in use gets a number instead of refusing the sign-up', async () => {
    await signup('ana@example.com');
    await signup('ana@other.example');
    const names = (await accounts.list()).map((a) => a.name).sort();
    assert.deepEqual(names, ['ana', 'ana 2']);
  });

  test('sign-up closes while too many are waiting, and reopens once worked', async () => {
    stores({ maxPending: 2 });
    app = buildApp();
    await signup('a@example.com');
    await signup('b@example.com');
    const third = await signup('c@example.com');
    assert.equal(third.status, 503);
    assert.equal(third.body.error, 'signup_closed');

    const [first] = await accounts.list();
    await accounts.reject(first.id, 'test');
    assert.equal((await signup('c@example.com')).status, 201);
  });

  test('sign-ups from one address are limited, successful ones included', async () => {
    app = buildApp({ rateLimit: { signupLimit: 2 } });
    assert.equal((await signup('a@example.com')).status, 201);
    assert.equal((await signup('b@example.com')).status, 201);
    assert.equal((await signup('c@example.com')).status, 429);
  });

  test('the password is never stored, and the email never logged', async () => {
    await signup('secret.person@example.com');
    await login('secret.person@example.com');
    await login('secret.person@example.com', 'wrong password!');

    const onDisk = await databaseOnDisk(join(dir, 'zoia-20.db'));
    assert.ok(!onDisk.includes(PASSWORD), 'the raw password must not reach the store');
    const log = logLines.join('\n');
    assert.ok(!log.includes(PASSWORD), 'the password must not reach a log line');
    assert.ok(!log.includes('wrong password!'));
    assert.ok(!log.includes('secret.person'), 'the email must not reach a log line');
  });
});

describe('logging in', () => {
  test('a pending account is signed in, but goes nowhere until approved', async () => {
    await signup('new@example.com');
    const { agent, res } = await login('new@example.com');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'pending');

    assert.equal((await agent.get('/api/session')).body.status, 'pending');
    const token = await agent.post('/api/token').send({});
    assert.equal(token.status, 403);
    assert.equal(token.body.error, 'pending_approval');
    assert.equal((await agent.post('/api/stage/claim').send({})).status, 403);
    assert.equal((await agent.get('/api/rooms')).status, 403);
  });

  test('approval lets the same session in, with a subscribe-only token', async () => {
    await signup('new@example.com');
    const { agent } = await login('new@example.com');
    const [account] = await accounts.list();
    await accounts.approve(account.id, 'test');

    const session = await agent.get('/api/session');
    assert.equal(session.body.status, 'active');

    const token = await agent.post('/api/token').send({});
    assert.equal(token.status, 200);
    const payload = decodeTokenPayload(token.body.token);
    assert.equal(payload.name, 'new');
    assert.equal(payload.video.canPublish, false);
  });

  test('an unknown email and a wrong password get the same answer', async () => {
    await signup('real@example.com');
    const unknown = await login('nobody@example.com');
    const wrong = await login('real@example.com', 'not the password');
    assert.equal(unknown.res.status, 401);
    assert.deepEqual(unknown.res.body, wrong.res.body);
    assert.equal(wrong.res.body.error, 'invalid_login');
  });

  test('a device name is required, so the list of machines stays meaningful', async () => {
    await signup('real@example.com');
    assert.equal((await login('real@example.com', PASSWORD, '  ')).res.status, 400);
  });

  test('ten wrong passwords lock the account, even against the right one', async () => {
    await signup('target@example.com');
    for (let i = 0; i < 10; i += 1) await login('target@example.com', `guess number ${i}`);
    const right = await login('target@example.com');
    assert.equal(right.res.status, 429);
    assert.equal(right.res.body.error, 'too_many_attempts');
  });

  test('the credential from a login opens a session on the next launch', async () => {
    const alice = await person('alice@example.com');
    const next = request.agent(app);
    const res = await next.post('/api/device/session').send({ deviceCredential: alice.credential });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'alice');
    assert.equal(res.body.role, 'user');
    assert.equal((await next.post('/api/token').send({})).status, 200);
  });

  test('disabling someone cuts every machine of theirs off on its next request', async () => {
    const admin = await person('admin@example.com', 'admin');
    const bob = await person('bob@example.com');
    assert.equal((await bob.agent.post('/api/token').send({})).status, 200);

    const res = await admin.agent.post(`/api/admin/accounts/${bob.account.id}/disable`);
    assert.equal(res.status, 200);
    assert.equal((await bob.agent.post('/api/token').send({})).status, 401);
    const relaunch = await request(app)
      .post('/api/device/session')
      .send({ deviceCredential: bob.credential });
    assert.equal(relaunch.status, 403);
    assert.equal((await login('bob@example.com')).res.body.error, 'account_disabled');

    await admin.agent.post(`/api/admin/accounts/${bob.account.id}/enable`);
    assert.equal((await login('bob@example.com')).res.status, 200);
  });
});

describe('the machines of an account', () => {
  test('one too many replaces the one used least recently, not refuses', async () => {
    app = buildApp({ accounts: { deviceCap: 2 } });
    const first = await person('caio@example.com');
    const second = await login('caio@example.com', PASSWORD, 'Desktop');
    // The first machine is in use; the second has sat idle since login.
    await devices.touch(first.id);
    await devices.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await devices.touch(first.id);
    await devices.idle();

    const third = await login('caio@example.com', PASSWORD, 'Tablet');
    assert.equal(third.res.status, 200);
    const live = (await devices.listByAccount(first.account.id)).map((d) => d.id).sort();
    assert.deepEqual(live, [first.id, third.id].sort());
    assert.equal((await second.agent.post('/api/token').send({})).status, 401);
  });

  test('a machine left unused past the idle period stops counting', async () => {
    app = buildApp({ accounts: { deviceIdleDays: 0 } });
    const alice = await person('alice@example.com');
    const res = await request(app)
      .post('/api/device/session')
      .send({ deviceCredential: alice.credential });
    assert.equal(res.status, 401);
  });

  test('the name and the picture are the person, on every machine', async () => {
    const alice = await person('alice@example.com');
    const other = await login('alice@example.com', PASSWORD, 'Desktop');

    assert.equal((await alice.agent.post('/api/name').send({ name: 'Alice' })).status, 200);
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(16),
    ]);
    const upload = await alice.agent
      .put('/api/avatar')
      .set('content-type', 'image/webp')
      .send(webp);
    assert.equal(upload.status, 200);

    const token = decodeTokenPayload((await other.agent.post('/api/token').send({})).body.token);
    assert.equal(token.name, 'Alice');
    assert.equal(token.attributes?.[AVATAR_ATTRIBUTE], upload.body.avatar);
    // Fetched by either machine's identity, since both are her.
    assert.equal((await other.agent.get(`/api/avatar/${alice.id}`)).status, 200);
    assert.equal((await alice.agent.get(`/api/avatar/${other.id}`)).status, 200);
  });

  test('a name is unique, however it is written, but your own recased is yours', async () => {
    const alice = await person('alice@example.com');
    await person('bob@example.com');
    assert.equal((await alice.agent.post('/api/name').send({ name: 'BOB' })).status, 409);
    assert.equal((await alice.agent.post('/api/name').send({ name: 'bób' })).status, 409);
    assert.equal((await alice.agent.post('/api/name').send({ name: 'ALICE' })).status, 200);
  });

  test('an empty or absurdly long name is refused', async () => {
    const alice = await person('alice@example.com');
    assert.equal((await alice.agent.post('/api/name').send({ name: '  ' })).status, 400);
    assert.equal((await alice.agent.post('/api/name').send({ name: 'x'.repeat(33) })).status, 400);
    assert.equal((await request(app).post('/api/name').send({ name: 'X' })).status, 401);
  });

  test('you can see your machines and sign one out, but only your own', async () => {
    const alice = await person('alice@example.com');
    const laptop = await login('alice@example.com', PASSWORD, 'Desktop');
    const bob = await person('bob@example.com');

    const list = await alice.agent.get('/api/devices');
    assert.equal(list.body.devices.length, 2);
    assert.equal(list.body.devices.find((d) => d.current).id, alice.id);

    assert.equal((await bob.agent.delete(`/api/devices/${laptop.id}`)).status, 404);
    assert.equal((await alice.agent.delete(`/api/devices/${laptop.id}`)).status, 200);
    assert.equal((await laptop.agent.post('/api/token').send({})).status, 401);
  });
});

describe('signing out', () => {
  test('forgets this machine, pending or not, and frees its seat', async () => {
    await signup('new@example.com');
    const pending = await login('new@example.com');
    assert.equal((await pending.agent.post('/api/device/forget')).status, 200);
    const relaunch = await request(app)
      .post('/api/device/session')
      .send({ deviceCredential: pending.credential });
    assert.equal(relaunch.status, 401);
    assert.equal((await pending.agent.get('/api/session')).status, 401);
  });

  test('needs a session', async () => {
    assert.equal((await request(app).post('/api/device/forget')).status, 401);
  });
});

describe('passwords and codes', () => {
  test('changing the password needs the current one and signs out the other machines', async () => {
    const alice = await person('alice@example.com');
    const other = await login('alice@example.com', PASSWORD, 'Desktop');

    const wrong = await alice.agent
      .post('/api/password')
      .send({ currentPassword: 'not it at all', newPassword: 'Brand-new-pass-1' });
    assert.equal(wrong.status, 401);

    const res = await alice.agent
      .post('/api/password')
      .send({ currentPassword: PASSWORD, newPassword: 'Brand-new-pass-1' });
    assert.equal(res.status, 200);
    assert.equal(res.body.signedOut, 1);
    assert.equal((await alice.agent.post('/api/token').send({})).status, 200);
    assert.equal((await other.agent.post('/api/token').send({})).status, 401);
    assert.equal((await login('alice@example.com', 'Brand-new-pass-1')).res.status, 200);
  });

  test('a reset code sets a new password once and signs every machine out', async () => {
    const admin = await person('admin@example.com', 'admin');
    const bob = await person('bob@example.com');

    const issued = await admin.agent.post(`/api/admin/accounts/${bob.account.id}/reset`);
    assert.equal(issued.status, 200);
    assert.match(issued.body.code, /^zcode_[0-9a-f]{8}_/);
    assert.ok(!logLines.join('\n').includes(issued.body.code.split('_')[2]));

    const reset = { code: issued.body.code, password: 'My-new-pass-1' };
    assert.equal((await request(app).post('/api/reset').send(reset)).status, 200);
    assert.equal((await bob.agent.post('/api/token').send({})).status, 401);
    assert.equal((await login('bob@example.com', 'My-new-pass-1')).res.status, 200);
    // Spent.
    assert.equal((await request(app).post('/api/reset').send(reset)).status, 401);
  });

  test('a wrong or expired code is refused', async () => {
    const bob = await person('bob@example.com');
    const forged = `zcode_${bob.account.id}_${'x'.repeat(43)}`;
    const res = await request(app)
      .post('/api/reset')
      .send({ code: forged, password: 'My-new-pass-1' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_code');

    const issued = await accounts.issueCode(bob.account.id, { ttlMs: -1 });
    const expired = await request(app)
      .post('/api/reset')
      .send({ code: issued.code, password: 'My-new-pass-1' });
    assert.equal(expired.status, 401);
  });
});

describe('pictures', () => {
  const WEBP = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('WEBPVP8 '),
    Buffer.alloc(16),
  ]);
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(16),
  ]);
  const upload = (agent, bytes, type = 'image/webp') =>
    agent.put('/api/avatar').set('content-type', type).send(bytes);

  test('the type is judged by the bytes, not by what the client says', async () => {
    const alice = await person('alice@example.com');
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    assert.equal((await upload(alice.agent, html, 'image/png')).status, 400);

    assert.equal((await upload(alice.agent, PNG, 'image/webp')).status, 200);
    const fetched = await alice.agent.get(`/api/avatar/${alice.id}`);
    assert.equal(fetched.headers['content-type'], 'image/png');
    assert.equal(fetched.headers['x-content-type-options'], 'nosniff');
  });

  test('an oversized picture is refused as too large, not as a server error', async () => {
    const alice = await person('alice@example.com');
    const huge = Buffer.concat([WEBP, Buffer.alloc(AVATAR_MAX_BYTES)]);
    const res = await upload(alice.agent, huge);
    assert.equal(res.status, 413);
    assert.equal(res.body.error, 'avatar_too_large');
  });

  test('removing the picture takes it away for everyone', async () => {
    const alice = await person('alice@example.com');
    const bob = await person('bob@example.com');
    await upload(alice.agent, WEBP);

    assert.equal((await alice.agent.delete('/api/avatar')).status, 200);
    assert.equal((await bob.agent.get(`/api/avatar/${alice.id}`)).status, 404);
    assert.equal((await alice.agent.get('/api/session')).body.avatar, null);
  });

  test('an id that is not a device id never reaches the filesystem', async () => {
    const alice = await person('alice@example.com');
    for (const id of ['..%2Fzoia.db', '..', 'ABCDEF12', '1234567', 'deadbeef']) {
      assert.equal((await alice.agent.get(`/api/avatar/${id}`)).status, 404, id);
    }
  });

  test('setting, removing and fetching all require a session', async () => {
    assert.equal((await upload(request(app), WEBP)).status, 401);
    assert.equal((await request(app).delete('/api/avatar')).status, 401);
    assert.equal((await request(app).get('/api/avatar/deadbeef')).status, 401);
  });
});

describe('administration', () => {
  test('a user reaches no admin route', async () => {
    const bob = await person('bob@example.com');
    const carol = await person('carol@example.com');
    assert.equal((await bob.agent.get('/api/admin/accounts')).status, 403);
    for (const action of ['approve', 'reject', 'disable', 'enable', 'reset', 'role']) {
      const res = await bob.agent.post(`/api/admin/accounts/${carol.account.id}/${action}`);
      assert.equal(res.status, 403, action);
    }
    assert.equal((await bob.agent.get('/api/session')).body.pendingApprovals, undefined);
  });

  test('an admin sees what is waiting, and approves or rejects it', async () => {
    const admin = await person('admin@example.com', 'admin');
    await signup('one@example.com');
    await signup('two@example.com');
    assert.equal((await admin.agent.get('/api/session')).body.pendingApprovals, 2);

    const list = (await admin.agent.get('/api/admin/accounts')).body.accounts;
    const one = list.find((a) => a.email === 'one@example.com');
    const two = list.find((a) => a.email === 'two@example.com');
    assert.equal(one.status, 'pending');
    assert.ok(!('hash' in one) && !('salt' in one));

    assert.equal((await admin.agent.post(`/api/admin/accounts/${one.id}/approve`)).status, 200);
    assert.equal((await admin.agent.post(`/api/admin/accounts/${two.id}/reject`)).status, 200);
    assert.equal((await admin.agent.get('/api/session')).body.pendingApprovals, 0);
    // Rejected is gone, so the email is free again.
    assert.equal((await signup('two@example.com')).status, 201);
    // Only pending accounts are approved or rejected.
    assert.equal((await admin.agent.post(`/api/admin/accounts/${one.id}/reject`)).status, 409);
  });

  test('an admin manages users, but not other admins or the super admin', async () => {
    const owner = await person('owner@example.com', 'super_admin');
    const admin = await person('admin@example.com', 'admin');
    const other = await person('other@example.com', 'admin');
    const bob = await person('bob@example.com');

    const act = (who, target, action) =>
      who.agent.post(`/api/admin/accounts/${target.account.id}/${action}`);

    assert.equal((await act(admin, bob, 'reset')).status, 200);
    assert.equal((await act(admin, other, 'disable')).status, 403);
    assert.equal((await act(admin, other, 'reset')).status, 403);
    assert.equal((await act(admin, owner, 'disable')).status, 403);
    assert.equal((await act(admin, owner, 'reset')).status, 403);
    // The super admin manages admins, and nobody manages the super admin.
    assert.equal((await act(owner, other, 'disable')).status, 200);
    assert.equal((await act(owner, owner, 'disable')).status, 403);
  });

  test('only the super admin makes admins, and never another super admin', async () => {
    const owner = await person('owner@example.com', 'super_admin');
    const admin = await person('admin@example.com', 'admin');
    const bob = await person('bob@example.com');
    const role = (who, target, value) =>
      who.agent.post(`/api/admin/accounts/${target.account.id}/role`).send({ role: value });

    assert.equal((await role(admin, bob, 'admin')).status, 403);
    assert.equal((await role(owner, bob, 'super_admin')).status, 400);
    assert.equal((await role(owner, owner, 'user')).status, 403);
    assert.equal((await role(owner, bob, 'admin')).status, 200);
    assert.equal((await bob.agent.get('/api/admin/accounts')).status, 200);
    assert.equal((await role(owner, bob, 'user')).status, 200);
    // Read from the store on every request, so a demotion is immediate.
    assert.equal((await bob.agent.get('/api/admin/accounts')).status, 403);
  });

  test('the channel list tells you your own role, as it stands now', async () => {
    const owner = await person('owner@example.com', 'super_admin');
    const bob = await person('bob@example.com');
    assert.deepEqual((await bob.agent.get('/api/rooms')).body.you, { role: 'user' });

    await owner.agent.post(`/api/admin/accounts/${bob.account.id}/role`).send({ role: 'admin' });
    await signup('waiting@example.com');
    assert.deepEqual((await bob.agent.get('/api/rooms')).body.you, {
      role: 'admin',
      pendingApprovals: 1,
    });
  });

  test('there is only ever one super admin', async () => {
    await person('first@example.com', 'super_admin');
    const second = await person('second@example.com');
    const result = await accounts.setSuper('second@example.com');
    assert.equal(result.ok, true);
    const roles = Object.fromEntries((await accounts.list()).map((a) => [a.email, a.role]));
    assert.deepEqual(roles, { 'first@example.com': 'admin', 'second@example.com': 'super_admin' });
    assert.equal((await second.agent.get('/api/session')).body.role, 'super_admin');
  });

  test('nothing a client sends makes it more than it is', async () => {
    // What a modified app could send: extra fields on every request it is
    // allowed to make. None of them is ever read as a role or a status.
    const signed = await request(app).post('/api/signup').send({
      email: 'sneaky@example.com',
      password: PASSWORD,
      role: 'super_admin',
      status: 'active',
    });
    assert.equal(signed.status, 201);
    const sneaky = (await accounts.list()).find((a) => a.email === 'sneaky@example.com');
    assert.equal(sneaky.role, 'user');
    assert.equal(sneaky.status, 'pending');

    const pending = await login('sneaky@example.com');
    assert.equal(pending.res.body.status, 'pending');
    assert.equal((await pending.agent.post('/api/token').send({ role: 'admin' })).status, 403);
    assert.equal((await pending.agent.get('/api/admin/accounts')).status, 403);
    assert.equal(
      (await pending.agent.post(`/api/admin/accounts/${sneaky.id}/approve`)).status,
      403,
      'a pending account cannot approve itself',
    );

    const bob = await person('bob@example.com');
    await bob.agent.post('/api/name').send({ name: 'Bob', role: 'super_admin' });
    await bob.agent.post('/api/password').send({
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
      role: 'admin',
    });
    assert.equal((await accounts.get(bob.account.id)).role, 'user');
    assert.equal((await bob.agent.get('/api/session')).body.role, 'user');
    for (const path of ['approve', 'reset', 'role', 'disable']) {
      const res = await bob.agent
        .post(`/api/admin/accounts/${sneaky.id}/${path}`)
        .send({ role: 'admin' });
      assert.equal(res.status, 403, path);
    }
    assert.equal((await accounts.get(sneaky.id)).status, 'pending');
  });

  test('an admin cannot make anyone super admin, themselves included', async () => {
    await person('owner@example.com', 'super_admin');
    const admin = await person('admin@example.com', 'admin');
    const res = await admin.agent
      .post(`/api/admin/accounts/${admin.account.id}/role`)
      .send({ role: 'super_admin' });
    assert.equal(res.status, 403);
    assert.equal((await accounts.get(admin.account.id)).role, 'admin');
  });

  test('crash reports are for admins: they name other people’s machines', async () => {
    const admin = await person('admin@example.com', 'admin');
    const bob = await person('bob@example.com');
    assert.equal((await bob.agent.get('/api/reports')).status, 403);
    assert.notEqual((await admin.agent.get('/api/reports')).status, 403);
  });

  test('canManage keeps the rules in one place', () => {
    const user = { id: 'u', role: 'user' };
    const admin = { id: 'a', role: 'admin' };
    const owner = { id: 's', role: 'super_admin' };
    assert.equal(canManage(admin, user), true);
    assert.equal(canManage(user, user), false);
    assert.equal(canManage(admin, { ...admin, id: 'b' }), false);
    assert.equal(canManage(owner, admin), true);
    assert.equal(canManage(owner, owner), false);
    assert.equal(canManage(admin, admin), false);
  });
});

describe('password hashing', () => {
  test('passwords use the stronger setting, so the stored hash is not a secret hash', async () => {
    const { hashSecret, PASSWORD_SCRYPT, SECRET_SCRYPT } = await import('../src/store.js');
    await signup('a@example.com');
    const [stored] = db.sqlite.prepare('SELECT salt, hash FROM accounts').all();
    assert.equal(stored.hash, await hashSecret(PASSWORD, stored.salt, PASSWORD_SCRYPT));
    assert.notEqual(stored.hash, await hashSecret(PASSWORD, stored.salt, SECRET_SCRYPT));
  });
});

describe('access ending ends the connection too', () => {
  /** Puts these machines in the room, as having joined with their tokens. */
  const join = (...ids) => {
    for (const identity of ids) {
      rooms.participants.push({ identity, name: identity, permission: {}, tracks: [] });
    }
  };
  const inRoom = () => rooms.participants.map((p) => p.identity).sort();

  test('a disabled person is taken out of the room at once, every machine', async () => {
    const admin = await person('admin@example.com', 'admin');
    const bob = await person('bob@example.com');
    const laptop = await login('bob@example.com', PASSWORD, 'Laptop');
    join(admin.id, bob.id, laptop.id);

    await admin.agent.post(`/api/admin/accounts/${bob.account.id}/disable`);
    assert.deepEqual(inRoom(), [admin.id]);
  });

  test('changing a password takes the other machines out, not this one', async () => {
    const alice = await person('alice@example.com');
    const other = await login('alice@example.com', PASSWORD, 'Desktop');
    join(alice.id, other.id);

    await alice.agent
      .post('/api/password')
      .send({ currentPassword: PASSWORD, newPassword: 'Brand-new-1' });
    assert.deepEqual(inRoom(), [alice.id]);
  });

  test('a machine signed out from another, or replaced at the limit, leaves too', async () => {
    app = buildApp({ accounts: { deviceCap: 2 } });
    const alice = await person('alice@example.com');
    const desktop = await login('alice@example.com', PASSWORD, 'Desktop');
    join(alice.id, desktop.id);

    await alice.agent.delete(`/api/devices/${desktop.id}`);
    assert.deepEqual(inRoom(), [alice.id]);

    // Two machines is the cap, and the first is the least recently used: a
    // third login replaces it, and it leaves the room with it.
    await login('alice@example.com', PASSWORD, 'Tablet');
    assert.equal((await login('alice@example.com', PASSWORD, 'Phone')).res.status, 200);
    assert.equal(await devices.getActive(alice.id), null);
    assert.deepEqual(inRoom(), []);
  });
});

describe('admins move people between channels', () => {
  /** Two channels, each its own fake room that records what the server sent. */
  let lobby;
  let lounge;
  const fakeRoom = () => {
    const room = {
      participants: [],
      sent: [],
      removed: [],
      listParticipants: async () => room.participants,
      updateParticipant: async () => {},
      removeParticipant: async (_name, identity) => {
        room.removed.push(identity);
        room.participants = room.participants.filter((p) => p.identity !== identity);
      },
      sendData: async (_name, data, _kind, options) => {
        room.sent.push({
          to: options.destinationIdentities,
          topic: options.topic,
          message: JSON.parse(new TextDecoder().decode(data)),
        });
      },
    };
    return room;
  };
  const enter = (room, ...ids) => {
    for (const identity of ids) {
      room.participants.push({ identity, name: identity, permission: {}, tracks: [] });
    }
  };

  beforeEach(() => {
    lobby = fakeRoom();
    lounge = fakeRoom();
    app = buildApp({
      channels: (logger) =>
        fixedChannels([
          {
            id: 'zoia',
            name: 'Lobby',
            stage: createStage({ rooms: lobby, roomName: 'zoia', logger }),
          },
          {
            id: 'lounge',
            name: 'Lounge',
            stage: createStage({ rooms: lounge, roomName: 'lounge', logger }),
          },
        ]),
    });
  });

  test('the list says how to show each picture', async () => {
    const admin = await person('admin@example.com', 'admin');
    const bob = await person('bob@example.com');

    const list = (await admin.agent.get('/api/admin/accounts')).body.accounts;
    assert.equal(list.find((a) => a.id === bob.account.id).avatarIdentity, bob.id);
  });

  test('the machine dragged is told to switch, by the server', async () => {
    const admin = await person('admin@example.com', 'admin');
    const bob = await person('bob@example.com');
    const laptop = await login('bob@example.com', PASSWORD, 'Laptop');
    enter(lobby, bob.id);
    enter(lounge, laptop.id);
    const move = (id, channel) =>
      admin.agent.post(`/api/admin/devices/${id}/move`).send({ channel });

    const res = await move(bob.id, 'lounge');
    assert.equal(res.status, 200);
    assert.equal(res.body.moved, true);
    assert.deepEqual(lobby.sent, [
      { to: [bob.id], topic: 'zoia.move', message: { channel: 'lounge' } },
    ]);
    // Already there: nothing to send.
    assert.equal((await move(laptop.id, 'lounge')).body.moved, false);
    assert.deepEqual(lounge.sent, []);
  });

  test('moving follows the same rules as the rest of administration', async () => {
    const owner = await person('owner@example.com', 'super_admin');
    const admin = await person('admin@example.com', 'admin');
    const other = await person('other@example.com', 'admin');
    const bob = await person('bob@example.com');
    enter(lobby, owner.id, other.id, bob.id);
    const move = (who, target, channel = 'lounge') =>
      who.agent.post(`/api/admin/devices/${target.id}/move`).send({ channel });

    assert.equal((await move(bob, other)).status, 403);
    assert.equal((await move(admin, other)).status, 403);
    assert.equal((await move(admin, owner)).status, 403);
    assert.equal((await move(owner, other)).status, 200);
    assert.equal((await move(admin, bob, 'nowhere')).status, 404);
    // Nobody to move: not in any channel, or no such machine.
    const carol = await person('carol@example.com');
    assert.equal((await move(admin, carol)).status, 409);
    assert.equal((await move(admin, { id: 'nope' })).status, 404);
  });

  test('a machine disconnected leaves its channel, broadcast and all, by the server', async () => {
    const admin = await person('admin@example.com', 'admin');
    const bob = await person('bob@example.com');
    const laptop = await login('bob@example.com', PASSWORD, 'Laptop');
    enter(lounge, bob.id, `${bob.id}-gpu`);
    enter(lobby, laptop.id);

    const res = await admin.agent.post(`/api/admin/devices/${bob.id}/disconnect`);
    assert.equal(res.status, 200);
    assert.equal(res.body.disconnected, true);
    // That machine and its hardware broadcast, in its own channel only.
    assert.deepEqual(lounge.removed, [bob.id, `${bob.id}-gpu`]);
    assert.deepEqual(lobby.removed, []);
    assert.deepEqual(
      lobby.participants.map((p) => p.identity),
      [laptop.id],
    );
    // Gone already: nothing left to disconnect.
    const again = await admin.agent.post(`/api/admin/devices/${bob.id}/disconnect`);
    assert.equal(again.status, 409);
  });

  test('disconnecting follows the same rules as the rest of administration', async () => {
    const owner = await person('owner@example.com', 'super_admin');
    const admin = await person('admin@example.com', 'admin');
    const other = await person('other@example.com', 'admin');
    const bob = await person('bob@example.com');
    const carol = await person('carol@example.com');
    enter(lobby, owner.id, admin.id, other.id, bob.id, carol.id);
    const kick = (who, target) => who.agent.post(`/api/admin/devices/${target.id}/disconnect`);

    assert.equal((await kick(bob, carol)).status, 403);
    assert.equal((await kick(admin, other)).status, 403);
    assert.equal((await kick(admin, owner)).status, 403);
    assert.equal((await kick(other, admin)).status, 403);
    assert.equal((await kick(admin, admin)).status, 403);
    assert.equal((await kick(admin, bob)).status, 200);
    assert.equal((await kick(owner, other)).status, 200);
    assert.equal((await kick(admin, { id: 'nope' })).status, 404);
    assert.deepEqual(
      lobby.removed.filter((id) => !id.endsWith('-gpu')),
      [bob.id, other.id],
    );
  });
});
