import { useEffect, useRef, useState } from 'react';

/**
 * Count a hero figure up to its final value, the way a mechanical counter
 * settles. Used in exactly two places — the tie-out total and the net-delta
 * — because animating every number makes a page feel busy rather than
 * considered. Respects prefers-reduced-motion by snapping straight to the end.
 */
export function useCountUp(target: number, durationMs = 700): number {
  const [value, setValue] = useState(0);
  const frame = useRef<number>();

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || durationMs === 0) { setValue(target); return; }

    const start = performance.now();
    const from = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutCubic — fast at first, settles gently, like a counter wheel.
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + (target - from) * eased);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => { if (frame.current) cancelAnimationFrame(frame.current); };
  }, [target, durationMs]);

  return value;
}
