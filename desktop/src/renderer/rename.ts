/**
 * An admin renaming someone else (Settings › Accounts, or right-clicking them
 * in People). The server decides; this is only what the dialog checks before
 * asking, and the words for a refusal.
 */

import type { T } from './i18n';

/** The longest display name, as the server enforces it (server/src/names.js). */
export const MAX_NAME_LENGTH = 32;

/**
 * The name to send, or `null` when there is nothing to ask the server:
 * empty once trimmed, or the name they already have.
 */
export function nameToSend(typed: string, current: string): string | null {
  const name = typed.trim();
  if (!name || name === current) return null;
  return name;
}

/**
 * Words for a rename that was refused. A taken name is what someone will run
 * into and can fix; anything else (not allowed to rename them, an empty
 * name) is shown with its code, as other admin failures are.
 */
export function renameError(t: T, code: string): string {
  if (code === 'name_taken') return t('profile.nameTaken');
  return t('admin.actionFailed', { code });
}
