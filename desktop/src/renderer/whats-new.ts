/**
 * Whether to open the release notes by themselves on this start: once, on the
 * first start of a version other than the one this machine last ran.
 */

export const LAST_VERSION_STORAGE_KEY = 'zoia.lastVersion';

/**
 * @param lastVersion The version this machine last ran, or null if unknown.
 * @param existingUser Whether this machine has used Zoia before. It matters
 *   only when there is no last version: the record is newer than some
 *   installations, and an update to the first version that keeps it is still
 *   an update, while a fresh install has nothing to catch up on.
 */
export function shouldShowReleaseNotes(
  lastVersion: string | null,
  currentVersion: string,
  existingUser: boolean,
): boolean {
  if (lastVersion === null) return existingUser;
  return lastVersion !== currentVersion;
}
