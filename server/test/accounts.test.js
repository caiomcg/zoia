/**
 * Accounts, ADR 0031. Sign-up is open to anyone who knows the host, so most of
 * what is worth testing is what it does *not* let through: a pending account
 * reaching the room, an admin reaching further than their role, a password or
 * a code reaching the disk or the log.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { createKeyStore } from '../src/keys.js';
import { createPairingStore } from '../src/pairings.js';
import { createDeviceStore } from '../src/devices.js';
import { createAccountStore, canManage, normalizeEmail } from '../src/accounts.js';
import { createTokenIssuer, decodeTokenPayload } from '../src/token.js';
import { createStage } from '../src/stage.js';
import { AVATAR_ATTRIBUTE, createAvatarStore } from '../src/avatars.js';

const PASSWORD = 'correct horse battery';

let dir;
let accounts;
let devices;
let pairings;
let app;
let logLines;

const quiet = () => {
  logLines = [];
  const capture = (line) => logLines.push(String(line));
  return { info: capture, warn: capture, error: capture };
};

function buildApp({ accounts: accountConfig, rateLimit } = {}) {
  const logger = quiet();
  const rooms = {
    participants: [],
    listParticipants: async () => rooms.participants,
    updateParticipant: async () => {},
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
        pairLimit: 1000,
        signupLimit: 1000,
        ...rateLimit,
      },
      accounts: { deviceCap: 5, deviceIdleDays: 60, ...accountConfig },
    },
    keyStore: createKeyStore({ file: join(dir, 'keys.json') }),
    pairingStore: pairings,
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
    logger,
  });
}

function stores({ maxPending = 20 } = {}) {
  accounts = createAccountStore({ file: join(dir, 'accounts.json'), maxPending, logger: quiet() });
  devices = createDeviceStore({ file: join(dir, 'devices.json'), logger: quiet() });
  pairings = createPairingStore({ file: join(dir, 'pairings.json'), logger: quiet() });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zoia-accounts-'));
  stores();
  app = buildApp();
});

afterEach(async () => {
  await Promise.all([accounts.idle(), devices.idle(), pairings.idle()]);
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
    assert.equal((await signup('a@example.com', 'short')).body.error, 'weak_password');
    assert.equal((await signup('a@example.com', 'x'.repeat(129))).body.error, 'weak_password');
    assert.equal((await request(app).post('/api/signup').send({})).status, 400);
    assert.equal((await accounts.list()).length, 0);
  });

  test('a name in use gets a number, against accounts and older devices alike', async () => {
    const { raw } = await pairings.add({ name: 'build' });
    await request(app).post('/api/pair').send({ pairingToken: raw, deviceName: 'ana' });

    await signup('ana@example.com');
    await signup('ana@other.example');
    const names = (await accounts.list()).map((a) => a.name).sort();
    assert.deepEqual(names, ['ana 2', 'ana 3']);
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

    const onDisk = await readFile(join(dir, 'accounts.json'), 'utf8');
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
    assert.equal(session.body.needsClaim, false);

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

  test('a name is unique across accounts and devices from before accounts', async () => {
    const alice = await person('alice@example.com');
    await person('bob@example.com');
    const { raw } = await pairings.add({ name: 'build' });
    const old = request.agent(app);
    const paired = await old.post('/api/pair').send({ pairingToken: raw, deviceName: 'Carol' });
    await old.post('/api/device/session').send({ deviceCredential: paired.body.deviceCredential });

    assert.equal((await alice.agent.post('/api/name').send({ name: 'BOB' })).status, 409);
    assert.equal((await alice.agent.post('/api/name').send({ name: 'carol' })).status, 409);
    assert.equal((await old.post('/api/name').send({ name: 'Alice' })).status, 409);
    assert.equal((await alice.agent.post('/api/name').send({ name: 'Alice' })).status, 200);
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

describe('passwords and codes', () => {
  test('changing the password needs the current one and signs out the other machines', async () => {
    const alice = await person('alice@example.com');
    const other = await login('alice@example.com', PASSWORD, 'Desktop');

    const wrong = await alice.agent
      .post('/api/password')
      .send({ currentPassword: 'not it at all', newPassword: 'a brand new password' });
    assert.equal(wrong.status, 401);

    const res = await alice.agent
      .post('/api/password')
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new password' });
    assert.equal(res.status, 200);
    assert.equal(res.body.signedOut, 1);
    assert.equal((await alice.agent.post('/api/token').send({})).status, 200);
    assert.equal((await other.agent.post('/api/token').send({})).status, 401);
    assert.equal((await login('alice@example.com', 'a brand new password')).res.status, 200);
  });

  test('a reset code sets a new password once and signs every machine out', async () => {
    const admin = await person('admin@example.com', 'admin');
    const bob = await person('bob@example.com');

    const issued = await admin.agent.post(`/api/admin/accounts/${bob.account.id}/reset`);
    assert.equal(issued.status, 200);
    assert.equal(issued.body.kind, 'reset');
    assert.match(issued.body.code, /^zcode_[0-9a-f]{8}_/);
    assert.ok(!logLines.join('\n').includes(issued.body.code.split('_')[2]));

    const reset = { code: issued.body.code, password: 'my new password' };
    assert.equal((await request(app).post('/api/reset').send(reset)).status, 200);
    assert.equal((await bob.agent.post('/api/token').send({})).status, 401);
    assert.equal((await login('bob@example.com', 'my new password')).res.status, 200);
    // Spent.
    assert.equal((await request(app).post('/api/reset').send(reset)).status, 401);
  });

  test('a wrong or expired code is refused', async () => {
    const bob = await person('bob@example.com');
    const forged = `zcode_${bob.account.id}_${'x'.repeat(43)}`;
    const res = await request(app)
      .post('/api/reset')
      .send({ code: forged, password: 'my new password' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_code');

    const issued = await accounts.issueCode(bob.account.id, 'reset', { ttlMs: -1 });
    const expired = await request(app)
      .post('/api/reset')
      .send({ code: issued.code, password: 'my new password' });
    assert.equal(expired.status, 401);
  });

  test('a claim code gives a migrated account an email, and its machines carry on', async () => {
    const account = await accounts.createClaimable({ name: 'Diego' });
    const { raw } = await pairings.add({ name: 'build' });
    const paired = await request(app)
      .post('/api/pair')
      .send({ pairingToken: raw, deviceName: 'Diego' });
    await devices.assignAccount([paired.body.deviceId], account.id, { idleMs: 60_000 });

    const old = request.agent(app);
    const session = await old
      .post('/api/device/session')
      .send({ deviceCredential: paired.body.deviceCredential });
    assert.equal(session.body.needsClaim, true);
    assert.equal(session.body.name, 'Diego');

    const { code } = await accounts.issueCode(account.id, 'claim');
    const claimed = await request(app)
      .post('/api/reset')
      .send({ code, email: 'Diego@Example.com', password: 'a password of his' });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.email, 'diego@example.com');

    assert.equal((await old.get('/api/session')).body.needsClaim, false);
    assert.equal((await old.post('/api/token').send({})).status, 200);
    assert.equal((await login('diego@example.com', 'a password of his')).res.status, 200);
  });

  test('a claim cannot take an email someone already has', async () => {
    await person('taken@example.com');
    const account = await accounts.createClaimable({ name: 'Diego' });
    const { code } = await accounts.issueCode(account.id, 'claim');
    const res = await request(app)
      .post('/api/reset')
      .send({ code, email: 'taken@example.com', password: 'a password of his' });
    assert.equal(res.status, 409);
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

  test('there is only ever one super admin', async () => {
    await person('first@example.com', 'super_admin');
    const second = await person('second@example.com');
    const result = await accounts.setSuper('second@example.com');
    assert.equal(result.ok, true);
    const roles = Object.fromEntries((await accounts.list()).map((a) => [a.email, a.role]));
    assert.deepEqual(roles, { 'first@example.com': 'admin', 'second@example.com': 'super_admin' });
    assert.equal((await second.agent.get('/api/session')).body.role, 'super_admin');
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
