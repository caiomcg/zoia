/**
 * The mouse wheel on a slider, which Chromium leaves alone: one step up or
 * down per notch, and the page around it does not scroll meanwhile.
 */

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Returns the ref for the range input. `onStep` gets +1 for the wheel turned
 * up, -1 for down, and is read fresh on each turn. A disabled slider ignores
 * the wheel, and the page scrolls as usual.
 */
export function useWheelRange(
  onStep: (direction: 1 | -1) => void,
): RefObject<HTMLInputElement | null> {
  const ref = useRef<HTMLInputElement>(null);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    // Not passive, as React's own wheel handler is: the page must not scroll.
    const onWheel = (event: WheelEvent) => {
      if (input.disabled || event.deltaY === 0) return;
      event.preventDefault();
      stepRef.current(event.deltaY < 0 ? 1 : -1);
    };
    input.addEventListener('wheel', onWheel, { passive: false });
    return () => input.removeEventListener('wheel', onWheel);
  }, []);

  return ref;
}
