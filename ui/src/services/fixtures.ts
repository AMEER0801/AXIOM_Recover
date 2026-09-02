import type {
  LedgerRow, ReconSummary, RecoveryRun, EvalSummary,
  AuditEntry, ChainVerification, LedgerVerdict, FailureReason,
  RecoveryRecord, RoundOutcome, Intervention, GateTrace,
} from '@/types/domain';
import { GATE_ORDER } from '@/types/domain';

/**
 * Fixtures.
 *
 * These numbers are copied from a real `npm run recover` / `npm run sweep`
 * output so the offline console shows the same figures the README reports.
 * They are LABELLED as fixtures everywhere they surface — the banner in
 * the header says so, and nothing here is ever presented as a live run.
 *
 * Generated deterministically from a fixed seed so two developers looking
 * at the offline console are looking at the same batch.
 */

// A tiny LCG — the point is reproducibility, not cryptographic quality.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const rnd = lcg(20260905);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const between = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo));

/* ------------------------- Ledger ------------------------- */

const VERDICT_MIX: { v: LedgerVerdict; weight: number; sev: 'none' | 'low' | 'high' }[] = [
  { v: 'exact',             weight: 62, sev: 'none' },
  { v: 'explained_split',   weight: 11, sev: 'none' },
  { v: 'explained_refund',  weight: 8,  sev: 'none' },
  { v: 'explained_fee',     weight: 9,  sev: 'low'  },
  { v: 'flagged_duplicate', weight: 4,  sev: 'high' },
  { v: 'unexplained',       weight: 4,  sev: 'high' },
  { v: 'orphan_credit',     weight: 2,  sev: 'high' },
];

const EXPLANATION: Record<LedgerVerdict, string> = {
  exact: 'Settles to the paisa.',
  explained_split: 'Settled across two bank batches; the two lines sum correctly.',
  explained_refund: 'Gap equals a refund already on file, deducted before settlement.',
  explained_fee: 'Pricing-plan variance. Still money the merchant did not receive — confirm the plan.',
  flagged_duplicate: 'Customer charged twice. Refund owed.',
  unexplained: 'Genuine break. No refund, split, or fee variance accounts for this.',
  orphan_credit: 'Money arrived with no payment behind it.',
};

function weightedVerdict() {
  const total = VERDICT_MIX.reduce((a, b) => a + b.weight, 0);
  let r = rnd() * total;
  for (const m of VERDICT_MIX) { if ((r -= m.weight) <= 0) return m; }
  return VERDICT_MIX[0];
}

const ledgerRows: LedgerRow[] = Array.from({ length: 120 }, (_, i) => {
  const m = weightedVerdict();
  const expected = between(19_900, 8_40_000);
  let delta = 0;
  if (m.v === 'explained_fee') delta = -between(140, 2_100);
  else if (m.v === 'unexplained') delta = -between(3_000, 41_000);
  else if (m.v === 'flagged_duplicate') delta = 0;
  else if (m.v === 'orphan_credit') delta = between(8_000, 60_000);

  const isDupe = m.v === 'flagged_duplicate';
  return {
    payment_id: `pay_R${(700000 + i * 37).toString(36).toUpperCase()}`,
    merchant_id: `acc_M${between(100, 140)}`,
    expected,
    actual: expected + delta,
    delta,
    verdict: m.v,
    severity: m.sev,
    explanation: EXPLANATION[m.v],
    pairRole: isDupe ? (i % 2 === 0 ? 'original' : 'duplicate') : undefined,
    settled_at: new Date(Date.UTC(2026, 7, 20 + (i % 5), 4 + (i % 12), (i * 7) % 60)).toISOString(),
  };
});

const gapTied = 0;
const gapExplainedOwed = ledgerRows
  .filter((r) => r.verdict === 'explained_fee')
  .reduce((a, r) => a + Math.abs(r.delta), 0);
const gapNeedsPerson = ledgerRows
  .filter((r) => r.severity === 'high')
  .reduce((a, r) => a + Math.abs(r.delta), 0);

const reconSummary: ReconSummary = {
  batch_id: 'seed-20260905',
  rows_examined: ledgerRows.length,
  gap_total: gapTied + gapExplainedOwed + gapNeedsPerson,
  gap_tied: gapTied,
  gap_explained_owed: gapExplainedOwed,
  gap_needs_person: gapNeedsPerson,
  precision: 1.0,
  recall: 1.0,
  explanation_accuracy: 0.983,
  reportable: true,
};

/* ------------------------- Recovery ------------------------- */

const REASONS: FailureReason[] = [
  'insufficient_funds', 'card_expired', 'soft_decline', 'hard_decline',
  'network_timeout', 'mandate_revoked', 'mandate_paused_by_customer',
  'mandate_paused_by_business', 'checkout_abandoned', 'invoice_overdue',
];

function trace(blockedGate?: string): GateTrace {
  return GATE_ORDER.map((g) => ({
    gate: g,
    blocked: g === blockedGate,
    detail: g === blockedGate ? 'Blocked in this scenario.' : 'Checked, nothing to block.',
  }));
}

function buildRecord(i: number): RecoveryRecord {
  const reason = REASONS[i % REASONS.length];
  const amount = between(29_900, 12_50_000);
  const roundCount = between(2, 8);
  const rounds = Array.from({ length: roundCount }, (_, r) => {
    const roll = rnd();
    let outcome: RoundOutcome = 'attempted';
    let proposed: Intervention = 'RETRY_CHARGE';
    let blockedBy: string | undefined;
    let cost = 0;

    if (reason === 'mandate_paused_by_business') {
      proposed = 'ESCALATE_HUMAN'; outcome = 'escalated';
    } else if (roll < 0.30 && r >= 2) {
      proposed = 'PAYMENT_LINK_WHATSAPP'; outcome = 'paid'; cost = 20;
    } else if (roll < 0.48) {
      proposed = 'PAYMENT_LINK_SMS'; outcome = 'gated'; blockedBy = 'quiet_hours'; cost = 0;
    } else if (roll < 0.60) {
      proposed = 'RETRY_CHARGE'; outcome = 'gated'; blockedBy = 'cooldown';
    } else if (roll < 0.72 && r >= 3) {
      proposed = 'VOICE_NUDGE_REGIONAL'; outcome = 'attempted'; cost = 700;
    } else if (roll < 0.80 && r >= 4) {
      proposed = 'ESCALATE_HUMAN'; outcome = 'escalated';
    }

    return {
      round: r + 1,
      proposed,
      outcome,
      blockedBy: blockedBy as any,
      trace: trace(blockedBy),
      cost,
    };
  });

  const paid = rounds.some((r) => r.outcome === 'paid');
  const escalated = rounds.some((r) => r.outcome === 'escalated');

  return {
    id: `rec_${(1000 + i).toString(36)}`,
    merchant_id: `acc_M${between(100, 140)}`,
    customer_ref: `h_${(i * 7919).toString(16).padStart(8, '0')}`,
    amount,
    failure_reason: reason,
    locale: pick(['en-IN', 'ta-IN', 'hi-IN', 'te-IN']),
    rounds,
    terminal: paid ? 'recovered' : escalated ? 'escalated' : 'written_off',
    reconciled: paid,
  };
}

const records: RecoveryRecord[] = Array.from({ length: 120 }, (_, i) => buildRecord(i));

const recoveryRun: RecoveryRun = {
  run_id: 'run_fixture_8r',
  seed: 20260905,
  rounds: 8,
  arms: [
    {
      policy: 'baseline', records_total: 120, records_recovered: 30,
      gross_recovered: 37_21_200, direct_cost: 0, optout_loss: 0,
      net_recovered: 37_21_200, stillInProgress: 0, value_recovery_pct: 27.5,
    },
    {
      policy: 'smart', records_total: 120, records_recovered: 42,
      gross_recovered: 52_10_500, direct_cost: 13_700, optout_loss: 48_000,
      net_recovered: 51_48_800, stillInProgress: 0, value_recovery_pct: 23.5,
    },
    {
      policy: 'ev', records_total: 120, records_recovered: 55,
      gross_recovered: 89_50_300, direct_cost: 19_400, optout_loss: 96_000,
      net_recovered: 88_34_900, stillInProgress: 0, value_recovery_pct: 52.0,
    },
  ],
  records,
  mode: 'FIXTURE · offline copy of a real run',
  coverage: [
    { gate: 'kill_switch', fired: 0, silentReason: 'by-design', silentDetail: 'Only fires when a human engages it.' },
    { gate: 'action_allowlist', fired: 0, silentReason: 'by-design', silentDetail: 'Both shipped policies emit valid actions only.' },
    { gate: 'do_not_contact', fired: 2 },
    { gate: 'mandate_charge_block', fired: 0, silentReason: 'backstop', silentDetail: 'A policy that checks the failure reason first never reaches it.' },
    { gate: 'business_paused_no_nudge', fired: 0, silentReason: 'backstop', silentDetail: 'smartPolicy already refuses to propose this nudge.' },
    { gate: 'attempt_ceiling', fired: 0, silentReason: 'backstop', silentDetail: 'Both policies self-terminate at or before the ceiling.' },
    { gate: 'cooldown', fired: 0, silentReason: 'scenario', silentDetail: 'Fires for blind retry, not for channel escalation.' },
    { gate: 'quiet_hours', fired: 108 },
    { gate: 'approval_ceiling', fired: 23 },
    { gate: 'spend_cap_run', fired: 0, silentReason: 'scenario', silentDetail: "This run's spend never approaches the cap." },
    { gate: 'spend_cap_day', fired: 0, silentReason: 'scenario', silentDetail: 'Same.' },
  ],
  audit_head: 'a91f4c2e7b6d80153fae94c1b2d7e880f3a6c5194e2b7d0c8a51f39b6e4d2c70',
  oracle_ceiling_pct: 71.8,
};

const evalSummary: EvalSummary = {
  batches: 20,
  countDelta: { mean: 10.1, sd: 5.6, cv: 55.0, min: 0, max: 18, wins: 19, batches: 20 },
  rupeeDelta: { mean: 3865.16, sd: 11789.30, cv: 305.0, min: -22442.44, max: 24048.32, wins: 13, batches: 20 },
  valueDelta: { mean: 30.2, sd: 8.1, cv: 26.8, min: 12.4, max: 44.9, wins: 20, batches: 20 },
  valueDeltaCi: { lo: 23.3, hi: 37.6 },
  netDeltaCi: { lo: 351530, hi: 630191 },
  oracleCeilingPct: { mean: 71.5, sd: 2.1 },
  headline: {
    baselineValuePctMean: 28.7,
    finalValuePctMean: 58.9,
    finalCaptureOfCeilingPct: 82.4,
    finalWins: 20,
    seeds: 20,
  },
  provenance: {
    seeds: [42, 49, 56, 63, 70, 77, 84, 91, 98, 105, 112, 119, 126, 133, 140, 147, 154, 161, 168, 175],
    warmupSeeds: [90001, 90002, 90003, 90004, 90005, 90006, 90007, 90008],
    records: 200,
    rounds: 20,
    warmup: 8,
    pairing: 'each seed runs every arm on the identical population',
    bootstrap: 'paired, deterministic (rngFor), 4000 iterations',
    generatedAt: '2026-09-02T03:30:00.000Z',
    regenerate: 'npm run eval:console',
  },
};

/* ------------------------- Audit ------------------------- */

const auditEntries: AuditEntry[] = Array.from({ length: 40 }, (_, i) => ({
  seq: i + 1,
  ts: new Date(Date.UTC(2026, 7, 22, 9, i * 3)).toISOString(),
  prev_hash: i === 0 ? '0'.repeat(64) : `h${(i - 1).toString(16).padStart(63, '0')}`,
  hash: `h${i.toString(16).padStart(63, '0')}`,
  kind: i % 4 === 0 ? 'decision' : i % 4 === 1 ? 'execution' : i % 4 === 2 ? 'outcome' : 'state_change',
  entity_id: records[i % records.length].id,
  payload: { action: 'RETRY_CHARGE', amount_paise: between(20_000, 500_000) },
}));

const chainVerification: ChainVerification = {
  valid: true,
  entries: auditEntries.length,
  brokenAt: null,
  head: recoveryRun.audit_head,
};

export const fixtures = {
  ledgerRows,
  reconSummary,
  recoveryRun,
  evalSummary,
  auditEntries,
  chainVerification,
};
