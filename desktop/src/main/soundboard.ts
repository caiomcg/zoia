/**
 * The soundboard's way to Myinstants (ADR 0040): its search, and its files.
 *
 * Both are read here rather than in the page: Myinstants sends no CORS
 * headers, and the page, loaded from file://, could not read it. A file is
 * fetched once and kept on this machine, so a sound played again, or by
 * someone else in the channel, starts at once and still plays if Myinstants
 * is down. Only Myinstants' own sound files are ever fetched (isSoundUrl):
 * the link comes from whoever played it.
 */

import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isSoundUrl,
  MAX_SOUND_BYTES,
  parseSoundPage,
  searchUrl,
  type SoundPage,
} from '../shared/soundboard';

/** How long Myinstants has to answer before the search gives up. */
const TIMEOUT_MS = 10_000;

/** How much the kept files may take up, oldest played going first. */
const CACHE_MAX_BYTES = 100 * 1024 * 1024;

const cacheDir = () => join(app.getPath('userData'), 'soundboard');

/** A search of Myinstants; null when it could not be reached or read. */
export async function search(query: string, page: number): Promise<SoundPage | null> {
  if (!query.trim()) return { sounds: [], next: null };
  try {
    const response = await net.fetch(searchUrl(query, page), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseSoundPage(await response.json(), page);
  } catch (err) {
    console.warn(`[soundboard] search failed: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/** One fetch per file at a time, however many plays ask for it at once. */
const loading = new Map<string, Promise<Uint8Array | null>>();

/** A sound's file, from this machine if it was fetched before; null if it cannot be had. */
export function sound(url: unknown): Promise<Uint8Array | null> {
  if (!isSoundUrl(url)) return Promise.resolve(null);
  let pending = loading.get(url);
  if (!pending) {
    pending = load(url).finally(() => loading.delete(url));
    loading.set(url, pending);
  }
  return pending;
}

async function load(url: string): Promise<Uint8Array | null> {
  const path = join(cacheDir(), createHash('sha256').update(url).digest('hex').slice(0, 32));
  try {
    const kept = await readFile(path);
    // Played again: last to be cleared away.
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return new Uint8Array(kept);
  } catch {
    // Not kept yet.
  }
  try {
    const response = await net.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = response.headers.get('content-type') ?? '';
    const length = Number(response.headers.get('content-length') ?? 0);
    if (!response.ok || !type.startsWith('audio/') || length > MAX_SOUND_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SOUND_BYTES) return null;
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(path, bytes);
    void prune();
    return bytes;
  } catch (err) {
    console.warn(`[soundboard] could not fetch a sound: ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/** Keeps the files under CACHE_MAX_BYTES, clearing those played longest ago. */
async function prune() {
  try {
    const dir = cacheDir();
    const files = await Promise.all(
      (await readdir(dir)).map(async (name) => {
        const info = await stat(join(dir, name));
        return { path: join(dir, name), size: info.size, used: info.mtimeMs };
      }),
    );
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.used - b.used)) {
      if (total <= CACHE_MAX_BYTES) break;
      await unlink(file.path).catch(() => {});
      total -= file.size;
    }
  } catch {
    // A full cache costs disk, not sound: the next prune tries again.
  }
}
