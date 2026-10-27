/**
 * Photos and videos sent in a chat (ADR 0036), kept as files on the app's
 * disk, one folder per chat, under server/data so they share its volume and
 * deploy.sh's exclude.
 *
 * What a file is gets decided by its bytes, never by its name or what the
 * client said it sent: whatever is stored here is served back to everyone in
 * the chat. Only kinds a Chromium-based app shows inline are accepted.
 *
 * All chats share one cap on disk. Past it, the oldest files go first, so the
 * disk the database also lives on cannot fill up; their messages stay, and
 * the app says the photo or video is no longer there.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** The most a single file may be. */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** The most all chats' files may take together before the oldest go. */
export const MEDIA_CAP_BYTES = 5 * 1024 ** 3;

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

export function createMediaStore({ dir, capBytes = MEDIA_CAP_BYTES, logger = console }) {
  // Absolute, whatever CHAT_MEDIA_DIR says: res.sendFile refuses a relative
  // path, and the default is relative to the working directory.
  const root = resolve(dir);
  const folder = (chatId) => {
    if (!CHAT_ID.test(chatId)) throw new Error('not a chat id');
    return join(root, chatId);
  };

  // Every file's size and age, by "chat/id", read from disk on the first save
  // and kept up to date after it, so the cap needs no walk of the folder.
  let index = null;
  let total = 0;
  async function loadIndex() {
    if (index) return;
    index = new Map();
    total = 0;
    const chats = await readdir(root).catch(() => []);
    for (const chatId of chats.filter((c) => CHAT_ID.test(c))) {
      for (const id of (await readdir(join(root, chatId)).catch(() => [])).filter(isMediaId)) {
        const info = await stat(join(root, chatId, id)).catch(() => null);
        if (!info?.isFile()) continue;
        index.set(`${chatId}/${id}`, { chatId, id, size: info.size, at: info.mtimeMs });
        total += info.size;
      }
    }
  }

  /** Deletes the oldest files until all of them fit under the cap again. */
  async function enforceCap() {
    if (total <= capBytes) return;
    const oldest = [...index.values()].sort((a, b) => a.at - b.at);
    let removed = 0;
    for (const file of oldest) {
      if (total <= capBytes) break;
      await rm(join(root, file.chatId, file.id), { force: true });
      index.delete(`${file.chatId}/${file.id}`);
      total -= file.size;
      removed += 1;
    }
    logger.info(`[chat] media over its cap: removed the ${removed} oldest file(s)`);
  }

  // Saves run one at a time, so two at once cannot both miss the cap.
  let queue = Promise.resolve();
  const serially = (task) => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  return {
    /**
     * Stores a file for a chat. Returns what a message carries about it, or
     * null for bytes that are not an accepted image or video.
     */
    async save(chatId, bytes) {
      const kind = mediaType(bytes);
      if (!kind || bytes.length === 0 || bytes.length > MEDIA_MAX_BYTES) return null;
      const where = folder(chatId);
      return serially(async () => {
        await loadIndex();
        const id = randomBytes(8).toString('hex');
        await mkdir(where, { recursive: true });
        await writeFile(join(where, id), bytes, { mode: 0o600 });
        index.set(`${chatId}/${id}`, { chatId, id, size: bytes.length, at: Date.now() });
        total += bytes.length;
        await enforceCap();
        return { id, type: kind.type, kind: kind.kind, size: bytes.length };
      });
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
      await serially(async () => {
        await rm(folder(chatId), { recursive: true, force: true });
        if (!index) return;
        for (const [key, file] of index) {
          if (file.chatId !== chatId) continue;
          index.delete(key);
          total -= file.size;
        }
      });
    },
  };
}
