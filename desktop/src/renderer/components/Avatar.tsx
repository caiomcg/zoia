import { useState } from 'react';
import { useAvatarImage } from '../avatars';

/**
 * A person's initials on a stable colour. Used in the member list and on the
 * broadcast thumbnails, so a sharer looks the same in both places. With an
 * `image` it shows that instead, and falls back to the initials if the image
 * cannot be loaded (offline, say). With an `identity` it shows that person's
 * profile picture, when they have set one (see avatars.ts).
 */

/** Stable per-person colour, so the same person keeps the same avatar. */
function avatarHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export default function Avatar({
  name,
  live,
  image,
  identity,
}: {
  name: string;
  live: boolean;
  image?: string;
  /** Whose profile picture to show; `image`, when given, wins. */
  identity?: string;
}) {
  const stored = useAvatarImage(image ? undefined : identity);
  const src = image ?? stored;
  // Remembers which image failed, so a new one gets its own chance.
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      className={`avatar${live ? ' live' : ''}`}
      style={{ background: `hsl(${avatarHue(name)} 45% 32%)` }}
      aria-hidden="true"
    >
      {src && failed !== src ? (
        <img src={src} alt="" draggable={false} onError={() => setFailed(src)} />
      ) : (
        initials(name)
      )}
    </span>
  );
}
