/**
 * LiveKit access tokens.
 *
 * This module is the security boundary. `canPublish` is derived from the role
 * stored against the invite key and from nothing the client sends, and LiveKit
 * validates that grant server-side on every publish attempt. A viewer editing
 * the page's JavaScript therefore achieves nothing.
 *
 * Do not add a code path that lets a request influence `canPublish`.
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
      const isHost = user.role === 'host';
      if (isHost) await ensureRoom();

      const at = new AccessToken(apiKey, apiSecret, {
        identity: user.id,
        name: user.name,
        ttl: TOKEN_TTL,
      });

      at.addGrant({
        roomJoin: true,
        room: roomName,
        // The whole model lives on this line.
        canPublish: isHost,
        canSubscribe: true,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        roomCreate: false,
        roomAdmin: false,
      });

      return {
        token: await at.toJwt(),
        wsUrl,
        room: roomName,
        role: user.role,
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
