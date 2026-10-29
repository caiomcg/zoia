/**
 * The soundboard (ADR 0040): sounds found on Myinstants and played in a
 * channel. What goes through the room is a message naming the sound, never
 * its audio; each app fetches the file and plays it itself, at its own volume.
 *
 * Both processes use this: main to search and to fetch, the renderer to read
 * what arrives. A link is checked by both, since it comes from other people.
 *
 * Kept free of imports so `node --test` can load it directly.
 */

/** Everyone's soundboard plays arrive on this topic, from the person who played. */
export const SOUNDBOARD_TOPIC = 'zoia.soundboard';

/** Myinstants' search, which answers JSON. Not a documented API: see ADR 0040. */
export const MYINSTANTS_SEARCH = 'https://www.myinstants.com/api/v1/instants/';

/** Where Myinstants keeps its files: the only place a sound is fetched from. */
const SOUND_ORIGIN = 'https://www.myinstants.com';
const SOUND_PATH = '/media/sounds/';

/** A sound plays for this long at most, for everyone, then fades out. */
export const MAX_SOUND_SECONDS = 10;

/** The most a sound's file may be. Ten seconds of any sensible mp3 is far less. */
export const MAX_SOUND_BYTES = 5 * 1024 * 1024;

/** Longest name kept: past it a name is a paragraph, not a label. */
const MAX_NAME = 80;

export interface Sound {
  /** Myinstants' own id for it, which favourites and shortcuts are kept by. */
  slug: string;
  name: string;
  /** The file, on Myinstants. */
  url: string;
  /** Its button colour on Myinstants, as six hex digits, when it has one. */
  color: string | null;
}

/** One page of a search. */
export interface SoundPage {
  sounds: Sound[];
  /** The page after this one, or null at the end. */
  next: number | null;
}

const SLUG = /^[A-Za-z0-9_-]{1,120}$/;
const FILE = /^[A-Za-z0-9._-]{1,200}$/;
const COLOR = /^[0-9a-f]{6}$/i;

export function isSoundSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value);
}

/**
 * A link to one of Myinstants' sound files, and nothing else: no other host,
 * no query, no way out of the folder. Anything played in a room is fetched by
 * everyone in it, so this is what keeps a message from sending them elsewhere.
 */
export function isSoundUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(SOUND_ORIGIN + SOUND_PATH)) return false;
  const file = value.slice(SOUND_ORIGIN.length + SOUND_PATH.length);
  return FILE.test(file) && !/^\.+$/.test(file);
}

/** A sound from Myinstants or from a message, or null if any of it is wrong. */
export function parseSound(value: unknown): Sound | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  // Myinstants calls the file `sound`; what Zoia keeps and sends calls it `url`.
  const url = raw.url ?? raw.sound;
  if (!isSoundSlug(raw.slug) || !isSoundUrl(url) || typeof raw.name !== 'string') return null;
  const name = raw.name.trim().slice(0, MAX_NAME);
  if (!name) return null;
  const color = typeof raw.color === 'string' && COLOR.test(raw.color) ? raw.color : null;
  return { slug: raw.slug, name, url, color };
}

/** A list of sounds as kept, each one once, at most `max`. Anything else is an empty list. */
export function parseSoundList(raw: string | null, max: number): Sound[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const sounds: Sound[] = [];
    for (const item of parsed) {
      if (sounds.length >= max) break;
      const sound = parseSound(item);
      if (sound && !sounds.some((s) => s.slug === sound.slug)) sounds.push(sound);
    }
    return sounds;
  } catch {
    return [];
  }
}

/** The search link for `query`, page `page` (from 1). */
export function searchUrl(query: string, page: number): string {
  const params = new URLSearchParams({ format: 'json', name: query.trim() });
  if (page > 1) params.set('page', String(page));
  return `${MYINSTANTS_SEARCH}?${params}`;
}

/** What Myinstants answered, as sounds Zoia can play. Anything unreadable is left out. */
export function parseSoundPage(body: unknown, page: number): SoundPage {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const results = Array.isArray(raw.results) ? raw.results : [];
  const sounds = results.map(parseSound).filter((sound): sound is Sound => sound !== null);
  return { sounds, next: typeof raw.next === 'string' && raw.next ? page + 1 : null };
}

/** The message that plays `sound` for everyone in the room. */
export function encodeSoundMessage(sound: Sound): Uint8Array<ArrayBuffer> {
  const { slug, name, url } = sound;
  return new TextEncoder().encode(JSON.stringify({ slug, name, url }));
}

/** A message from the room, as the sound it plays, or null for anything else. */
export function decodeSoundMessage(payload: Uint8Array): Sound | null {
  try {
    return parseSound(JSON.parse(new TextDecoder().decode(payload)));
  } catch {
    return null;
  }
}
