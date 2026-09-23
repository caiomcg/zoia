/**
 * WHIP ingress, for broadcasters that encode in hardware.
 *
 * Why this exists: Chromium's WebRTC stack exposes no hardware video encoder
 * on Windows. Measured on an RTX 4070 SUPER —
 * navigator.mediaCapabilities.encodingInfo() reports powerEfficient=false for
 * H.264, VP8, VP9 and AV1 at every resolution, in Electron *and* in stock
 * Chrome — and a live publish reports encoderImplementation "OpenH264".
 *
 * So the desktop app encodes with NVENC itself and publishes over WHIP. This
 * module hands it somewhere to publish to. The ingress is created with
 * bypassTranscoding, meaning the SFU forwards the already-encoded H.264 rather
 * than re-encoding it; without that, the server would undo the client's
 * hardware encoding on a 4-core box with no GPU.
 */

import { IngressClient, IngressInput } from 'livekit-server-sdk';

export function createIngressService({
  apiUrl,
  apiKey,
  apiSecret,
  roomName,
  whipBaseUrl,
  rooms,
  logger = console,
}) {
  const client = new IngressClient(apiUrl, apiKey, apiSecret);

  // One ingress per user, reused across broadcasts. Creating a fresh one on
  // every "go live" would leak ingress objects server-side for every click.
  const byUser = new Map();

  return {
    /**
     * Returns a WHIP endpoint the caller can publish NVENC output to. The
     * ingress publishes into the room as a participant distinct from the
     * user's own app connection, which is why the identity is suffixed.
     */
    async endpointFor(user) {
      // The ingress joins as a participant, and LiveKit will not create a
      // room implicitly (auto_create is off). Without this the WHIP session
      // negotiates fully and then dies with "requested room does not exist".
      await rooms.createRoom({ name: roomName, emptyTimeout: 600 }).catch((err) => {
        if (!/already exists/i.test(err?.message ?? '')) throw err;
      });

      const cached = byUser.get(user.id);
      if (cached) {
        const stillThere = await client
          .listIngress({ ingressId: cached.ingressId })
          .then((list) => list.length > 0)
          .catch(() => false);
        if (stillThere) return cached;
        byUser.delete(user.id);
      }

      const info = await client.createIngress(IngressInput.WHIP_INPUT, {
        name: `nvenc-${user.name}`,
        roomName,
        participantIdentity: `${user.id}-nvenc`,
        participantName: user.name,
        bypassTranscoding: true,
        enableTranscoding: false,
      });

      if (!whipBaseUrl) {
        throw new Error('WHIP_BASE_URL is not set, so there is nowhere to publish to.');
      }

      const endpoint = {
        ingressId: info.ingressId,
        streamKey: info.streamKey,
        // The service reports an empty url unless whip_base_url is configured,
        // and the desktop app needs somewhere concrete to POST to.
        url: `${whipBaseUrl.replace(/\/+$/, '')}/${info.streamKey}`,
      };

      byUser.set(user.id, endpoint);
      logger.log(`[ingress] created ${info.ingressId} for ${user.name}`);
      return endpoint;
    },

    /** Called when a hardware broadcast ends, so the slot is not held open. */
    async release(user) {
      const existing = byUser.get(user.id);
      if (!existing) return { ok: true, released: false };
      byUser.delete(user.id);
      await client.deleteIngress(existing.ingressId).catch((err) => {
        logger.warn(`[ingress] delete ${existing.ingressId} failed: ${err?.message ?? err}`);
      });
      return { ok: true, released: true };
    },
  };
}
