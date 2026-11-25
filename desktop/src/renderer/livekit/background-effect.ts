/**
 * Applies a camera background (camera-background.ts) to a camera track, with
 * LiveKit's background processor: MediaPipe's selfie segmenter finds the
 * person, on the GPU, and the rest is blurred or replaced. It runs here, on
 * the sender, so viewers (Android included) get the finished picture and need
 * nothing new (ADR 0053).
 *
 * The segmenter's runtime and model are served beside the page, not from a
 * CDN: see mediapipeWasm() in electron.vite.config.ts and
 * public/mediapipe/selfie_segmenter.tflite.
 */

import type { LocalVideoTrack } from 'livekit-client';
import {
  BackgroundProcessor,
  supportsBackgroundProcessors,
  type BackgroundProcessorWrapper,
  type SwitchBackgroundProcessorOptions,
} from '@livekit/track-processors';
import {
  BACKGROUND_KEY,
  BLUR_RADIUS,
  CUSTOM_IMAGE,
  CUSTOM_IMAGE_KEY,
  NO_BACKGROUND,
  PRESETS,
  fitWithin,
  parseBackground,
  serializeBackground,
  type CameraBackground,
} from './camera-background';

/** The background chosen last time, or none if its picture is gone since. */
export function rememberedBackground(): CameraBackground {
  try {
    const background = parseBackground(localStorage.getItem(BACKGROUND_KEY));
    if (background.kind === 'image' && !backgroundImage(background.image)) return NO_BACKGROUND;
    return background;
  } catch {
    return NO_BACKGROUND;
  }
}

export function rememberBackground(background: CameraBackground): void {
  try {
    localStorage.setItem(BACKGROUND_KEY, serializeBackground(background));
  } catch {
    // Not remembered; it still applies this time.
  }
}

/** Whether this machine can run the effect: WebGL2 and frame access. */
export function backgroundEffectsSupported(): boolean {
  try {
    return supportsBackgroundProcessors();
  } catch {
    return false;
  }
}

const assetUrl = (path: string) => new URL(path, document.baseURI).href;

// Drawn once per preset and kept: the processor reloads an image only when
// its path changes, so the same data URL each time costs nothing.
const presetCache = new Map<string, string>();

/** A preset drawn as a diagonal gradient, as a data URL. */
export function presetImage(id: string): string | null {
  const cached = presetCache.get(id);
  if (cached) return cached;
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  preset.colors.forEach((color, i) => gradient.addColorStop(i / (preset.colors.length - 1), color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.9);
  presetCache.set(id, url);
  return url;
}

export function customImage(): string | null {
  try {
    return localStorage.getItem(CUSTOM_IMAGE_KEY);
  } catch {
    return null;
  }
}

/** The picture behind an image background, or null if it is gone. */
export function backgroundImage(image: string): string | null {
  return image === CUSTOM_IMAGE ? customImage() : presetImage(image);
}

/** What the processor is told for a background; null is no processor at all. */
function processorOptions(background: CameraBackground): SwitchBackgroundProcessorOptions | null {
  if (background.kind === 'blur') {
    return { mode: 'background-blur', blurRadius: BLUR_RADIUS[background.strength] };
  }
  if (background.kind === 'image') {
    const imagePath = backgroundImage(background.image);
    return imagePath ? { mode: 'virtual-background', imagePath } : null;
  }
  return null;
}

/**
 * Puts the background on the track, published or not: a published one has
 * its sender switched over, with no renegotiation. Switching between effects
 * reuses the running processor, so the segmenter is not loaded again and the
 * picture does not flash. None removes the processor and sends the camera as
 * it is.
 */
export async function applyBackground(
  track: LocalVideoTrack,
  background: CameraBackground,
): Promise<void> {
  const options = processorOptions(background);
  const current = track.getProcessor() as BackgroundProcessorWrapper | undefined;
  if (!options || !backgroundEffectsSupported()) {
    if (current) await track.stopProcessor();
    return;
  }
  if (current && typeof current.switchTo === 'function') {
    await current.switchTo(options);
    return;
  }
  await track.setProcessor(
    BackgroundProcessor({
      ...options,
      assetPaths: {
        tasksVisionFileSet: assetUrl('mediapipe/wasm'),
        modelAssetPath: assetUrl('mediapipe/selfie_segmenter.tflite'),
      },
    }),
  );
  // A camera is moving video; the processed track is a new one, which does
  // not inherit the hint the camera's own track was given.
  const processed = track.getProcessor()?.processedTrack;
  if (processed) processed.contentHint = 'motion';
}

/**
 * A picture someone chose, scaled to fit 1280×720 and kept as a JPEG data
 * URL, which is what is remembered. Throws if it is not an image.
 */
export async function readBackgroundFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close();
  }
}
