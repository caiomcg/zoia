import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';

interface Question {
  message: string;
  confirmLabel: string;
  resolve: (yes: boolean) => void;
}

/**
 * An in-app "are you sure", in place of window.confirm. Electron on Windows
 * leaves text fields unable to take focus after a native dialog closes, so
 * the message box stopped responding to clicks after a deletion was
 * confirmed. This one is part of the page, and gives the focus back to
 * wherever it was.
 *
 * `confirm` resolves to whether the person agreed; render `dialog` somewhere.
 */
export function useConfirm(): {
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [question, setQuestion] = useState<Question | null>(null);
  const confirm = useCallback(
    (message: string, confirmLabel: string) =>
      new Promise<boolean>((resolve) => setQuestion({ message, confirmLabel, resolve })),
    [],
  );
  const answer = (yes: boolean) => {
    question?.resolve(yes);
    setQuestion(null);
  };
  return {
    confirm,
    dialog: question ? (
      <ConfirmDialog
        message={question.message}
        confirmLabel={question.confirmLabel}
        onAnswer={answer}
      />
    ) : null,
  };
}

function ConfirmDialog({
  message,
  confirmLabel,
  onAnswer,
}: {
  message: string;
  confirmLabel: string;
  onAnswer: (yes: boolean) => void;
}) {
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Where the focus was, to give it back when the dialog closes.
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onAnswer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
    };
    // Once per question: onAnswer is a new function every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="picker-backdrop" onClick={() => onAnswer(false)}>
      <section
        className="picker confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={message}
        onClick={(event) => event.stopPropagation()}
      >
        <p>{message}</p>
        <div className="confirm-actions">
          <button type="button" onClick={() => onAnswer(false)}>
            {t('common.cancel')}
          </button>
          <button type="button" ref={confirmRef} className="danger" onClick={() => onAnswer(true)}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
