/**
 * LiveKit access tokens.
 *
 * This module is the security boundary. Everyone joins with `canPublish: false`
 * — there is one tier of user, and nobody is a broadcaster by default.
 *
 * Publishing is granted later, at runtime, by `stage.js`, which checks that the
 * stage is free before raising a participant's permission. LiveKit validates
 * the resulting permission on every publish attempt, so a client that skips the
 * claim call, or edits the page's JavaScript, still cannot publish.
 *
 * Do not add a code path that lets a request influence `canPublish` here.
 */

import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

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
  async function ensureRoom() {
    try {
      await rooms.createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 30 });
    } catch (err) {
      // Already existing is the common case and not an error.
      if (!/already exists/i.test(err?.message ?? '')) {
        logger.warn(`[token] could not ensure room "${roomName}": ${err?.message ?? err}`);
      }
    }
  }

  return {
    async issue(user) {
      // The room must exist before anyone joins, since auto_create is off.
      await ensureRoom();

      const at = new AccessToken(apiKey, apiSecret, {
        identity: user.id,
        name: user.name,
        ttl: TOKEN_TTL,
      });

      at.addGrant({
        roomJoin: true,
        room: roomName,
        // Nobody joins as a broadcaster. Publishing is granted at runtime by
        // stage.js, and only when the stage is free.
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
        room: roomName,
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
