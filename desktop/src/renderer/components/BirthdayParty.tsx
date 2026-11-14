import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

/** Pieces of confetti thrown: enough to fill the window, few enough to stay smooth. */
const PIECES = 90;
const COLORS = ['#ff5c8a', '#ffc93c', '#4ade80', '#38bdf8', '#a78bfa', '#fb923c'];
/** How long the party stays before it tidies itself away. */
const PARTY_MS = 9000;

/**
 * Someone's birthday (ADR 0055): confetti over the whole window and a card
 * that says whose. Unlike every other notification it does not wait under
 * the bell: it is a party. Yours reads "Happy birthday"; anyone else's says
 * whose it is. A click anywhere or Escape ends it, and it ends itself.
 */
export default function BirthdayParty({
  name,
  mine,
  onClose,
}: {
  name: string;
  /** It is the person at this machine's own birthday. */
  mine: boolean;
  onClose: () => void;
}) {
  const t = useT();
  // Thrown once per party; random so no two look alike.
  const pieces = useMemo(
    () =>
      Array.from({ length: PIECES }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 1.8,
        duration: 3.2 + Math.random() * 2.6,
        drift: (Math.random() - 0.5) * 220,
        spin: (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 720),
        color: COLORS[i % COLORS.length],
        round: i % 3 === 0,
      })),
    [],
  );

  useEffect(() => {
    const timer = setTimeout(onClose, PARTY_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
    // Once per party: onClose is a new function every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="birthday-party" role="alertdialog" aria-live="assertive" onClick={onClose}>
      <div className="birthday-confetti" aria-hidden="true">
        {pieces.map((p, i) => (
          <span
            key={i}
            className={p.round ? 'round' : undefined}
            style={
              {
                left: `${p.left}%`,
                background: p.color,
                animationDelay: `${p.delay}s`,
                animationDuration: `${p.duration}s`,
                '--drift': `${p.drift}px`,
                '--spin': `${p.spin}deg`,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
      <div className="birthday-card" onClick={(event) => event.stopPropagation()}>
        {/* An image, not emoji: it looks the same whatever fonts the system has. */}
        <img
          className="birthday-card-parrot"
          src="birthday-parrot.gif"
          alt=""
          width={96}
          height={96}
          draggable={false}
        />
        <h2>
          {mine ? t('birthday.party.mineTitle', { name }) : t('birthday.party.title', { name })}
        </h2>
        <p>{mine ? t('birthday.party.mineBody') : t('birthday.party.body', { name })}</p>
        <button type="button" className="primary" onClick={onClose} autoFocus>
          {mine ? t('birthday.party.mineThanks') : t('birthday.party.cheer')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
