import type { Paise } from '@/types/domain';

/**
 * Paise → display rupees. This is the ONLY place division by 100 happens.
 * Keeping it in one function is what stops a float sneaking into a total
 * somewhere upstream and quietly costing a merchant a rupee.
 */
export function rupees(p: Paise, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const negative = p < 0;
  const abs = Math.abs(p);

  const body = opts.compact && abs >= 10_000_00
    ? `${(abs / 100_000_0).toFixed(1)}L`          // ₹1.2L
    : (abs / 100).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

  const prefix = negative ? '−' : opts.sign ? '+' : '';
  return `${prefix}₹${body}`;
}

/** Bare rupee number, no symbol — for chart axes. */
export function rupeeValue(p: Paise): number {
  return p / 100;
}

export function percent(n: number | null, digits = 1): string {
  if (n === null || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function shortId(id: string, keep = 8): string {
  return id.length <= keep ? id : `${id.slice(0, keep)}…`;
}

export function timeIST(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

export function dateIST(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Square-root scale for the delta gutter.
 *
 * A linear scale lets one ₹40,000 break flatten every ₹80 variance into
 * a sub-pixel smear — and the small ones are exactly what a reconciler
 * would otherwise miss. sqrt keeps big breaks visibly biggest while
 * leaving small ones legible.
 */
export function gutterWidth(delta: Paise, maxAbsDelta: Paise): number {
  if (maxAbsDelta === 0) return 0;
  const ratio = Math.abs(delta) / maxAbsDelta;
  return Math.sqrt(ratio) * 100; // percent of half-gutter
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
