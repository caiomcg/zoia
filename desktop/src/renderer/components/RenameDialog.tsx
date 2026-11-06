import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { MAX_NAME_LENGTH, nameToSend, renameError } from '../rename';
import { useT } from '../i18n';

/**
 * An admin renaming someone: their name, ready to change, and Save. The
 * server checks it as it does your own (unique, 1 to 32 characters) and
 * whether you may rename them at all; a refusal is shown here and the dialog
 * stays open to try another. Everyone's app, theirs included, is told the new
 * name by the server.
 */
export default function RenameDialog({
  accountId,
  name,
  onDone,
  onClose,
}: {
  accountId: string;
  /** Their name now. */
  name: string;
  /** After the server took the new name. */
  onDone?: (name: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where the focus was, to give it back when the dialog closes.
  const returnTo = useRef<Element | null>(null);
  const trimmed = value.trim();

  useEffect(() => {
    returnTo.current = document.activeElement;
    inputRef.current?.select();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
    };
    // Once per dialog: onClose is a new function every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const next = nameToSend(value, name);
    if (!next) return onClose();
    setBusy(true);
    setError(null);
    try {
      const outcome = await window.zoia.admin.act(accountId, 'name', { name: next });
      if (!outcome.ok) {
        setError(renameError(t, outcome.error));
        return;
      }
      onDone?.(outcome.value.account?.name ?? next);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="picker-backdrop" onClick={onClose}>
      <form
        className="picker confirm-dialog rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('admin.renameTitle', { name })}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void save(event)}
      >
        <h3>{t('admin.renameTitle', { name })}</h3>
        <p className="muted">{t('admin.renameBody', { name })}</p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          maxLength={MAX_NAME_LENGTH}
          aria-label={t('profile.displayName')}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
        />
        {error && <p className="settings-error">{error}</p>}
        <div className="confirm-actions">
          <button type="button" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="primary" disabled={busy || !trimmed}>
            {t('settings.save')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
