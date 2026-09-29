/**
 * Display names are unique on a server: two people called the same thing in
 * the member list are indistinguishable, and that is exactly what happened
 * when everyone picked the same nick.
 *
 * "The same" is judged the way a person reads the list, not byte for byte:
 * case, accents, repeated spaces and invisible characters do not make a name
 * different, so "Flavi", "flávi " and "FLAVI" are one name.
 */

/** The longest display name, as /api/name enforces. */
export const MAX_NAME_LENGTH = 32;

/** What two names are compared by. */
export function nameKey(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * `name` itself when it is free, else the first of "name 2", "name 3", …
 * that is, shortened if need be so the number still fits.
 */
export function uniqueName(name, isTaken, max = MAX_NAME_LENGTH) {
  if (!isTaken(name)) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const candidate = `${name.slice(0, Math.max(1, max - suffix.length)).trimEnd()}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
}
