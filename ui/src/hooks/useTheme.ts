import { useCallback, useEffect, useState } from 'react';

export type Theme = 'paper' | 'night';

/**
 * Theme lives in the URL (?theme=night), not localStorage.
 *
 * These pages get opened three ways: `npm run dev`, a static build served
 * from a CDN, and as a standalone file a reviewer double-clicks. A URL
 * parameter behaves identically in all three; localStorage does not, and a
 * file:// page cannot always reach it at all.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const p = new URLSearchParams(window.location.search).get('theme');
    if (p === 'night' || p === 'paper') return p;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'paper';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    const url = new URL(window.location.href);
    url.searchParams.set('theme', theme);
    window.history.replaceState({}, '', url);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'paper' ? 'night' : 'paper'));
  }, []);

  return { theme, toggle };
}
