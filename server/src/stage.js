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

export function createStage({ rooms, roomName, logger = console }) {
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
     */
    async claim(user) {
      const current = await holder();

      if (current && current.identity !== user.id) {
        return { ok: false, reason: 'busy', holder: current };
      }

      await setPermission(user.id, PUBLISH_PERMISSION);
      logger.info(`[stage] ${user.name} (${user.id}) claimed the stage`);
      return { ok: true, holder: { identity: user.id, name: user.name } };
    },

    async release(user) {
      const current = await holder();

      // Releasing when you do not hold it is a no-op, not an error: it keeps
      // client cleanup paths simple and idempotent.
      if (!current || current.identity !== user.id) {
        return { ok: true, released: false };
      }

      await setPermission(user.id, VIEW_PERMISSION);
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
