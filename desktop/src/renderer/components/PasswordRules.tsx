import { PASSWORD_MIN_LENGTH, PASSWORD_RULES, meetsRule } from '../../shared/password';
import { useT } from '../i18n';

/**
 * What a new password still needs, ticked off as it is typed. The server
 * checks the same rule (see src/shared/password.ts); this is so nobody has
 * to find out by being refused.
 */
export default function PasswordRules({ password }: { password: string }) {
  const t = useT();
  return (
    <ul className="password-rules">
      {PASSWORD_RULES.map((rule) => {
        const met = meetsRule(password, rule);
        return (
          <li key={rule} className={met ? 'met' : undefined}>
            <span aria-hidden="true">{met ? '✓' : '•'}</span>
            {t(`auth.rule.${rule}`, { min: PASSWORD_MIN_LENGTH })}
          </li>
        );
      })}
    </ul>
  );
}
