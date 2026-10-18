/**
 * Words for the codes account requests come back with. The server's codes
 * are stable and few; anything else is shown as a generic failure with the
 * code in it, which is what someone can pass on when asking for help.
 */

import { PASSWORD_MIN_LENGTH } from '../shared/password';
import type { MessageKey } from '../shared/i18n';
import type { T } from './i18n';

const KNOWN = new Set([
  'invalid_login',
  'too_many_attempts',
  'account_disabled',
  'invalid_email',
  'weak_password',
  'email_taken',
  'signup_closed',
  'invalid_code',
  'invalid_server',
  'unreachable',
  'accounts_not_configured',
  'mismatch',
]);

/**
 * What a server from before accounts answers: its login only takes invite
 * keys, and it has no sign-up route at all. Either way the server is the
 * problem, not what was typed.
 */
const FROM_BEFORE_ACCOUNTS: Record<string, string> = {
  invalid_key: 'accounts_not_configured',
  http_404: 'accounts_not_configured',
};

export function authError(t: T, raw: string): string {
  const code = FROM_BEFORE_ACCOUNTS[raw] ?? raw;
  if (!KNOWN.has(code)) return t('auth.error.generic', { code });
  return t(`auth.error.${code}` as MessageKey, { min: PASSWORD_MIN_LENGTH });
}
