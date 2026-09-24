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

import { isWhipIdentity, ownerOf, WHIP_SUFFIX } from './whip.js';

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

  /**
   * The person currently permitted to publish, if any.
   *
   * A hardware-encoded broadcast publishes from a second participant,
   * `<id>-gpu`, with publish rights of its own from its WHIP token. Treating
   * that as a separate holder broke the stage both ways. The human looked
   * idle, since their own participant publishes nothing while the GPU
   * participant carries the picture, so after the grace period anyone could
   * take the stage from someone mid-broadcast. And whichever of the two was
   * listed first was reported as the holder, so a release could find
   * "someone else" holding it and refuse. The owner is the holder; their WHIP
   * participant only counts as proof they are publishing.
   */
  async function holder() {
    const participants = await listParticipants();
    const tracksOf = (identity) =>
      participants
        .filter((p) => ownerOf(p.identity) === identity)
        .reduce((sum, p) => sum + (p.tracks ?? []).length, 0);

    const human = participants.find((p) => !isWhipIdentity(p.identity) && p.permission?.canPublish);
    // A WHIP publisher whose owner has no publish rights, or has left: the app
    // crashed and ffmpeg kept going. It is still on stage, as far as anyone
    // watching can tell, so it still holds the stage for its owner.
    const orphan = human
      ? null
      : participants.find((p) => isWhipIdentity(p.identity) && (p.tracks ?? []).length > 0);

    const found = human ?? orphan;
    if (!found) return null;
    const identity = ownerOf(found.identity);
    const owner = participants.find((p) => p.identity === identity);
    return {
      identity,
      name: owner?.name || found.name || identity,
      publishing: tracksOf(identity) > 0,
    };
  }

  /**
   * Ends a hardware-encoded broadcast for its owner. Needed wherever the stage
   * is taken or given up: the WHIP participant's rights come from its token,
   * not from updateParticipant, so revoking the owner leaves it publishing.
   */
  async function dropWhip(identity) {
    try {
      await rooms.removeParticipant?.(roomName, `${identity}${WHIP_SUFFIX}`);
    } catch {
      // Usually it was never there: most broadcasts are not hardware-encoded.
    }
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
        await dropWhip(current.identity);
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
        await dropWhip(current.identity);
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
      await dropWhip(user.id);
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
