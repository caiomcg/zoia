/**
 * What is behind you on camera (ADR 0053): left as it is, blurred, or
 * replaced by a picture. Chosen in the camera dialog and remembered on this
 * machine; the picture someone uploads stays here too, never on the server.
 *
 * Kept free of imports so `node --test` can load it directly; the effect
 * itself is in background-effect.ts.
 */

export type BlurStrength = 'light' | 'strong';

export type CameraBackground =
  | { kind: 'none' }
  | { kind: 'blur'; strength: BlurStrength }
  /** `image` is a preset's id, or CUSTOM_IMAGE for the one uploaded here. */
  | { kind: 'image'; image: string };

export const NO_BACKGROUND: CameraBackground = { kind: 'none' };

/** Where the choice is remembered. */
export const BACKGROUND_KEY = 'zoia.camera.background';

/** Where the uploaded picture is kept, as a JPEG data URL. */
export const CUSTOM_IMAGE_KEY = 'zoia.camera.backgroundImage';

/** The id of the uploaded picture among the images. */
export const CUSTOM_IMAGE = 'custom';

/**
 * The blur's radius for each strength. The segmenter works on a downscaled
 * frame, so these are smaller than they look: 10 is the library's default.
 */
export const BLUR_RADIUS: Record<BlurStrength, number> = { light: 8, strong: 20 };

/** The pictures that come with Zoia, drawn as gradients: no files to ship. */
export const PRESETS: ReadonlyArray<{ id: string; colors: readonly [string, string, string] }> = [
  { id: 'dusk', colors: ['#1d2b64', '#6a3093', '#f8cdda'] },
  { id: 'ocean', colors: ['#0f2027', '#2c5364', '#4ca1af'] },
  { id: 'forest', colors: ['#0b3d2e', '#2f7a4f', '#a8e063'] },
  { id: 'studio', colors: ['#232526', '#414345', '#6b6e70'] },
];

/**
 * The remembered choice, or none. Anything this version does not know, such
 * as a preset since removed, is none rather than an error: the camera must
 * start whatever is in storage.
 */
export function parseBackground(raw: string | null | undefined): CameraBackground {
  if (!raw) return NO_BACKGROUND;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NO_BACKGROUND;
  }
  if (!value || typeof value !== 'object') return NO_BACKGROUND;
  const v = value as Record<string, unknown>;
  if (v.kind === 'blur' && (v.strength === 'light' || v.strength === 'strong')) {
    return { kind: 'blur', strength: v.strength };
  }
  if (
    v.kind === 'image' &&
    typeof v.image === 'string' &&
    (v.image === CUSTOM_IMAGE || PRESETS.some((p) => p.id === v.image))
  ) {
    return { kind: 'image', image: v.image };
  }
  return NO_BACKGROUND;
}

export function serializeBackground(background: CameraBackground): string {
  return JSON.stringify(background);
}

export function sameBackground(a: CameraBackground, b: CameraBackground): boolean {
  return serializeBackground(a) === serializeBackground(b);
}

/**
 * The size an uploaded picture is scaled to fit inside, keeping its shape:
 * the camera goes out at up to 720p, so anything larger only costs storage.
 */
export function fitWithin(
  width: number,
  height: number,
  maxWidth = 1280,
  maxHeight = 720,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
