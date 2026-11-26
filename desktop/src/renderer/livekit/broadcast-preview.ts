/**
 * Broadcast previews (ADR 0056): what people outside a channel see of a
 * broadcast before they join it.
 *
 * The broadcaster's app takes a small picture of what it shares now and then
 * and sends it to the server; everyone else fetches it, by version, from the
 * channel list. Nobody outside subscribes to the video itself, so a preview
 * costs the broadcaster one ~20 KB upload every PREVIEW_INTERVAL_MS, however
 * many people look.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { LocalVideoTrack } from 'livekit-client';

/** How often a live broadcast sends its picture. The server refuses faster than every 5 s. */
export const PREVIEW_INTERVAL_MS = 15_000;
/**
 * The first one, a moment after going live or switching source: the first
 * frames of a capture are often black or still the old window.
 */
const FIRST_PREVIEW_MS = 3_000;
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 180;
/** The server takes 64 KB; at this quality a busy 320×180 picture is ~25 KB. */
const PREVIEW_QUALITY = 0.7;
const GRAB_TIMEOUT_MS = 5_000;

/** One frame of a video track as a small JPEG, cropped to fill, or null. */
async function grabJpeg(track: MediaStreamTrack): Promise<Uint8Array | null> {
  if (typeof ImageCapture === 'undefined' || track.readyState !== 'live') return null;
  // Chromium implements grabFrame; TypeScript's DOM types stop at takePhoto.
  const capturer = new ImageCapture(track) as ImageCapture & {
    grabFrame(): Promise<ImageBitmap>;
  };
  const frame = await Promise.race([
    capturer.grabFrame(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), GRAB_TIMEOUT_MS)),
  ]).catch(() => null);
  if (!frame) return null;
  try {
    if (!frame.width || !frame.height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = PREVIEW_WIDTH;
    canvas.height = PREVIEW_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) return null;
    // Cover, like the in-channel thumbnails: crop rather than letterbox.
    const scale = Math.max(PREVIEW_WIDTH / frame.width, PREVIEW_HEIGHT / frame.height);
    const width = frame.width * scale;
    const height = frame.height * scale;
    context.drawImage(
      frame,
      (PREVIEW_WIDTH - width) / 2,
      (PREVIEW_HEIGHT - height) / 2,
      width,
      height,
    );
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', PREVIEW_QUALITY),
    );
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    frame.close();
  }
}

/**
 * While `track` is what you broadcast, sends its picture now and then. Pass
 * null when nothing is live: the server drops the last one when you stop.
 */
export function useBroadcastPreview(video: LocalVideoTrack | null): void {
  useEffect(() => {
    if (!video) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const send = async () => {
      // What viewers receive, resolved at each grab: a camera with a
      // background effect (ADR 0053) goes out processed, and its
      // mediaStreamTrack is still the raw room behind you.
      const shown = video.getProcessor()?.processedTrack ?? video.mediaStreamTrack;
      const bytes = await grabJpeg(shown).catch(() => null);
      if (stopped) return;
      // A refusal (the slot not granted yet, the server busy) is not worth
      // reporting: the next one tries again.
      if (bytes) await window.zoia.stage.preview(bytes).catch(() => false);
      if (!stopped) timer = setTimeout(send, PREVIEW_INTERVAL_MS);
    };
    timer = setTimeout(send, FIRST_PREVIEW_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [video]);
}

// Fetched pictures by `${room}:${identity}:${version}`; null means "none".
// Only the latest per broadcaster is worth keeping.
const pictures = new Map<string, string | null>();
const latest = new Map<string, string>();
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

function load(room: string, identity: string, version: string, key: string) {
  if (pictures.has(key) || pending.has(key)) return;
  pending.add(key);
  window.zoia.rooms
    .preview(room, identity, version)
    .then((picture) => {
      const owner = `${room}:${identity}`;
      const previous = latest.get(owner);
      if (previous && previous !== key) pictures.delete(previous);
      latest.set(owner, key);
      pictures.set(key, picture);
      emit();
    })
    .catch(() => {
      // Unreachable for now: the next version tries again.
    })
    .finally(() => pending.delete(key));
}

/**
 * Someone's broadcast picture in another channel, or null while it loads or
 * when there is none. Until a new version arrives, the last one stands in,
 * so the card does not blink empty every fifteen seconds.
 */
export function useRoomPreview(
  room: string,
  identity: string,
  version: string | undefined,
): string | null {
  useSyncExternalStore(subscribe, () => revision);
  const key = version ? `${room}:${identity}:${version}` : null;
  useEffect(() => {
    if (key && version) load(room, identity, version, key);
  }, [key, room, identity, version]);
  if (!key) return null;
  if (pictures.has(key)) return pictures.get(key) ?? null;
  const shown = latest.get(`${room}:${identity}`);
  return shown ? (pictures.get(shown) ?? null) : null;
}
