/**
 * Opens the database and every store kept in it. The server and keytool both
 * start here, so they agree on where the data lives.
 */

import { openDatabase } from './database.js';
import { createDeviceStore } from './devices.js';
import { createAccountStore } from './accounts.js';
import { createChatStore } from './chats.js';
import { createAddonStore } from './addons.js';

/** Where the database lives, from the environment, as the server resolves it. */
export function storePaths(env = process.env) {
  return { databaseFile: env.DATABASE_FILE ?? 'server/data/zoia.db' };
}

export function openStores({ databaseFile, maxPending, defaultChatName, logger = console }) {
  const db = openDatabase(databaseFile);
  return {
    db,
    devices: createDeviceStore({ db, logger }),
    accounts: createAccountStore({ db, maxPending, logger }),
    chats: createChatStore({ db, defaultName: defaultChatName, logger }),
    addons: createAddonStore({ db, logger }),
  };
}
