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
  ChaosConcurrencyResult,
  BankFlapResult,
  NrvResult,
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

/** The full verdict from the real gates.js — not just the trace. */
export interface GateVerdict {
  trace: GateTrace;
  allowed: boolean;
  /** What actually runs: the gates may rewrite the proposal
   *  (DNC → ESCALATE_HUMAN, quiet hours → NO_ACTION). */
  finalAction: Intervention;
  estimatedCostPaise: number;
  idempotencyKey: string | null;
}

/**
 * Server-side gate evaluation.
 *
 * The simulator falls back to a LOCAL re-implementation when offline
 * (see services/gateSim.ts) which mirrors gates.js. That local copy is a
 * teaching aid for the reviewer, not a second source of truth — the badge
 * on the panel says which one produced the verdict.
 */
export const evaluateGates = (probe: GateProbe, localFallback: GateVerdict) =>
  post<GateVerdict, GateProbe>('/gates/evaluate', probe, localFallback);

/* ---------------- Audit ---------------- */

export const fetchAudit = (limit = 2000) =>
  get<{ entries: AuditEntry[]; verification: ChainVerification }>(
    `/audit?limit=${limit}`,
    { entries: fixtures.auditEntries, verification: fixtures.chainVerification },
  );

/* ---------------- Live providers (Razorpay Test Mode + Groq) ------- */

export interface ProviderInfo {
  configured: boolean;
  detail?: string;
  mode?: string;
  model?: string;
}

export interface ProvidersPayload {
  providers: {
    razorpay: ProviderInfo;
    groq: ProviderInfo;
  };
}

export const fetchProviders = () =>
  get<ProvidersPayload>('/providers', {
    providers: {
      razorpay: { configured: false, detail: 'provider status unavailable — backend not running' },
      groq: { configured: false, detail: 'provider status unavailable — backend not running' },
    },
  });

export interface DiagnoseInput {
  entity_id?: string;
  failure_reason: string;
  amount_paise: number;
  attempts: number;
  minutes_since_last_attempt: number;
  locale: string;
  dnc: boolean;
  hour_ist: number;
  kill_switch?: boolean;
  approval_ceiling_paise?: number;
}

export interface LlmVerdict {
  action: string;
  valid: boolean;
  model: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  degraded: string | null;
  raw?: string;
  advisory: true;
  agreesWithPolicy: boolean;
}

export interface DiagnoseVerdict {
  input: DiagnoseInput;
  policy: { proposed: string; authoritative: true };
  gates: {
    allowed: boolean;
    finalAction: string;
    estimatedCostPaise: number;
    trace: GateTrace;
  };
  llm: LlmVerdict | null;
  llmError: string | null;
  note: string;
}

export const runDiagnosis = (input: DiagnoseInput) =>
  post<DiagnoseVerdict, DiagnoseInput>('/llm/diagnose', input, {
    input,
    policy: { proposed: 'NO_ACTION', authoritative: true },
    gates: { allowed: false, finalAction: 'NO_ACTION', estimatedCostPaise: 0, trace: [] },
    llm: null,
    llmError: 'diagnosis unavailable — backend not running',
    note: 'fixture fallback',
  });

export interface LinkResult {
  ok: boolean;
  simulated: boolean;
  replayed: boolean;
  mode: string;
  link: { id: string; short_url: string; status: string; amount: number } | null;
  error: unknown;
  idempotency: string;
  note: string;
}

export const createTestLink = (body: { amount_paise: number; entity_id: string; attempt: number }) =>
  post<LinkResult, typeof body>('/rzp/link', body, {
    ok: false,
    simulated: false,
    replayed: false,
    mode: 'offline',
    link: null,
    error: null,
    idempotency: '',
    note: 'link creation unavailable — backend not running',
  });

export const pingRazorpay = () =>
  post<{ ok: boolean; simulated: boolean; mode: string; note: string; error: unknown }, Record<string, never>>(
    '/rzp/ping', {}, { ok: false, simulated: false, mode: 'offline', note: 'ping unavailable', error: null },
  );

/* ---------------- Chaos Lab ---------------- */

/**
 * The webhook-flood stress test. There is deliberately NO fixture
 * fallback with invented numbers here — the entire point of the demo
 * is that the locks are exercised live on the backend. Offline, the
 * panel says so and offers nothing else.
 */
export const runChaosConcurrency = (body: { workers?: number } = {}) =>
  post<ChaosConcurrencyResult, typeof body>('/simulate/chaos-concurrency', body, {
    scenario: 'chaos_concurrency',
    workers: 0,
    payment_id: '—',
    elapsed_ms: 0,
    results: [],
    summary: {
      inbound: 0, executed: 0, rejected_in_flight: 0, replayed_from_cache: 0,
      invariant_holds: false,
      invariant: 'unavailable — backend not running. Start the console server (npm run console) and re-run.',
    },
    audit_proof: { chain_valid: false, entries: 0, decision_entries: 0, head: '', note: 'offline' },
  });

export const runBankFlap = (body: { route?: string; failures?: number } = {}) =>
  post<BankFlapResult, typeof body>('/simulate/bank-flap', body, {
    scenario: 'bank_flap',
    route: '—',
    injected: 0,
    error_code: '',
    timeline: [],
    final: { route: '—', circuit: 'CLOSED', allowed: true, reason: 'unavailable — backend not running' },
    reroute: null,
    shared_state: { note: 'offline', stats: { open_routes: [], window_failures: 0, retries_suppressed: 0 } },
  });

export const runNrvSim = (body: {
  amount_paise: number;
  p_success: number;
  action: string;
  customer_ltv_paise: number;
  fatigue: number;
}) =>
  post<NrvResult, typeof body>('/simulate/nrv', body, {
    scenario: 'nrv',
    input: body,
    formula: 'unavailable — backend not running',
    channel_costs_inr: {},
    verdict: {
      nrv_paise: 0, margin_positive: false, verdict: 'VETO_NEGATIVE_MARGIN',
      breakdown: { expected_yield_paise: 0, channel_cost_paise: 0, churn_penalty_paise: 0 },
      reason: 'unavailable — backend not running. The NRV arithmetic needs the server-side gate.',
    },
    engine_note: 'offline',
  });

/** Triggers a browser download of the audit seal bundle (chain + merkle root). */
export async function downloadAuditSeal(runId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/audit/export?download=1');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `axiom-audit-seal-${runId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unreachable' };
  }
}
