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

/*
 * LiveKit replaces a participant's permission wholesale; a field left out is
 * false. canUpdateMetadata must be restated here or a claim silently takes
 * away what the join token granted, and the client's setMetadata (the source
 * label) and setName (a rename) are refused from then on.
 */
const PUBLISH_PERMISSION = {
  canSubscribe: true,
  canPublish: true,
  canPublishData: true,
  canUpdateMetadata: true,
};

const VIEW_PERMISSION = {
  canSubscribe: true,
  canPublish: false,
  canPublishData: true,
  canUpdateMetadata: true,
};

/*
 * In voice: the microphone and nothing else. LiveKit enforces the source
 * list, so a voice participant cannot publish a screen or a camera, and
 * holding it is not holding a broadcast slot. A full claim replaces it,
 * since PUBLISH_PERMISSION lists no sources and so allows them all.
 */
const VOICE_PERMISSION = {
  canSubscribe: true,
  canPublish: true,
  canPublishSources: [TrackSource.MICROPHONE],
  canPublishData: true,
  canUpdateMetadata: true,
};

/**
 * How long a claimed slot may sit without publishing before it is considered
 * stale. This covers the window between claiming and choosing a source.
 */
const STALE_CLAIM_MS = 20_000;

import { DataPacket_Kind, TrackSource } from 'livekit-server-sdk';
import { isWhipIdentity, ownerOf, WHIP_SUFFIX } from './whip.js';
import { AVATAR_ATTRIBUTE } from './avatars.js';

/**
 * Whose broadcasts a participant is watching, as each app announces it.
 * Must match WATCHING_ATTRIBUTE in desktop/src/renderer/livekit/watching.ts.
 */
const WATCHING_ATTRIBUTE = 'zoia.watching';

/**
 * Who is in voice. The server sets it together with the voice permission, so
 * nothing is kept here and a participant who leaves takes it with them. The
 * participant could set it themselves (canUpdateMetadata), which gains them
 * nothing: a release then grants the microphone, as joining voice would.
 */
export const VOICE_ATTRIBUTE = 'zoia.voice';

/** May publish the microphone and nothing else: in voice, not on the stage. */
function microphoneOnly(permission) {
  const sources = permission?.canPublishSources ?? [];
  return sources.length > 0 && sources.every((s) => s === TrackSource.MICROPHONE);
}

/** Holds a broadcast slot: may publish, and more than a microphone. */
function holdsSlot(p) {
  return Boolean(p?.permission?.canPublish) && !microphoneOnly(p.permission);
}

/**
 * Sends something other than a voice. A WHIP participant is all broadcast,
 * since WHIP may label its audio a microphone; a person's own microphone is
 * either voice or a camera's, and a camera has its own track.
 */
function sharing(p) {
  const tracks = p.tracks ?? [];
  if (isWhipIdentity(p.identity)) return tracks.length > 0;
  return tracks.some((t) => t.source !== TrackSource.MICROPHONE);
}

function inVoice(p) {
  return p?.attributes?.[VOICE_ATTRIBUTE] === '1';
}

/** In voice with the microphone on: could be heard right now. */
function audible(p) {
  return (
    inVoice(p) && (p.tracks ?? []).some((t) => t.source === TrackSource.MICROPHONE && !t.muted)
  );
}

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
    return broadcastersAmong(await listParticipants());
  }

  function broadcastersAmong(participants) {
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
        const permitted = holdsSlot(owner);
        const whipPublishing = related.some(
          (p) => isWhipIdentity(p.identity) && (p.tracks ?? []).length > 0,
        );
        if (!permitted && !whipPublishing) return null;
        return {
          identity,
          name: owner?.name || related[0]?.name || identity,
          publishing: related.some(sharing),
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

  async function setVoice(identity, joined, permission) {
    await rooms.updateParticipant(roomName, identity, {
      ...(permission ? { permission } : {}),
      attributes: { [VOICE_ATTRIBUTE]: joined ? '1' : '' },
    });
  }

  return {
    broadcasters,

    /**
     * Takes these identities out of the room now, hardware broadcasts and
     * all, rather than when their token next needs renewing. For someone
     * disabled or a machine signed out: their session is refused on its next
     * request, but a LiveKit connection makes none.
     */
    /**
     * Gives these identities a new name in the room, broadcasts and all, so
     * everyone in it sees the change now rather than when they next join.
     */
    async rename(identities, name) {
      const machines = new Set(identities);
      for (const p of await listParticipants()) {
        if (!machines.has(ownerOf(p.identity))) continue;
        try {
          await rooms.updateParticipant(roomName, p.identity, { name });
        } catch {
          // Left the room in the meantime.
        }
      }
    },

    async disconnect(identities) {
      for (const identity of identities) {
        for (const id of [identity, `${identity}${WHIP_SUFFIX}`]) {
          try {
            await rooms.removeParticipant?.(roomName, id);
          } catch {
            // Not in this room, which is most rooms.
          }
        }
      }
    },

    /**
     * A message from the server to one participant, on a topic. Only the
     * server can send one with no sender, which is how a client knows it is
     * not from another participant.
     */
    async send(identity, topic, message) {
      const data = new TextEncoder().encode(JSON.stringify(message));
      await rooms.sendData(roomName, data, DataPacket_Kind.RELIABLE, {
        destinationIdentities: [identity],
        topic,
      });
    },

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
      return list.map((p) => {
        // The picture's version, for the channel list. Informational only:
        // nothing here reads it to decide anything.
        const avatar = p.attributes?.[AVATAR_ATTRIBUTE];
        return {
          identity: p.identity,
          name: p.name || p.identity,
          // Holds a broadcast slot; a voice participant's microphone is not one.
          canPublish: holdsSlot(p),
          publishing: sharing(p),
          voice: inVoice(p),
          audible: audible(p),
          joinedAt: Number(p.joinedAt ?? 0),
          // Watching someone's picture, for the idle sweep (src/idle.js).
          watching: Boolean(p.attributes?.[WATCHING_ATTRIBUTE]),
          ...(avatar ? { avatar } : {}),
        };
      });
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

      let voice = false;
      try {
        const participants = await listParticipants();
        const active = broadcastersAmong(participants).some((b) => b.identity === user.id);
        if (!active) return { ok: true, released: false };
        voice = inVoice(participants.find((p) => p.identity === user.id));
      } catch {
        // Still attempt the revoke: leaving a permission behind is worse than
        // an idempotent update against a participant that already left. Not
        // knowing whether they are in voice, they lose the microphone too.
      }
      // Someone in voice keeps their microphone when they stop sharing.
      await setPermission(user.id, voice ? VOICE_PERMISSION : VIEW_PERMISSION).catch(() => {});
      await dropWhip(user.id);
      logger.info(`[stage] ${user.name} (${user.id}) released their broadcast slot`);
      return { ok: true, released: true };
    },

    /**
     * Joins voice: the microphone, and the attribute that says so. Someone
     * holding a slot may already publish it, and narrowing them to the
     * microphone would end their broadcast, so they only get the attribute.
     */
    async joinVoice(user) {
      const current = (await listParticipants()).find((p) => p.identity === user.id);
      if (!current) return { ok: false, reason: 'not_in_room' };
      await setVoice(user.id, true, holdsSlot(current) ? null : VOICE_PERMISSION);
      logger.info(`[voice] ${user.name} (${user.id}) joined voice`);
      return { ok: true };
    },

    /** Leaves voice. A broadcast goes on; otherwise the microphone goes. */
    async leaveVoice(user) {
      const current = (await listParticipants()).find((p) => p.identity === user.id);
      if (!current) return { ok: true };
      await setVoice(user.id, false, holdsSlot(current) ? null : VIEW_PERMISSION);
      logger.info(`[voice] ${user.name} (${user.id}) left voice`);
      return { ok: true };
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
