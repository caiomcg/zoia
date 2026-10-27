/**
 * Photos and videos sent in a chat (ADR 0036), kept as files on the app's
 * disk, one folder per chat, under server/data so they share its volume and
 * deploy.sh's exclude.
 *
 * What a file is gets decided by its bytes, never by its name or what the
 * client said it sent: whatever is stored here is served back to everyone in
 * the chat. Only kinds a Chromium-based app shows inline are accepted.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** The most a single file may be. */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

const MEDIA_ID = /^[0-9a-f]{16}$/;
const CHAT_ID = /^[0-9a-f]{8}$/;

export const isMediaId = (id) => typeof id === 'string' && MEDIA_ID.test(id);

/** MP4 brands Chromium plays. QuickTime ('qt  ') and others are refused. */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'M4V ',
]);

/** The media type of these bytes, or null when they are not one accepted here. */
export function mediaType(bytes) {
  const b = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, Math.min(bytes.length, 16));
  const ascii = (from, to) => b.subarray(from, to).toString('latin1');
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { type: 'image/png', kind: 'image' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { type: 'image/jpeg', kind: 'image' };
  }
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return { type: 'image/gif', kind: 'image' };
  }
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { type: 'image/webp', kind: 'image' };
  }
  if (b.length >= 12 && ascii(4, 8) === 'ftyp' && MP4_BRANDS.has(ascii(8, 12))) {
    return { type: 'video/mp4', kind: 'video' };
  }
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) {
    return { type: 'video/webm', kind: 'video' };
  }
  return null;
}

/** A file name as shown under a video, tidied; never used for a path. */
export function cleanFileName(name) {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const tidy = name.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  return tidy ? tidy.slice(0, 100) : null;
}

export function createMediaStore({ dir }) {
  // Absolute, whatever CHAT_MEDIA_DIR says: res.sendFile refuses a relative
  // path, and the default is relative to the working directory.
  const root = resolve(dir);
  const folder = (chatId) => {
    if (!CHAT_ID.test(chatId)) throw new Error('not a chat id');
    return join(root, chatId);
  };

  return {
    /**
     * Stores a file for a chat. Returns what a message carries about it, or
     * null for bytes that are not an accepted image or video.
     */
    async save(chatId, bytes) {
      const kind = mediaType(bytes);
      if (!kind || bytes.length === 0 || bytes.length > MEDIA_MAX_BYTES) return null;
      const id = randomBytes(8).toString('hex');
      await mkdir(folder(chatId), { recursive: true });
      await writeFile(join(folder(chatId), id), bytes, { mode: 0o600 });
      return { id, type: kind.type, kind: kind.kind, size: bytes.length };
    },

    /** Where a stored file is and what it is, judged again by its bytes; null if none. */
    async find(chatId, id) {
      if (!CHAT_ID.test(chatId) || !isMediaId(id)) return null;
      const path = join(folder(chatId), id);
      let handle;
      try {
        handle = await open(path, 'r');
        const head = Buffer.alloc(16);
        const { bytesRead } = await handle.read(head, 0, 16, 0);
        const kind = mediaType(head.subarray(0, bytesRead));
        const { size } = await stat(path);
        return kind ? { path, type: kind.type, size } : null;
      } catch {
        return null;
      } finally {
        await handle?.close();
      }
    },

    /** Deletes every file of a chat that is being removed. */
    async removeChat(chatId) {
      if (!CHAT_ID.test(chatId)) return;
      await rm(folder(chatId), { recursive: true, force: true });
    },
  };
}
