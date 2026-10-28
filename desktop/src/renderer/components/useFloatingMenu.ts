/**
 * A menu at the pointer, as right-clicking someone opens: kept inside the
 * window, and closed by a click elsewhere, Escape, or the window losing
 * focus or size.
 */

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Where to draw the menu `ref` holds, opened at `x`, `y`. `contentKey`
 * changes when what it shows does, so a menu that grows is nudged in again:
 * a string or number, compared by value, never a fresh array or object.
 */
export function useFloatingMenu(
  ref: RefObject<HTMLElement | null>,
  x: number,
  y: number,
  onClose: () => void,
  contentKey: string | number = 0,
): { left: number; top: number } {
  const [place, setPlace] = useState({ left: x, top: y });

  // Measured once drawn, then nudged in.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(4, Math.min(x, window.innerWidth - box.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - box.height - 4));
    // Only a move re-renders: setting an equal place anew would loop.
    setPlace((current) => (current.left === left && current.top === top ? current : { left, top }));
  }, [ref, x, y, contentKey]);

  // The first control takes the focus, so the keyboard can carry on from there.
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, [ref, x, y]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [ref, onClose]);

  return place;
}
