/**
 * Who is on the server, and how (ADR 0038): online, busy, away or offline,
 * as everyone else sees each person.
 *
 * Being there at all is having the app open: each signed-in app holds the
 * chat's live stream (/api/chats/events), and an account with at least one
 * open is connected. What the person chose for themselves is on their
 * account; invisible is shown to others as offline. Someone online whose
 * every machine says it has gone untouched for a while (the app reports it,
 * from the system's own idle time) is shown as away.
 *
 * All of it is in memory, in this one process, like the streams it counts.
 */

/**
 * How long an account stays shown after its last stream closes. A stream
 * dropped by the network comes back within seconds, and must not make the
 * person blink offline and online again for everyone.
 */
export const OFFLINE_GRACE_MS = 15_000;

/** What others see: the chosen status, less invisible, plus offline. */
export const SHOWN = ['online', 'busy', 'away', 'offline'];

/**
 * @param {object} options
 * @param {(id: string) => Promise<{ presence?: string | null } | null>} options.chosen
 *   what the account chose, read from the account store
 * @param {(event: string, data: object) => void} options.publish
 *   tells everyone listening, on the chat's stream
 */
export function createPresence({
  chosen,
  publish,
  offlineGraceMs = OFFLINE_GRACE_MS,
  logger = console,
}) {
  // By account: each open stream's machine, with how many it has open there,
  // and the machines that say they are idle.
  const accounts = new Map();
  // What everyone was last told, by account; an account not here is offline.
  const shown = new Map();

  const entry = (accountId) => {
    let found = accounts.get(accountId);
    if (!found) {
      found = { streams: new Map(), idle: new Set(), leaving: null };
      accounts.set(accountId, found);
    }
    return found;
  };

  // One account's refreshes run in order, so a slow read cannot announce an
  // older status after a newer one.
  const queues = new Map();

  /** How the account is shown now. */
  async function compute(accountId) {
    const found = accounts.get(accountId);
    if (!found) return 'offline';
    // Waiting to see whether the last stream comes back: as it was.
    if (found.streams.size === 0) return shown.get(accountId) ?? 'offline';
    const choice = (await chosen(accountId))?.presence ?? 'online';
    if (choice === 'invisible') return 'offline';
    if (choice !== 'online') return choice;
    const idle = [...found.streams.keys()].every((device) => found.idle.has(device));
    return idle ? 'away' : 'online';
  }

  /** Works out the account's status again, and tells everyone if it changed. */
  function refresh(accountId) {
    const run = (queues.get(accountId) ?? Promise.resolve()).then(async () => {
      const status = await compute(accountId).catch((err) => {
        logger.warn(`[presence] ${accountId} not refreshed: ${err.message}`);
        return null;
      });
      if (status === null || (shown.get(accountId) ?? 'offline') === status) return;
      if (status === 'offline') shown.delete(accountId);
      else shown.set(accountId, status);
      publish('presence', { accountId, status });
    });
    queues.set(accountId, run);
    void run.then(() => {
      if (queues.get(accountId) === run) queues.delete(accountId);
    });
    return run;
  }

  return {
    /**
     * A stream opened, for `deviceId` of `accountId`. Returns what to call
     * when it closes.
     */
    connect(accountId, deviceId) {
      const found = entry(accountId);
      if (found.leaving) clearTimeout(found.leaving);
      found.leaving = null;
      found.streams.set(deviceId, (found.streams.get(deviceId) ?? 0) + 1);
      void refresh(accountId);

      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        const left = (found.streams.get(deviceId) ?? 1) - 1;
        if (left > 0) return void found.streams.set(deviceId, left);
        found.streams.delete(deviceId);
        found.idle.delete(deviceId);
        if (found.streams.size > 0) return void refresh(accountId);

        // The last one: give it a moment to come back before saying so.
        if (found.leaving) clearTimeout(found.leaving);
        found.leaving = setTimeout(() => {
          found.leaving = null;
          if (found.streams.size === 0) accounts.delete(accountId);
          void refresh(accountId);
        }, offlineGraceMs);
        found.leaving.unref?.();
      };
    },

    /** Whether the machine has gone untouched; only counts while it is connected. */
    setIdle(accountId, deviceId, idle) {
      const found = accounts.get(accountId);
      if (!found?.streams.has(deviceId)) return;
      if (idle === found.idle.has(deviceId)) return;
      if (idle) found.idle.add(deviceId);
      else found.idle.delete(deviceId);
      void refresh(accountId);
    },

    /** The account chose another status; see accounts.setPresence. */
    changed: (accountId) => refresh(accountId),

    /** Everyone not offline, as { accountId: status }. */
    snapshot() {
      return Object.fromEntries(shown);
    },

    /** Resolves once every refresh already started has settled; for tests. */
    async idle() {
      await Promise.all(queues.values());
    },

    /** Stops every timer, for shutdown and tests. */
    close() {
      for (const found of accounts.values()) if (found.leaving) clearTimeout(found.leaving);
    },
  };
}
