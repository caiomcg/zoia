/**
 * Runtime publish permissions for the room.
 *
 * Everyone joins with `canPublish: false`. Claiming the stage asks the server
 * to grant that permission, and LiveKit pushes the change to the client live.
 * Different participants may claim slots at the same time.
 *
 * A client that skips the claim call still cannot publish, because its
 * permission says so.
 *
 * State is derived from LiveKit's own participant list rather than tracked
 * separately, so a broadcaster who closes their laptop cannot leave a slot
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
 * How long a claimed slot may sit without publishing before it is considered
 * stale. This covers the window between claiming and choosing a source.
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
   * All people currently permitted to publish, if any.
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
  async function broadcasters() {
    const participants = await listParticipants();
    const identities = new Set(
      participants
        .filter((p) => !isWhipIdentity(p.identity))
        .map((p) => p.identity)
        .concat(
          participants
            .filter((p) => isWhipIdentity(p.identity) && (p.tracks ?? []).length > 0)
            .map((p) => ownerOf(p.identity)),
        ),
    );
    return [...identities]
      .map((identity) => {
        const owner = participants.find((p) => p.identity === identity);
        const related = participants.filter((p) => ownerOf(p.identity) === identity);
        const permitted = Boolean(owner?.permission?.canPublish);
        const publishing = related.some((p) => (p.tracks ?? []).length > 0);
        const whipPublishing = related.some(
          (p) => isWhipIdentity(p.identity) && (p.tracks ?? []).length > 0,
        );
        if (!permitted && !whipPublishing) return null;
        return {
          identity,
          name: owner?.name || related[0]?.name || identity,
          publishing: publishing || whipPublishing,
        };
      })
      .filter(Boolean);
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
    broadcasters,

    // Kept for integrations that have not migrated yet. New code should use
    // broadcasters(), since there may be more than one result.
    async holder() {
      return (await broadcasters())[0] ?? null;
    },

    async isBroadcaster(identity) {
      return (await broadcasters()).some((b) => b.identity === identity);
    },

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
     * Grants publish rights to this participant. Other participants' slots
     * are independent and remain untouched.
     */
    async claim(user) {
      const current = (await listParticipants()).find((p) => p.identity === user.id);
      if (!current) return { ok: false, reason: 'not_in_room' };
      const existing = (await broadcasters()).find((b) => b.identity === user.id);
      if (existing?.publishing) return { ok: true, broadcaster: existing };
      const since = claimedAt.get(user.id);
      if (existing && since !== undefined && now() - since <= STALE_CLAIM_MS) {
        return { ok: true, broadcaster: existing };
      }
      await setPermission(user.id, PUBLISH_PERMISSION);
      claimedAt.set(user.id, now());
      logger.info(`[stage] ${user.name} (${user.id}) claimed a broadcast slot`);
      return { ok: true, broadcaster: { identity: user.id, name: user.name, publishing: false } };
    },

    async release(user) {
      claimedAt.delete(user.id);

      try {
        const active = (await broadcasters()).some((b) => b.identity === user.id);
        if (!active) return { ok: true, released: false };
      } catch {
        // Still attempt the revoke: leaving a permission behind is worse than
        // an idempotent update against a participant that already left.
      }
      await setPermission(user.id, VIEW_PERMISSION).catch(() => {});
      await dropWhip(user.id);
      logger.info(`[stage] ${user.name} (${user.id}) released their broadcast slot`);
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
