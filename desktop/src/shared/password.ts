/**
 * What a password needs. Must match `isValidPassword` in
 * server/src/accounts.js, which is what actually decides: this is so the app
 * can say what is missing while someone types, rather than after a refusal.
 *
 * Kept free of imports so `node --test` can load it directly.
 */

export const PASSWORD_MIN_LENGTH = 6;

export type PasswordRule = 'length' | 'upper' | 'lower' | 'digit' | 'symbol';

export const PASSWORD_RULES: readonly PasswordRule[] = [
  'length',
  'upper',
  'lower',
  'digit',
  'symbol',
];

const CHECKS: Record<PasswordRule, (password: string) => boolean> = {
  length: (p) => p.length >= PASSWORD_MIN_LENGTH,
  upper: (p) => /\p{Lu}/u.test(p),
  lower: (p) => /\p{Ll}/u.test(p),
  digit: (p) => /\p{Nd}/u.test(p),
  symbol: (p) => /[^\p{L}\p{N}]/u.test(p),
};

/** Whether a password meets one rule. */
export function meetsRule(password: string, rule: PasswordRule): boolean {
  return CHECKS[rule](password);
}

/** Whether a password meets them all. */
export function isStrongPassword(password: string): boolean {
  return PASSWORD_RULES.every((rule) => meetsRule(password, rule));
}
