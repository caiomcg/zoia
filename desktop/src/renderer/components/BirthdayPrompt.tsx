import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { isRealBirthday } from '../schedule/birthday';
import BirthdayField, { type BirthdayDraft } from './BirthdayField';

/**
 * Asks someone from before birthdays for theirs (ADR 0055). It may be put off
 * with "Later", and then comes back at the next sign-in, for as long as the
 * server has none. Saving updates the session, which takes it away for good.
 * It closes only by one of those two buttons: not by a click outside it, nor
 * by Escape, so the question is not dismissed by accident.
 */
export default function BirthdayPrompt({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [value, setValue] = useState<BirthdayDraft>({ day: null, month: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    formRef.current?.querySelector('select')?.focus();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!isRealBirthday(value)) {
      setError(t('birthday.error.invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await window.zoia.account.setBirthday(value);
      if (!outcome.ok) {
        setError(
          outcome.error === 'invalid_birthday'
            ? t('birthday.error.invalid')
            : t('birthday.error.failed'),
        );
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="picker-backdrop">
      <form
        ref={formRef}
        className="picker confirm-dialog birthday-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="birthday-prompt-title"
        onSubmit={(event) => void save(event)}
      >
        {/* The party's parrot, as an image so it shows whatever fonts the system has. */}
        <img
          className="birthday-prompt-parrot"
          src="birthday-parrot.gif"
          alt=""
          width={64}
          height={64}
          draggable={false}
        />
        <h3 id="birthday-prompt-title">{t('birthday.prompt.title')}</h3>
        <p className="muted">{t('birthday.prompt.body')}</p>
        <BirthdayField id="birthday-prompt-day" value={value} onChange={setValue} disabled={busy} />
        {error && <p className="settings-error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" onClick={onClose}>
            {t('common.later')}
          </button>
          <button type="submit" className="primary" disabled={busy || !isRealBirthday(value)}>
            {t('settings.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
