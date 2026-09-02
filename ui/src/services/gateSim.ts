import { GATE_ORDER, type GateTrace, type GateEntry } from '@/types/domain';
import type { GateProbe } from './api';
import { rupees } from './format';

/**
 * A browser-side mirror of `gates.js`, used ONLY when the backend is not
 * running, so the simulator still teaches the eleven-gate order offline.
 *
 * This is a second implementation of a rule that already exists, which is
 * normally a smell. It is acceptable here for exactly one reason: it never
 * decides anything real. Nothing in this file can authorise a payment. The
 * panel labels its own verdict "simulated locally" whenever this runs, so a
 * reviewer is never told a browser computed a production decision.
 *
 * Invariant, same as the backend: ELEVEN entries, always, in GATE_ORDER,
 * on pass and on block alike. A trace that records only failures invites
 * the question "were the others actually checked?"
 */

const MESSAGING: ReadonlySet<string> = new Set([
  'PAYMENT_LINK_SMS',
  'PAYMENT_LINK_WHATSAPP',
  'DUNNING_EMAIL',
  'VOICE_NUDGE_REGIONAL',
]);

const SUSPENDED_MANDATES: ReadonlySet<string> = new Set([
  'mandate_revoked',
  'mandate_paused_by_customer',
  'mandate_paused_by_business',
]);

const ALLOWED = new Set([
  'NO_ACTION', 'RETRY_CHARGE', 'PAYMENT_LINK_SMS', 'PAYMENT_LINK_WHATSAPP',
  'DUNNING_EMAIL', 'VOICE_NUDGE_REGIONAL', 'ESCALATE_HUMAN', 'WRITE_OFF',
]);

/* Mirrors gates.js DEFAULT_POLICY. The attempt ceiling is 4 in the
 * shipped default config (the FINAL configuration raises it to 6);
 * cooldown waits scale with attempt count: 0/6/24/72 hours. */
const ATTEMPT_CEILING = 4;
const COOLDOWN_HOURS = [0, 6, 24, 72];
const QUIET_START = 9;   // 09:00 IST — intersection of RBI (8–19) and TRAI (9–21)
const QUIET_END = 19;    // 19:00 IST

export function simulateGates(p: GateProbe): GateTrace {
  const isMessaging = MESSAGING.has(p.action);
  const isCharge = p.action === 'RETRY_CHARGE';
  const suspended = SUSPENDED_MANDATES.has(p.failure_reason);

  const entry = (gate: (typeof GATE_ORDER)[number], blocked: boolean, detail: string): GateEntry =>
    ({ gate, blocked, detail });

  const trace: GateTrace = [
    entry('kill_switch', p.kill_switch,
      p.kill_switch
        ? 'Engaged — everything stops, no exception carved out.'
        : 'Not engaged.'),

    entry('action_allowlist', !ALLOWED.has(p.action),
      ALLOWED.has(p.action)
        ? `"${p.action}" is in the closed vocabulary.`
        : `"${p.action}" is outside the vocabulary — coerced to NO_ACTION, never guessed into the nearest match.`),

    entry('do_not_contact', p.do_not_contact && isMessaging,
      !p.do_not_contact
        ? 'Customer is not on the list.'
        : isMessaging
          ? 'On the do-not-contact list. Absolute — no override path exists.'
          : 'On the list, but this action sends no message. A silent retry is not blocked.'),

    entry('mandate_charge_block', isCharge && suspended,
      isCharge && suspended
        ? `${p.failure_reason}: no live authorisation exists for a retry to use. Zero, enforced as a rule — not a low probability.`
        : isCharge
          ? 'Mandate is live.'
          : 'Not a charge.'),

    entry('business_paused_no_nudge',
      isMessaging && p.failure_reason === 'mandate_paused_by_business',
      p.failure_reason === 'mandate_paused_by_business'
        ? (isMessaging
            ? 'The business paused this mandate — the customer was never the blocker. Messaging them accomplishes nothing; route to a human.'
            : 'Business-paused: routing to a human is the only correct action.')
        : 'Not a business-paused mandate.'),

    entry('attempt_ceiling', p.attempts >= ATTEMPT_CEILING,
      p.attempts >= ATTEMPT_CEILING
        ? `${p.attempts} attempts ≥ ceiling of ${ATTEMPT_CEILING}. Small amounts write off; large amounts still go to a human.`
        : `${p.attempts} of ${ATTEMPT_CEILING} attempts used.`),

    entry('cooldown', (isCharge || isMessaging) && cooldownBlocks(p),
      (isCharge || isMessaging) && cooldownBlocks(p)
        ? `${(p.minutes_since_last_attempt / 60).toFixed(1)}h since the last attempt — the pacing rule wants ${cooldownRequired(p)}h at ${p.attempts} attempts. Deferring rather than pestering.`
        : `${(p.minutes_since_last_attempt / 60).toFixed(1)}h since last attempt, meets the ${cooldownRequired(p)}h minimum.`),

    entry('quiet_hours',
      isMessaging && (p.hour_ist < QUIET_START || p.hour_ist >= QUIET_END),
      isMessaging
        ? (p.hour_ist < QUIET_START || p.hour_ist >= QUIET_END
            ? `${String(p.hour_ist).padStart(2, '0')}:00 IST is outside 09:00–19:00. Conservative intersection of RBI Fair Practices (08–19) and TRAI TCCCPR (09–21).`
            : `${String(p.hour_ist).padStart(2, '0')}:00 IST is inside the window.`)
        : 'No customer-facing message in this action.'),

    entry('approval_ceiling', p.amount_paise > p.approval_ceiling_paise,
      p.amount_paise > p.approval_ceiling_paise
        ? `${rupees(p.amount_paise)} exceeds the ${rupees(p.approval_ceiling_paise)} auto-approval ceiling. Amount alone forces human review, regardless of what else passed.`
        : `${rupees(p.amount_paise)} is within the ${rupees(p.approval_ceiling_paise)} ceiling.`),

    entry('spend_cap_run',
      p.spend_so_far_run_paise >= p.spend_cap_run_paise && isMessaging,
      p.spend_so_far_run_paise >= p.spend_cap_run_paise
        ? `Run spend ${rupees(p.spend_so_far_run_paise)} has reached the ${rupees(p.spend_cap_run_paise)} cap. Further PAID actions reroute to a human.`
        : `Run spend ${rupees(p.spend_so_far_run_paise)} of ${rupees(p.spend_cap_run_paise)}.`),

    entry('spend_cap_day', false,
      'Daily cap not reached in this scenario.'),
  ];

  // The invariant this whole design rests on, checked rather than trusted.
  if (trace.length !== GATE_ORDER.length) {
    throw new Error(`gate trace must contain ${GATE_ORDER.length} entries, got ${trace.length}`);
  }
  trace.forEach((e, i) => {
    if (e.gate !== GATE_ORDER[i]) {
      throw new Error(`gate trace out of order at ${i}: expected ${GATE_ORDER[i]}, got ${e.gate}`);
    }
  });

  return trace;
}

/* gates.js paces retries: the required gap scales with attempts already
 * made — cooldownHoursByAttempt[min(count, 3)] = 0/6/24/72 hours. */
function cooldownRequired(p: GateProbe): number {
  return COOLDOWN_HOURS[Math.min(p.attempts, COOLDOWN_HOURS.length - 1)];
}
function cooldownBlocks(p: GateProbe): boolean {
  return p.minutes_since_last_attempt / 60 < cooldownRequired(p);
}

export function firstBlock(trace: GateTrace) {
  return trace.find((e) => e.blocked) ?? null;
}
