/**
 * Who has which profile picture, and the pictures themselves.
 *
 * The room carries only a short version per person (a participant attribute);
 * the picture is fetched once per version, through the main process, and kept
 * here for every avatar on screen. Known room-wide rather than passed down
 * through each list, thumbnail and tile: an Avatar needs only an identity.
 */

import { useEffect, useSyncExternalStore } from 'react';

/** Must match AVATAR_ATTRIBUTE in server/src/avatars.js. */
export const AVATAR_ATTRIBUTE = 'zoia.avatar';

/** A version is a short hex hash; anything else in the attribute is ignored. */
const VERSION = /^[0-9a-f]{1,64}$/;

export function avatarVersion(value: string | null | undefined): string | undefined {
  return value && VERSION.test(value) ? value : undefined;
}

const versions = new Map<string, string>();
// By `${identity}:${version}`. null means "has none", so it is not asked again.
const images = new Map<string, string | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;

function emit() {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Records what version of their picture each identity has; `undefined` means
 * none. Later entries win, so pass the most current source last.
 */
export function publishAvatarVersions(
  entries: Iterable<readonly [string, string | null | undefined]>,
): void {
  const next = new Map<string, string | undefined>();
  for (const [identity, value] of entries) next.set(identity, avatarVersion(value));
  let changed = false;
  for (const [identity, version] of next) {
    if (versions.get(identity) === version) continue;
    changed = true;
    if (version) versions.set(identity, version);
    else versions.delete(identity);
  }
  if (changed) emit();
}

/**
 * Your own new picture, known before the room has echoed it back: shown at
 * once from the bytes just encoded rather than downloaded again.
 */
export function primeAvatar(identity: string, version: string | null, image?: string): void {
  if (version && image) images.set(`${identity}:${version}`, image);
  publishAvatarVersions([[identity, version]]);
}

function load(identity: string, version: string) {
  const key = `${identity}:${version}`;
  if (images.has(key) || pending.has(key)) return;
  pending.add(key);
  window.zoia.avatars
    .get(identity, version)
    .then((image) => {
      images.set(key, image);
      emit();
    })
    .catch(() => {
      // Offline or the server is busy: the initials stand in, and the next
      // avatar to mount for this person tries again.
    })
    .finally(() => pending.delete(key));
}

/** The picture for this identity as a URL to show, or undefined for initials. */
export function useAvatarImage(identity: string | undefined): string | undefined {
  useSyncExternalStore(subscribe, () => revision);
  const version = identity ? versions.get(identity) : undefined;
  useEffect(() => {
    if (identity && version) load(identity, version);
  }, [identity, version]);
  if (!identity || !version) return undefined;
  return images.get(`${identity}:${version}`) ?? undefined;
}

/** A square of the source picture, in its own pixels. */
export interface AvatarCrop {
  x: number;
  y: number;
  size: number;
}

/** A picture ready to upload, and a URL that shows it meanwhile. */
export interface EncodedAvatar {
  bytes: Uint8Array;
  url: string;
}

/**
 * Cuts a square out of a picture (the middle one unless `crop` says which)
 * and scales it to 256px WebP: a few tens of KB whatever was picked, well
 * inside what the server accepts.
 */
export async function encodeAvatar(file: Blob, crop?: AvatarCrop): Promise<EncodedAvatar> {
  const SIZE = 256;
  const bitmap = await createImageBitmap(file);
  try {
    const side = crop?.size ?? Math.min(bitmap.width, bitmap.height);
    const sx = crop?.x ?? (bitmap.width - side) / 2;
    const sy = crop?.y ?? (bitmap.height - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, SIZE, SIZE);
    const url = canvas.toDataURL('image/webp', 0.85);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('encode failed'))),
        'image/webp',
        0.85,
      ),
    );
    return { bytes: new Uint8Array(await blob.arrayBuffer()), url };
  } finally {
    bitmap.close();
  }
}
