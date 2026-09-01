import type {
  LedgerRow,
  ReconSummary,
  RecoveryRun,
  EvalSummary,
  AuditEntry,
  ChainVerification,
  GateTrace,
  Intervention,
  FailureReason,
} from '@/types/domain';
import { fixtures } from './fixtures';

/**
 * API client.
 *
 * Every call degrades to a local fixture when the backend is unreachable,
 * and says so via `source`. This is deliberate: a reviewer who clones the
 * repo and runs `npm run dev` sees a working console immediately, and the
 * banner tells them plainly they are looking at fixture data rather than
 * a live run. Silently showing fake numbers as if they were real is the
 * one thing this project's whole citation discipline exists to prevent.
 */

export type Source = 'live' | 'fixture';

export interface Envelope<T> {
  data: T;
  source: Source;
  /** Present when live failed — shown in the banner, not swallowed. */
  reason?: string;
}

const TIMEOUT_MS = 4000;

async function get<T>(path: string, fallback: T): Promise<Envelope<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`/api${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: (await res.json()) as T, source: 'live' };
  } catch (err) {
    return {
      data: fallback,
      source: 'fixture',
      reason: err instanceof Error ? err.message : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function post<T, B>(path: string, body: B, fallback: T): Promise<Envelope<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: (await res.json()) as T, source: 'live' };
  } catch (err) {
    return {
      data: fallback,
      source: 'fixture',
      reason: err instanceof Error ? err.message : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- Reconciliation ---------------- */

export const fetchLedger = () =>
  get<{ rows: LedgerRow[]; summary: ReconSummary }>('/recon', {
    rows: fixtures.ledgerRows,
    summary: fixtures.reconSummary,
  });

/* ---------------- Recovery ---------------- */

export const fetchRecovery = () => get<RecoveryRun>('/recover', fixtures.recoveryRun);

export const fetchEval = () => get<EvalSummary>('/eval', fixtures.evalSummary);

/* ---------------- Gates ---------------- */

export interface GateProbe {
  action: Intervention;
  amount_paise: number;
  attempts: number;
  failure_reason: FailureReason;
  hour_ist: number;
  minutes_since_last_attempt: number;
  do_not_contact: boolean;
  kill_switch: boolean;
  spend_so_far_run_paise: number;
  spend_cap_run_paise: number;
  approval_ceiling_paise: number;
}

/**
 * Server-side gate evaluation.
 *
 * The simulator falls back to a LOCAL re-implementation when offline
 * (see services/gateSim.ts) which mirrors gates.js. That local copy is a
 * teaching aid for the reviewer, not a second source of truth — the badge
 * on the panel says which one produced the verdict.
 */
export const evaluateGates = (probe: GateProbe, localFallback: GateTrace) =>
  post<GateTrace, GateProbe>('/gates/evaluate', probe, localFallback);

/* ---------------- Audit ---------------- */

export const fetchAudit = (limit = 200) =>
  get<{ entries: AuditEntry[]; verification: ChainVerification }>(
    `/audit?limit=${limit}`,
    { entries: fixtures.auditEntries, verification: fixtures.chainVerification },
  );
