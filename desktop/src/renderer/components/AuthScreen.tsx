import { useState } from 'react';
import type { AuthOutcome, PairingStatus } from '../../shared/ipc';
import { isStrongPassword } from '../../shared/password';
import PasswordRules from './PasswordRules';
import { authError } from '../account-errors';
import { useT } from '../i18n';

type Mode = 'signIn' | 'signUp' | 'code';

/**
 * Before this machine is signed in: sign in, create an account, or use a code
 * an admin sent. See ADR 0031.
 *
 * The server address is a field rather than something buried in a file,
 * because it is now the only thing anyone has to be told. It starts filled in
 * from wherever this copy last pointed — an earlier sign-in, or the build —
 * and is checked in the main process, which refuses plain http anywhere but
 * this machine.
 */
export default function AuthScreen({
  status,
  onSignedIn,
}: {
  status: PairingStatus;
  onSignedIn: (status: PairingStatus) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('signIn');
  const [server, setServer] = useState(status.serverUrl ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(status.error);

  function switchTo(next: Mode) {
    setMode(next);
    setError(null);
    setPassword('');
    setConfirm('');
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (mode !== 'signIn' && !isStrongPassword(password)) {
      setError(authError(t, 'weak_password'));
      return;
    }
    if (mode !== 'signIn' && password !== confirm) {
      setError(authError(t, 'mismatch'));
      return;
    }

    setBusy(true);
    setError(null);
    let outcome: AuthOutcome;
    try {
      outcome =
        mode === 'signIn'
          ? await window.zoia.account.signIn(server, email, password)
          : mode === 'signUp'
            ? await window.zoia.account.signUp(server, email, password)
            : await window.zoia.account.redeem(server, code, password);
    } catch {
      outcome = { ok: false, error: 'unreachable' };
    } finally {
      setBusy(false);
    }
    if (outcome.ok) onSignedIn(outcome.status);
    else setError(authError(t, outcome.error));
  }

  const title =
    mode === 'signIn'
      ? t('auth.signInTitle')
      : mode === 'signUp'
        ? t('auth.signUpTitle')
        : t('auth.codeTitle');
  const body =
    mode === 'signIn'
      ? t('auth.signInBody')
      : mode === 'signUp'
        ? t('auth.signUpBody')
        : t('auth.codeBody');
  const action =
    mode === 'signIn'
      ? t('auth.signIn')
      : mode === 'signUp'
        ? t('auth.signUp')
        : t('auth.setPassword');

  return (
    <main className="pairing">
      <form className="pairing-card" onSubmit={(event) => void submit(event)}>
        <img className="pairing-logo" src="logo.png" alt="Zoia" draggable={false} />
        <h1>{title}</h1>
        <p className="muted">{body}</p>

        <label htmlFor="auth-server">{t('auth.server')}</label>
        {/* Text, not url: a url field refuses an address without https://,
            which is the one that should just work. The main process adds it. */}
        <input
          id="auth-server"
          type="text"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={t('auth.serverPlaceholder')}
          value={server}
          onChange={(e) => setServer(e.target.value)}
          disabled={busy}
          required
        />

        {mode === 'code' && (
          <>
            <label htmlFor="auth-code">{t('auth.code')}</label>
            <input
              id="auth-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              autoComplete="one-time-code"
              spellCheck={false}
              required
            />
          </>
        )}

        {mode !== 'code' && (
          <>
            <label htmlFor="auth-email">{t('auth.email')}</label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              autoComplete="email"
              required
            />
          </>
        )}

        <label htmlFor="auth-password">
          {mode === 'code' ? t('auth.newPassword') : t('auth.password')}
        </label>
        <input
          id="auth-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
          required
        />
        {mode !== 'signIn' && <PasswordRules password={password} />}

        {mode !== 'signIn' && (
          <>
            <label htmlFor="auth-confirm">{t('auth.confirmPassword')}</label>
            <input
              id="auth-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
              required
            />
          </>
        )}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? t('auth.working') : action}
        </button>

        {mode !== 'signIn' && (
          <button type="button" className="link" onClick={() => switchTo('signIn')} disabled={busy}>
            {t('auth.toSignIn')}
          </button>
        )}
        {mode !== 'signUp' && (
          <button type="button" className="link" onClick={() => switchTo('signUp')} disabled={busy}>
            {t('auth.toSignUp')}
          </button>
        )}
        {mode !== 'code' && (
          <button type="button" className="link" onClick={() => switchTo('code')} disabled={busy}>
            {t('auth.toCode')}
          </button>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
