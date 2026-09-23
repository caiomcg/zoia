/**
 * The stage: who is allowed to broadcast right now.
 *
 * Everyone joins with `canPublish: false`. Claiming the stage asks the server
 * to grant that permission, and LiveKit pushes the change to the client live —
 * no reconnect, no second token. Releasing revokes it again.
 *
 * Single-producer is enforced here and by LiveKit, not by the UI. A client that
 * skips the claim call still cannot publish, because its permission says so.
 *
 * State is derived from LiveKit's own participant list rather than tracked
 * separately, so a broadcaster who closes their laptop cannot leave the stage
 * locked behind them.
 */

const PUBLISH_PERMISSION = {
  canSubscribe: true,
  canPublish: true,
  canPublishData: true,
};

const VIEW_PERMISSION = {
  canSubscribe: true,
  canPublish: false,
  canPublishData: true,
};

/**
 * How long a holder may sit on the stage without publishing anything before
 * someone else may take it. Covers the window between claiming and choosing a
 * window in the browser's picker, and the case where a broadcaster's client
 * dies without releasing.
 */
const STALE_CLAIM_MS = 20_000;

export function createStage({ rooms, roomName, logger = console, now = () => Date.now() }) {
  // Claim times are a hint for the staleness check only. Losing them (a
  // restart) makes an idle holder look stale, which errs towards the stage
  // being available rather than stuck — the right way round.
  const claimedAt = new Map();

  async function listParticipants() {
    try {
      return await rooms.listParticipants(roomName);
    } catch (err) {
      // An empty room does not exist yet, which is not an error.
      if (/not found|does not exist/i.test(err?.message ?? '')) return [];
      throw err;
    }
  }

  /** The participant currently permitted to publish, if any. */
  async function holder() {
    const participants = await listParticipants();
    const found = participants.find((p) => p.permission?.canPublish);
    if (!found) return null;
    return {
      identity: found.identity,
      name: found.name || found.identity,
      publishing: (found.tracks ?? []).length > 0,
    };
  }

  async function setPermission(identity, permission) {
    await rooms.updateParticipant(roomName, identity, { permission });
  }

  return {
    holder,

    async participants() {
      const list = await listParticipants();
      return list.map((p) => ({
        identity: p.identity,
        name: p.name || p.identity,
        canPublish: Boolean(p.permission?.canPublish),
        publishing: (p.tracks ?? []).length > 0,
        joinedAt: Number(p.joinedAt ?? 0),
      }));
    },

    /**
     * Grants publish rights, if the stage is free. Returns the current holder
     * when it is not, so the caller can say who has it.
     *
     * `force` is the end of the takeover flow: the asker has already waited
     * out the grace period without the holder answering, which is what
     * happens when someone leaves a machine broadcasting and walks away. It
     * is not a privilege — anyone in the room may do it, and the holder is
     * told — so it cannot be used to gain rights nobody else has.
     */
    async claim(user, { force = false } = {}) {
      const current = await holder();

      if (current && current.identity !== user.id && force) {
        logger.info(`[stage] ${user.name} (${user.id}) took the stage from ${current.identity}`);
        await setPermission(current.identity, VIEW_PERMISSION).catch(() => {});
        claimedAt.delete(current.identity);
      } else if (current && current.identity !== user.id) {
        const since = claimedAt.get(current.identity);
        const stale =
          !current.publishing && (since === undefined || now() - since > STALE_CLAIM_MS);

        if (!stale) {
          return { ok: false, reason: 'busy', holder: current };
        }

        // The holder has permission but is publishing nothing and has had long
        // enough to start. Take it, so a crashed broadcaster cannot lock the
        // room for everyone else.
        logger.info(`[stage] taking the stage from idle holder ${current.identity}`);
        await setPermission(current.identity, VIEW_PERMISSION).catch(() => {});
        claimedAt.delete(current.identity);
      }

      await setPermission(user.id, PUBLISH_PERMISSION);
      claimedAt.set(user.id, now());
      logger.info(`[stage] ${user.name} (${user.id}) claimed the stage`);
      return { ok: true, holder: { identity: user.id, name: user.name } };
    },

    async release(user) {
      claimedAt.delete(user.id);

      let current = null;
      try {
        current = await holder();
      } catch {
        // If the room cannot be listed, still try to drop the permission
        // below rather than leaving the caller holding the stage.
      }

      // Releasing when you do not hold it is a no-op, not an error: it keeps
      // client cleanup paths idempotent.
      if (current && current.identity !== user.id) {
        return { ok: true, released: false };
      }

      await setPermission(user.id, VIEW_PERMISSION).catch(() => {});
      logger.info(`[stage] ${user.name} (${user.id}) released the stage`);
      return { ok: true, released: true };
    },

    /** Used when a participant leaves without releasing. */
    async revoke(identity) {
      try {
        await setPermission(identity, VIEW_PERMISSION);
      } catch {
        // They have already gone; nothing to revoke.
      }
    },
  };
}
