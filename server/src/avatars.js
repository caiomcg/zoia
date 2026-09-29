/**
 * Profile pictures.
 *
 * One small image per device, kept as a file beside the other stores rather
 * than inside devices.json: that file is read on every request, and a few
 * dozen pictures in it would be parsed each time for nothing.
 *
 * The room never carries the picture itself. A participant attribute holds a
 * short hash of it, and clients fetch the bytes once per hash. The attribute
 * is only a cache key: the picture is always looked up by the participant's
 * identity, so a client setting someone else's hash on itself shows nothing
 * but its own picture.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Must match AVATAR_ATTRIBUTE in desktop/src/renderer/avatars.ts. */
export const AVATAR_ATTRIBUTE = 'zoia.avatar';

/**
 * The client sends a 256px WebP of a few tens of KB; this leaves room for a
 * PNG from an older or different client without accepting anything large.
 */
export const AVATAR_MAX_BYTES = 256 * 1024;

/** Device ids are 8 hex characters (see store.js). Nothing else names a file. */
const AVATAR_ID = /^[0-9a-f]{8}$/;

export function isAvatarId(id) {
  return typeof id === 'string' && AVATAR_ID.test(id);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The image type, judged by the bytes and never by what the client says it
 * sent: whatever is stored here is served back to every other client.
 */
export function imageType(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function createAvatarStore({ dir }) {
  function fileOf(id) {
    if (!isAvatarId(id)) throw new Error('invalid avatar id');
    return join(dir, `${id}.img`);
  }

  return {
    /** Stores the picture and returns its version: a short hash of the bytes. */
    async save(id, bytes) {
      const file = fileOf(id);
      await mkdir(dir, { recursive: true });
      // Write-then-rename, as the JSON stores do, so a reader never sees half
      // a picture.
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, file);
      return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    },

    /** The stored picture and its type, or null when there is none. */
    async read(id) {
      try {
        const bytes = await readFile(fileOf(id));
        const type = imageType(bytes);
        return type ? { bytes, type } : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    async remove(id) {
      await rm(fileOf(id), { force: true });
    },
  };
}
