/**
 * Publishing a hardware-encoded broadcast over WHIP, straight into the SFU.
 *
 * The desktop app encodes on the GPU and hands the stream to ffmpeg, which
 * publishes it over WHIP (WebRTC-HTTP Ingestion Protocol). LiveKit's own SFU
 * accepts WHIP at /whip/v1, so the stream lands in the room directly.
 *
 * This replaced a separate LiveKit Ingress service. That was a second WebRTC
 * server: it received the WHIP stream on its own UDP port (7885) and then
 * republished it into the SFU. So it needed a router forward of its own. It was
 * also configured with a LAN address, which made hardware encoding time out for
 * every broadcaster outside the server's network, on every GPU. Publishing to
 * the SFU puts the media on the SFU's existing UDP port. It needs no extra
 * forward, no extra container, and no address of its own to get wrong: the URL
 * is derived from LIVEKIT_WS_URL, which every other part of the app already
 * depends on. See docs/adr/0011-hardware-encoding-over-the-internet.md.
 */

import { AccessToken } from 'livekit-server-sdk';

/**
 * The WHIP publisher joins as its own participant, because a second connection
 * under the user's identity would disconnect the first. The suffix is how the
 * stage and the clients know whose it is.
 */
export const WHIP_SUFFIX = '-gpu';

/** True for the participant a WHIP broadcast publishes as. */
export function isWhipIdentity(identity) {
  return typeof identity === 'string' && identity.endsWith(WHIP_SUFFIX);
}

/** The human a WHIP participant belongs to, or the identity unchanged. */
export function ownerOf(identity) {
  return isWhipIdentity(identity) ? identity.slice(0, -WHIP_SUFFIX.length) : identity;
}

/**
 * The SFU's WHIP endpoint, from the URL clients already connect to.
 *
 * wss://sfu.example.com becomes https://sfu.example.com/whip/v1. It goes through
 * the same hostname and the same Caddy route as signalling, so it's reachable
 * from exactly the places the room is.
 */
export function whipUrlFrom(wsUrl) {
  if (typeof wsUrl !== 'string' || wsUrl === '') {
    throw new Error('LIVEKIT_WS_URL is not set, so there is no SFU to publish to.');
  }
  const url = new URL(wsUrl);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  else throw new Error(`LIVEKIT_WS_URL should be ws:// or wss://, not ${url.protocol}//`);

  url.pathname = `${url.pathname.replace(/\/+$/, '')}/whip/v1`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Long enough to finish ICE and DTLS; nothing more. LiveKit checks the token
 * when the publisher joins, not afterwards, so a short lifetime doesn't cut a
 * broadcast off. It just stops a leaked token from being useful for long.
 */
const TOKEN_TTL = '5m';

export class NotStageHolderError extends Error {
  constructor() {
    super('Only a participant with a claimed broadcast slot can publish.');
    this.name = 'NotStageHolderError';
  }
}

export function createWhipPublisher({
  apiKey,
  apiSecret,
  wsUrl,
  roomName,
  rooms,
  stage,
  logger = console,
}) {
  // Resolved once, at boot, so a malformed LIVEKIT_WS_URL fails loudly then
  // rather than when somebody first ticks "Hardware acceleration".
  const url = whipUrlFrom(wsUrl);

  return {
    url,

    /**
     * A WHIP endpoint and a token that allows publishing to it, for the stage
     * participant with a claimed broadcast slot only.
     *
     * The old ingress endpoint checked for a session and nothing else, so any
     * paired device could publish over WHIP whether it held the stage or not.
     * The stage was a rule the in-app path obeyed and the hardware path didn't.
     */
    async endpointFor(user) {
      if (!(await stage.isBroadcaster(user.id))) throw new NotStageHolderError();

      const at = new AccessToken(apiKey, apiSecret, {
        identity: `${user.id}${WHIP_SUFFIX}`,
        name: user.name,
        ttl: TOKEN_TTL,
      });
      at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        // Publish-only. Subscribing would pull every other track back down to
        // the broadcaster's machine for nothing.
        canSubscribe: false,
        canPublishData: false,
        roomCreate: false,
        roomAdmin: false,
      });

      logger.info(`[whip] ${user.name} (${user.id}) is publishing over WHIP`);
      return { url, token: await at.toJwt() };
    },

    /**
     * Takes the WHIP participant out of the room.
     *
     * ffmpeg ends the WHIP session when it exits cleanly, but a crash or a
     * killed process leaves the participant publishing until LiveKit notices.
     * That's a frozen picture for viewers and, until now, a stage that looked
     * busy. Removing it explicitly makes stopping definite.
     */
    async release(user) {
      try {
        await rooms.removeParticipant(roomName, `${user.id}${WHIP_SUFFIX}`);
        return { ok: true, released: true };
      } catch (err) {
        // Already gone, which is the common case after a clean stop.
        if (/not found|does not exist/i.test(err?.message ?? '')) {
          return { ok: true, released: false };
        }
        logger.warn(`[whip] could not remove ${user.id}${WHIP_SUFFIX}: ${err?.message ?? err}`);
        return { ok: true, released: false };
      }
    },
  };
}
