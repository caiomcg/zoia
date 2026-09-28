import {
  LANGUAGES,
  LANGUAGE_NAMES,
  type Language,
  type LanguagePreference,
} from '../../shared/i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLanguage, useT } from '../i18n';
import { useExit } from '../presence';

/**
 * The language choice as a dropdown that can show flags: a native select
 * cannot, and Windows renders flag emoji as bare letters ("BR"), so the flags
 * are drawn here. Each language is named in itself, so it is findable
 * whatever is showing now. The list scrolls, so more languages keep it small.
 */
export default function LanguagePicker() {
  const t = useT();
  const { preference, system, setPreference } = useLanguage();
  const [open, setOpen] = useState(false);
  const list = useExit(open);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const options: Option[] = [
    {
      value: 'system',
      icon: <IconSystem />,
      name: t('general.languageSystemShort'),
      detail: LANGUAGE_NAMES[system],
    },
    ...LANGUAGES.map((language) => ({
      value: language,
      icon: <Flag language={language} />,
      name: LANGUAGE_NAMES[language],
    })),
  ];
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === preference),
  );
  const selected = options[selectedIndex]!;

  // A click anywhere else closes it, as a native select would.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  function openList() {
    setActive(selectedIndex);
    setOpen(true);
  }

  function choose(value: LanguagePreference) {
    setOpen(false);
    buttonRef.current?.focus();
    void setPreference(value).catch(() => {});
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(options.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(options[active]!.value);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div className="language-picker" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className={`language-trigger${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('general.language')}
        title={
          preference === 'system'
            ? t('general.languageSystem', { language: LANGUAGE_NAMES[system] })
            : undefined
        }
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <OptionContent option={selected} />
        <svg className="language-chevron" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {list.mounted && (
        <ul
          className={`language-list${list.closing ? ' closing' : ''}`}
          role="listbox"
          aria-label={t('general.language')}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === preference}
              className={`language-option${index === active ? ' active' : ''}${
                option.value === preference ? ' selected' : ''
              }`}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(option.value)}
            >
              <OptionContent option={option} />
              {option.value === preference && (
                <svg className="language-check" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Option {
  value: LanguagePreference;
  icon: ReactNode;
  name: string;
  detail?: string;
}

function OptionContent({ option }: { option: Option }) {
  return (
    <>
      <span className={`language-icon${option.value === 'system' ? ' system' : ''}`}>
        {option.icon}
      </span>
      <span className="language-name">{option.name}</span>
      {option.detail && <span className="language-detail">{option.detail}</span>}
    </>
  );
}

/** Simplified flags, drawn at 24×16: legible at this size, and never letters. */
function Flag({ language }: { language: Language }) {
  if (language === 'pt') {
    // Brazil: the variety of Portuguese Zoia speaks.
    return (
      <svg viewBox="0 0 24 16" aria-hidden="true">
        <rect width="24" height="16" fill="#009c3b" />
        <path d="M12 2.2 21.4 8 12 13.8 2.6 8z" fill="#ffdf00" />
        <circle cx="12" cy="8" r="3.6" fill="#002776" />
        <path d="M8.6 7.2c2.2-.5 4.6-.2 6.7.9" stroke="#fff" strokeWidth="0.7" fill="none" />
      </svg>
    );
  }
  if (language === 'es') {
    return (
      <svg viewBox="0 0 24 16" aria-hidden="true">
        <rect width="24" height="16" fill="#aa151b" />
        <rect y="4" width="24" height="8" fill="#f1bf00" />
      </svg>
    );
  }
  // English: the United States, simplified to stripes and a canton.
  return (
    <svg viewBox="0 0 24 16" aria-hidden="true">
      <rect width="24" height="16" fill="#fff" />
      {[0, 2, 4, 6, 8, 10, 12].map((row) => (
        <rect key={row} y={(row * 16) / 13} width="24" height={16 / 13} fill="#b22234" />
      ))}
      <rect width="10.4" height={(7 * 16) / 13} fill="#3c3b6e" />
    </svg>
  );
}

function IconSystem() {
  return (
    <svg
      viewBox="0 0 24 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="1" width="16" height="10.5" rx="1.5" />
      <path d="M9 15h6M12 11.5V15" />
    </svg>
  );
}
