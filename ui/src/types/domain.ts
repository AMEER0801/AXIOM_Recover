/**
 * Domain types — the contract between AXIOM's Node backend and this UI.
 *
 * RULE: every monetary value in this file is an integer number of PAISE.
 * The backend already enforces this (decimals are rejected outright); the
 * UI must not undo that guarantee by parsing into floats early. Formatting
 * to rupees happens once, at the render boundary, in utils/format.ts.
 */

/** Integer paise. 100 paise = ₹1.00. Never a float. */
export type Paise = number;

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

/**
 * The confidence ladder from recon.js. Order matters: it runs from
 * "nobody needs to see this" to "a person must look at this now".
 */
export type LedgerVerdict =
  | 'exact'              // settles to the paisa
  | 'explained_split'    // two bank batches, sums correctly
  | 'explained_refund'   // gap equals a refund already on file
  | 'explained_fee'      // pricing-plan variance — still owed, low priority
  | 'flagged_duplicate'  // customer charged twice, refund owed
  | 'unexplained'        // genuine break
  | 'orphan_credit';     // money arrived with no payment behind it

export type Severity = 'none' | 'low' | 'high';

export interface LedgerRow {
  payment_id: string;
  merchant_id: string;
  /** What should have landed in the bank, net of fee and tax. */
  expected: Paise;
  /** What actually landed. */
  actual: Paise;
  /** actual − expected. Negative = short, positive = over. */
  delta: Paise;
  verdict: LedgerVerdict;
  severity: Severity;
  /** Human-readable reason. recon.js explains BEFORE it flags. */
  explanation: string;
  /** For duplicates: which half of the pair this row is. */
  pairRole?: 'original' | 'duplicate';
  settled_at: string; // ISO 8601
}

export interface ReconSummary {
  batch_id: string;
  rows_examined: number;
  /** Sum of |delta| across every row, decomposed by verdict class. */
  gap_total: Paise;
  gap_tied: Paise;
  gap_explained_owed: Paise;
  gap_needs_person: Paise;
  /** Scored against the frozen answer key. Null on live data (no key exists). */
  precision: number | null;
  recall: number | null;
  explanation_accuracy: number | null;
  /** True once every base rate in base-rates.json carries a source. */
  reportable: boolean;
}

/* ------------------------------------------------------------------ */
/* Gates — the money firewall                                          */
/* ------------------------------------------------------------------ */

/** All eleven, in the fixed order gates.js evaluates them. */
export const GATE_ORDER = [
  'kill_switch',
  'action_allowlist',
  'do_not_contact',
  'mandate_charge_block',
  'business_paused_no_nudge',
  'attempt_ceiling',
  'cooldown',
  'quiet_hours',
  'approval_ceiling',
  'spend_cap_run',
  'spend_cap_day',
] as const;

export type GateName = (typeof GATE_ORDER)[number];

/**
 * Why a gate was silent this run. The distinction is load-bearing:
 * a backstop gate that never fires means the POLICY was careful,
 * not that the gate is dead code.
 */
export type SilentReason = 'by-design' | 'backstop' | 'scenario';

export interface GateEntry {
  gate: GateName;
  blocked: boolean;
  /** One line, present on pass AND on block. A trace that only records
   *  failures invites "were the others actually checked?". */
  detail: string;
}

/** Exactly eleven entries, always, in GATE_ORDER. Asserted by test. */
export type GateTrace = GateEntry[];

export interface GateCoverage {
  gate: GateName;
  fired: number;
  silentReason?: SilentReason;
  silentDetail?: string;
}

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

export type PolicyName = 'baseline' | 'smart' | 'llm';

/** The closed vocabulary. Anything outside it is coerced to NO_ACTION. */
export type Intervention =
  | 'NO_ACTION'
  | 'RETRY_CHARGE'
  | 'SEND_PAYMENT_LINK'
  | 'SEND_NUDGE_SMS'
  | 'SEND_NUDGE_WHATSAPP'
  | 'VOICE_NUDGE_REGIONAL'
  | 'ESCALATE_HUMAN'
  | 'WRITE_OFF';

export type RoundOutcome =
  | 'paid'        // recovered, and reconciled independently
  | 'gated'       // a gate intervened — the system working, not a fault
  | 'escalated'   // handed to a person
  | 'written_off'
  | 'attempted'   // action ran, no result yet
  | 'idle';       // nothing proposed this round

export interface RecoveryRound {
  round: number;
  proposed: Intervention;
  outcome: RoundOutcome;
  /** Populated when outcome === 'gated'. */
  blockedBy?: GateName;
  trace: GateTrace;
  /** Direct spend for this action (SMS/WhatsApp/voice/agent time). */
  cost: Paise;
}

export type FailureReason =
  | 'insufficient_funds'
  | 'card_expired'
  | 'soft_decline'
  | 'hard_decline'
  | 'network_timeout'
  | 'mandate_revoked'
  | 'mandate_paused_by_customer'
  | 'mandate_paused_by_business'
  | 'checkout_abandoned'
  | 'invoice_overdue';

export interface RecoveryRecord {
  id: string;
  merchant_id: string;
  /** Hashed upstream — never a readable phone or email. */
  customer_ref: string;
  amount: Paise;
  failure_reason: FailureReason;
  locale: string;
  rounds: RecoveryRound[];
  terminal: 'recovered' | 'escalated' | 'written_off' | 'in_progress';
  /** True only after recon.js agreed the money actually landed. */
  reconciled: boolean;
}

export interface PolicyResult {
  policy: PolicyName;
  records_total: number;
  records_recovered: number;
  gross_recovered: Paise;
  direct_cost: Paise;
  /** Estimated value of customers lost to over-contacting. */
  optout_loss: Paise;
  net_recovered: Paise;
  /** Records that had not reached a terminal state when the window closed.
   *  Non-zero means the comparison is against a moving target. */
  stillInProgress: number;
}

export interface RecoveryRun {
  run_id: string;
  seed: number;
  rounds: number;
  arms: PolicyResult[];
  records: RecoveryRecord[];
  coverage: GateCoverage[];
  /** sha256 head of the audit chain. Same seed ⇒ same hash. */
  audit_head: string;
}

/* ------------------------------------------------------------------ */
/* Stability sweep                                                     */
/* ------------------------------------------------------------------ */

export interface DeltaStat {
  mean: number;
  sd: number;
  /** Coefficient of variation, %. Above 100 ⇒ report with a warning. */
  cv: number;
  min: number;
  max: number;
  wins: number;
  batches: number;
}

export interface EvalSummary {
  batches: number;
  /** Stable claim: smart recovers more PAYMENTS. */
  countDelta: DeltaStat;
  /** Noisy claim: rupee total swings on a few large invoices. */
  rupeeDelta: DeltaStat;
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export interface AuditEntry {
  seq: number;
  ts: string;
  prev_hash: string;
  hash: string;
  kind: 'decision' | 'execution' | 'result';
  entity_id: string;
  payload: Record<string, unknown>;
}

export interface ChainVerification {
  valid: boolean;
  entries: number;
  /** Sequence number where the chain first breaks. Null when valid. */
  brokenAt: number | null;
  head: string;
}
