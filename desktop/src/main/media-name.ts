/**
 * The name a chat photo or video is offered under when saved. Kept apart
 * from chat-media.ts, which needs Electron, so it can be tested on its own.
 */

/** The extension a type is saved with when the file came without a name. */
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

/**
 * A name to offer in the save dialog: the one it was sent with, made safe for
 * a file system, or one from its id, with an extension for its type.
 */
export function saveName(name: string | null, mediaId: string, type: string): string {
  const ext = EXTENSIONS[type] ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = (name ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  const base = clean.replace(/^[.\s]+/, '').slice(0, 120);
  if (!base) return `zoia-${mediaId}${ext}`;
  // A short run of letters or digits after the last dot; `._etc_passwd` is not one.
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}${ext}`;
}
