/**
 * Signing people in, for tests about everything else. Each is a real account,
 * approved, with a real login through the app, so a test of the stage or the
 * channels runs on exactly the sessions the app runs on.
 */

import request from 'supertest';
import { openStores } from '../src/stores.js';

export const PASSWORD = 'Correct-horse-1';

const quiet = { info() {}, warn() {}, error() {} };

/** A fresh database in `dir`, with its stores. */
export function testStores(file, { maxPending, logger = quiet } = {}) {
  return openStores({ databaseFile: file, maxPending, logger });
}

/**
 * An approved account named `name`, signed in on one machine. `record` is the
 * machine — its id is the session's LiveKit identity — so a test can find
 * them in a room.
 */
export async function signIn(app, accounts, name, { role = 'user' } = {}) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${Math.random().toString(36).slice(2, 8)}@example.com`;
  const { account } = await accounts.signup({ email, password: PASSWORD });
  await accounts.approve(account.id, 'test');
  await accounts.rename(account.id, name);
  if (role === 'admin') await accounts.setRole(account.id, 'admin', 'test');
  if (role === 'super_admin') await accounts.setSuper(email);

  const agent = request.agent(app);
  const res = await agent.post('/api/login').send({ email, password: PASSWORD, deviceName: 'PC' });
  if (res.status !== 200) throw new Error(`could not sign ${name} in: ${res.status}`);
  return {
    agent,
    email,
    account,
    credential: res.body.deviceCredential,
    record: { id: res.body.deviceId, name },
  };
}
