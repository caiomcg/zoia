/**
 * LiveKit access tokens.
 *
 * This module is the security boundary. Everyone joins with `canPublish: false`
 * — there is one tier of user, and nobody is a broadcaster by default.
 *
 * Publishing is granted later, at runtime, by `stage.js`, which raises only
 * that participant's permission. LiveKit validates
 * the resulting permission on every publish attempt, so a client that skips the
 * claim call, or edits the page's JavaScript, still cannot publish.
 *
 * Do not add a code path that lets a request influence `canPublish` here.
 */

import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { AVATAR_ATTRIBUTE } from './avatars.js';

const TOKEN_TTL = '10m';

export function createTokenIssuer({
  apiKey,
  apiSecret,
  apiUrl,
  wsUrl,
  roomName,
  roomService = null,
  logger = console,
}) {
  const rooms = roomService ?? new RoomServiceClient(apiUrl, apiKey, apiSecret);

  /**
   * LiveKit runs with auto_create disabled, so the room must exist before the
   * host joins. Viewers never trigger creation — an empty room they could
   * create would only be a room with nothing in it.
   */
  async function ensureRoom(room) {
    try {
      await rooms.createRoom({ name: room, emptyTimeout: 300, maxParticipants: 30 });
    } catch (err) {
      // Already existing is the common case and not an error.
      if (!/already exists/i.test(err?.message ?? '')) {
        logger.warn(`[token] could not ensure room "${room}": ${err?.message ?? err}`);
      }
    }
  }

  return {
    /**
     * A join token for one channel. `room` is chosen by the caller, which must
     * have checked it is a configured channel; nothing about it can widen the
     * grant, which is subscribe-only whatever room it names.
     */
    async issue(user, room = roomName) {
      // The room must exist before anyone joins, since auto_create is off.
      await ensureRoom(room);

      const at = new AccessToken(apiKey, apiSecret, {
        identity: user.id,
        name: user.name,
        ttl: TOKEN_TTL,
      });

      // The picture's version, so people already in the room see it the
      // moment this participant joins. Only a hash: see src/avatars.js.
      if (user.avatar) at.attributes = { [AVATAR_ATTRIBUTE]: String(user.avatar) };

      at.addGrant({
        roomJoin: true,
        room,
        // Nobody joins as a broadcaster. Publishing is granted at runtime by
        // stage.js, and only after that participant claims a broadcast slot.
        canPublish: false,
        canSubscribe: true,
        // Data messages carry presence and stage chatter between clients.
        canPublishData: true,
        // Lets someone rename themselves without reconnecting. Scoped to
        // their *own* participant record, so it grants no reach over anyone
        // else — unlike canPublish, which stays false and is handed out by
        // stage.js alone.
        canUpdateOwnMetadata: true,
        roomCreate: false,
        roomAdmin: false,
      });

      return {
        token: await at.toJwt(),
        wsUrl,
        room,
        identity: user.id,
        name: user.name,
      };
    },
  };
}

/** Decodes a JWT payload without verifying it. For tests and debugging only. */
export function decodeTokenPayload(jwt) {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
