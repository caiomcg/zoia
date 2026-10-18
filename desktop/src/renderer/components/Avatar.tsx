import { useState } from 'react';
import type { AccountRole } from '../../shared/ipc';
import { useAvatarImage } from '../avatars';
import { useT } from '../i18n';

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

/**
 * A small crown on the picture's top-right corner: silver for an admin, gold
 * for the super admin. Tilted, as a crown worn at an angle, and outlined so
 * it reads on any picture.
 */
function Crown({ role }: { role: 'admin' | 'super_admin' }) {
  const t = useT();
  return (
    <svg
      className={`avatar-crown ${role}`}
      viewBox="0 0 24 18"
      role="img"
      aria-label={t(`account.role.${role}`)}
    >
      <title>{t(`account.role.${role}`)}</title>
      <path d="M2 6l5.5 4.5L12 2l4.5 8.5L22 6l-2.5 10h-15z" strokeLinejoin="round" />
    </svg>
  );
}

export default function Avatar({
  name,
  live,
  image,
  identity,
  role,
}: {
  name: string;
  live: boolean;
  image?: string;
  /** Whose profile picture to show; `image`, when given, wins. */
  identity?: string;
  /** An admin or the super admin wears a crown; anyone else nothing. */
  role?: AccountRole;
}) {
  const stored = useAvatarImage(image ? undefined : identity);
  const src = image ?? stored;
  // Remembers which image failed, so a new one gets its own chance.
  const [failed, setFailed] = useState<string | null>(null);
  const picture = (
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
  if (role !== 'admin' && role !== 'super_admin') return picture;
  // Outside the circle, which clips whatever is inside it.
  return (
    <span className="avatar-crowned">
      {picture}
      <Crown role={role} />
    </span>
  );
}
