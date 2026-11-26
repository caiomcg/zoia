/**
 * Broadcast previews (ADR 0056): a small, recent picture of each broadcast,
 * for people outside its channel to see what is on before they join.
 *
 * The broadcaster's own app sends one every so often while it is live; the
 * server keeps the last one per broadcaster, in memory only, and hands it to
 * anyone signed in, as it hands them the channel list. Nothing is written to
 * disk: a restart or a broadcast ending loses them, and the next upload puts
 * one back.
 */

/**
 * The most one preview may weigh. A 320×180 JPEG at the app's quality is
 * 10–25 KB; this leaves room for a busy picture and refuses anything else.
 */
export const PREVIEW_MAX_BYTES = 64 * 1024;

/**
 * The shortest gap between two uploads from one broadcaster. The app sends
 * one every 15 s; this only stops a client from making the server a relay.
 */
export const PREVIEW_MIN_INTERVAL_MS = 5_000;

/**
 * How long a preview stands after its last upload. Past this the broadcaster
 * has stopped sending (gone, crashed, an older app) and an old picture would
 * say something that is no longer on.
 */
export const PREVIEW_TTL_MS = 60_000;

/** Whether these bytes start like a JPEG; the only kind the app sends. */
export function isJpeg(bytes) {
  return (
    Buffer.isBuffer(bytes) &&
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

export function createPreviews({ now = () => Date.now() } = {}) {
  // By broadcaster identity: one broadcast per person across all channels.
  const byIdentity = new Map();
  let counter = 0;

  const fresh = (entry) => entry && now() - entry.at <= PREVIEW_TTL_MS;

  return {
    /**
     * Keeps this picture as the broadcaster's preview in this channel.
     * Whether they really broadcast there is the caller's check.
     */
    put(channelId, identity, bytes) {
      // Stale ones go here rather than on a timer: there are as many as
      // broadcasters, and nothing else needs them gone sooner.
      for (const [id, entry] of byIdentity) if (!fresh(entry)) byIdentity.delete(id);
      const previous = byIdentity.get(identity);
      if (
        previous &&
        previous.channelId === channelId &&
        now() - previous.at < PREVIEW_MIN_INTERVAL_MS
      ) {
        return { ok: false, reason: 'too_soon' };
      }
      counter += 1;
      // A version to fetch it by, changing with every picture, so a client's
      // cache of the last one never stands in for the next.
      const version = `${now().toString(36)}${counter.toString(36)}`;
      byIdentity.set(identity, { channelId, bytes, version, at: now() });
      return { ok: true, version };
    },

    /** The preview's version, or null when there is no current one there. */
    version(channelId, identity) {
      const entry = byIdentity.get(identity);
      return fresh(entry) && entry.channelId === channelId ? entry.version : null;
    },

    /** The picture itself, or null. */
    get(channelId, identity) {
      const entry = byIdentity.get(identity);
      if (!fresh(entry) || entry.channelId !== channelId) return null;
      return { bytes: entry.bytes, version: entry.version };
    },

    /** The broadcast ended: its picture goes with it. */
    drop(identity) {
      byIdentity.delete(identity);
    },
  };
}
