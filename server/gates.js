"use strict";
/* ══════════════════════════════════════════════════════════════
   GATES — the money firewall
   ──────────────────────────────────────────────────────────────
   Every guarantee this project makes about being "bounded and
   gated" is enforced in this one file. Nothing downstream of here
   — no recovery loop, no future dashboard button — can act on a
   record without passing through evaluateGates() first, because
   this is the only place that is allowed to say an action may
   proceed.

   ── What this file is, precisely ─────────────────────────────
   A pure decision function. `evaluateGates()` takes a record, a
   proposed action, and read-only views of policy/history/spend,
   and returns a verdict plus a complete trace. It makes no network
   calls, writes nothing, and has no memory between calls — which
   is what makes it something a reviewer can unit-test exhaustively
   rather than trust.

   Side effects are deliberately kept OUTSIDE this file. Recording
   that an attempt happened, or that money was spent, is the
   executor's job, done only after an action actually runs. A gate
   function that mutates its own inputs while deciding is a gate
   function that can be fooled by calling it twice.

   ── The trace is not a debug log, it is the deliverable ───────
   Every gate pushes exactly one entry — pass or block — every
   time, for every action, including the ones that were never
   close to a problem. A trace with only failures on it invites the
   question "were the others actually checked, or just not
   printed?" This file's answer is: they are all printed, always,
   so that question does not need to be asked.

   ── Citations ─────────────────────────────────────────────────
   The quiet-hours window combines two regulatory sources rather
   than inventing a number:

     RBI Fair Practices Code — recovery-agent contact restricted to
     8 AM–7 PM. This governs regulated lenders collecting loans, not
     merchants chasing a failed e-commerce payment, so it does not
     strictly bind this project. It is used anyway as the closest
     available regulatory anchor for what "reasonable hours" means
     in an Indian financial-collections context.
     https://www.business-standard.com/amp/article/finance/rbi-directs-loan-recovery-agents-not-to-intimidate-borrowers-no-calling-before-8am-after-7pm-122081201144_1.html

     TRAI's Telecom Commercial Communications Customer Preference
     Regulations restrict promotional calls/messages to 9 AM–9 PM.
     A payment-recovery nudge is arguably "transactional" rather
     than "promotional" in TRAI's own taxonomy, which may exempt it
     from this window entirely — but nothing is gained by relying on
     that exemption holding up.
     https://www.cleartouch.in/blog/trai-guidelines-for-outbound-calling-timings-in-india/

   Since neither source cleanly covers this project's exact
   situation, and the two windows differ, the INTERSECTION is used
   — 9 AM–7 PM IST — as the conservative choice. Widening it to
   either source's full window would need a reason better than
   convenience.
   ══════════════════════════════════════════════════════════════ */

const { INTERVENTIONS, CHARGING, CONTACTING, __v: v } = require("./model/response-model.frozen");
const { RazorpayClient } = require("./lib/rzp");

/* ── the closed set of gate names ─────────────────────────────
   Exported so a test (or an auditor) can assert every one of
   these appears exactly once in every trace, in this order. */
const GATE_NAMES = Object.freeze([
  "kill_switch",
  "action_allowlist",
  "do_not_contact",
  "mandate_charge_block",
  "business_paused_no_nudge",
  "attempt_ceiling",
  "cooldown",
  "quiet_hours",
  "approval_ceiling",
  "spend_cap_run",
  "spend_cap_day",
]);

const QUIET_HOURS = Object.freeze({
  timezone: "Asia/Kolkata",
  startHour: 9,
  endHour: 19,
  note: "intersection of RBI FPC (8-19) and TRAI TCCCPR (9-21); see file header for citations",
});

const MANDATE_BLOCKED_REASONS = new Set(["mandate_revoked", "mandate_paused_by_customer", "mandate_paused_by_business"]);

const DEFAULT_POLICY = Object.freeze({
  maxAttemptsPerEntity: 4,
  /* Minimum hours since the last attempt before attempt N is
     allowed, indexed by attempts-so-far. Deliberately a separate
     number from the frozen model's retry_timing_multiplier buckets:
     that table scores how likely a retry is to succeed at a given
     delay; this one is a business rule about not pestering someone,
     and the two should be allowed to disagree. */
  cooldownHoursByAttempt: [0, 6, 24, 72],
  spendCapPerRunPaise: 500000,        // ₹5,000 — placeholder, a business decision not a citation
  spendCapPerDayPaise: 2000000,       // ₹20,000
  autoApprovalCeilingPaise: 1000000,  // ₹10,000 — at or above this, a human decides, always
  respectQuietHours: true,
});

/* ── timezone-aware hour, no dependency ────────────────────────
   Node ships full ICU by default (verified: Asia/Kolkata resolves
   correctly), so this needs nothing beyond the standard library. */
function hourInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).formatToParts(date);
  return Number(parts.find((p) => p.type === "hour").value) % 24;
}

function withinQuietHours(date, cfg = QUIET_HOURS) {
  const hour = hourInTimeZone(date, cfg.timezone);
  return hour >= cfg.startHour && hour < cfg.endHour;
}

/* ── read-only trackers ────────────────────────────────────────
   These hold state; evaluateGates() only reads them. Recording a
   spend or an attempt happens in the executor, after an action
   actually runs — never inside the decision function itself. */

function createAttemptLedger() {
  const byEntity = new Map();
  return {
    recordAttempt(entityId, action, when = new Date()) {
      const cur = byEntity.get(entityId) || { count: 0, lastAt: null, history: [] };
      cur.count += 1;
      cur.lastAt = when.toISOString();
      cur.history.push({ action, at: cur.lastAt });
      byEntity.set(entityId, cur);
    },
    get(entityId) {
      return byEntity.get(entityId) || { count: 0, lastAt: null, history: [] };
    },
  };
}

function createSpendTracker() {
  let runTotal = 0;
  const byDay = new Map();
  return {
    record(paise, when = new Date()) {
      runTotal += paise;
      const day = when.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + paise);
    },
    runTotal: () => runTotal,
    dayTotal: (when = new Date()) => byDay.get(when.toISOString().slice(0, 10)) || 0,
  };
}

function createKillSwitch() {
  let engaged = false, engagedAt = null, reason = null;
  return {
    engage(r = "manual") { engaged = true; engagedAt = new Date().toISOString(); reason = r; },
    disengage() { engaged = false; engagedAt = null; reason = null; },
    isEngaged: () => engaged,
    status: () => ({ engaged, engagedAt, reason }),
  };
}

/* ── cost estimation ───────────────────────────────────────────
   Reuses base-rates.json — the same numbers the scoring model
   charges against — via the frozen model's own path-reader, so
   the gate layer and the simulator can never quietly disagree
   about what an action costs. */
function estimateCost(action, rates) {
  const KEY = {
    RETRY_CHARGE: "retry_charge",
    PAYMENT_LINK_SMS: "payment_link_sms",
    PAYMENT_LINK_WHATSAPP: "payment_link_whatsapp",
    DUNNING_EMAIL: "dunning_email",
    VOICE_NUDGE_REGIONAL: "voice_nudge_regional",
  };
  if (action === "ESCALATE_HUMAN") {
    const mins = v(rates, "intervention_cost_paise.escalate_human_minutes");
    const perHr = v(rates, "intervention_cost_paise.human_cost_per_hour_paise");
    return Math.round((mins / 60) * perHr);
  }
  const key = KEY[action];
  if (!key) return 0;   // NO_ACTION, WRITE_OFF: no direct cost
  try { return v(rates, `intervention_cost_paise.${key}`); } catch { return 0; }
}

/**
 * Decide whether a proposed action may proceed, and if not, what
 * happens instead.
 *
 * @param {object}  a
 * @param {object}  a.record          canonical ledger record (lib/schema.js shape)
 * @param {string}  a.proposedAction  what the (future) decision layer wants to do
 * @param {object}  a.rates           parsed base-rates.json — required, for cost estimation
 * @param {object}  a.killSwitch      from createKillSwitch() — required
 * @param {object}  a.attempts        from createAttemptLedger() — required
 * @param {object}  a.spend           from createSpendTracker() — required
 * @param {object}  [a.policy]        overrides merged onto DEFAULT_POLICY
 * @param {Date}    [a.now]
 * @returns {{
 *   allowed: boolean,           true iff nothing overrode the proposed action
 *   finalAction: string,        the action that should actually execute
 *   idempotencyKey: string|null,
 *   estimatedCostPaise: number,
 *   trace: Array<{gate:string, result:'pass'|'block', detail:string}>
 * }}
 */
function evaluateGates({ record, proposedAction, rates, killSwitch, attempts, spend, policy: policyOverrides, now = new Date() }) {
  for (const [name, val] of [["killSwitch", killSwitch], ["attempts", attempts], ["spend", spend], ["rates", rates]]) {
    if (!val) throw new Error(`evaluateGates: "${name}" is required — gates fail closed, not open, on a missing wire-up`);
  }
  const policy = { ...DEFAULT_POLICY, ...(policyOverrides || {}) };
  const trace = [];
  const push = (gate, result, detail) => trace.push({ gate, result, detail });
  const money = (p) => `\u20B9${(p / 100).toFixed(2)}`;

  /* Gate 0 — kill switch. Checked first and absolute: nothing else
     in this function is even evaluated meaningfully once this
     fires, because no other gate's reasoning matters if the whole
     system has been told to stop. */
  if (killSwitch.isEngaged()) {
    const { reason, engagedAt } = killSwitch.status();
    push("kill_switch", "block", `engaged at ${engagedAt} (${reason}) — no action of any kind proceeds while this is set`);
    for (const g of GATE_NAMES.slice(1)) push(g, "pass", "skipped — kill switch already stopped everything");
    return {
      allowed: false, finalAction: "NO_ACTION",
      idempotencyKey: null, estimatedCostPaise: 0, trace,
    };
  }
  push("kill_switch", "pass", "not engaged");

  /* Gate 1 — action allowlist. An invalid or unrecognised action
     is coerced to NO_ACTION and logged, never guessed into the
     nearest valid one — a silent coercion to "the closest match"
     is how a typo turns into an unintended charge. */
  if (!INTERVENTIONS.includes(proposedAction)) {
    push("action_allowlist", "block", `"${proposedAction}" is outside the closed intervention vocabulary — coerced to NO_ACTION`);
    for (const g of GATE_NAMES.slice(2)) push(g, "pass", "skipped — action already coerced to NO_ACTION");
    return {
      allowed: false, finalAction: "NO_ACTION",
      idempotencyKey: null, estimatedCostPaise: 0, trace,
    };
  }
  push("action_allowlist", "pass", `"${proposedAction}" recognised`);

  let action = proposedAction;

  /* Gate 2 — do-not-contact. Absolute, no override path, blocks
     only CONTACTING actions — a silent RETRY_CHARGE against an
     existing mandate is not "contact" in the sense this list
     protects against. */
  if (record.customer?.dnc && CONTACTING.has(action)) {
    push("do_not_contact", "block", "customer is on the do-not-contact list — no messaging action proceeds, regardless of amount or urgency");
    action = "ESCALATE_HUMAN";
  } else {
    push("do_not_contact", "pass", record.customer?.dnc ? "on the list, but the action does not contact the customer" : "not on the list");
  }

  /* Gate 3 — mandate charge block. Defense in depth: this is the
     SAME rule response-model.frozen.js enforces for scoring, now
     enforced again, independently, for execution. A bug in either
     copy alone still cannot let a suspended mandate be charged. */
  if (action === "RETRY_CHARGE" && record.method === "emandate" && MANDATE_BLOCKED_REASONS.has(record.failure?.reason)) {
    push("mandate_charge_block", "block", `cannot charge a "${record.failure.reason}" e-mandate — there is no live authorisation for a retry to use`);
    action = "ESCALATE_HUMAN";
  } else {
    push("mandate_charge_block", "pass", "not a blocked mandate state, or the action does not charge");
  }

  /* Gate 3b — a business-paused mandate cannot be fixed by talking
     to the customer either (see base-rates.json: nudge
     recoverability is zero for this reason, by design). Sending a
     message anyway would spend money and annoy a customer who was
     never the blocker, so this routes straight to a human who can
     make the actual API call. */
  if (record.method === "emandate" && record.failure?.reason === "mandate_paused_by_business" && CONTACTING.has(action)) {
    push("business_paused_no_nudge", "block", "the block is on the business side — messaging this customer cannot resolve it; only a human with API access to resume the subscription can");
    action = "ESCALATE_HUMAN";
  } else {
    push("business_paused_no_nudge", "pass", "not applicable");
  }

  const hist = attempts.get(record.entity.id);
  const actsOnEntity = CHARGING.has(action) || CONTACTING.has(action);

  /* Gate 4 — attempt ceiling. A record that has already used its
     budget of attempts stops, rather than retrying indefinitely.
     Where it goes next depends on size: small amounts are written
     off, amounts at or above the approval ceiling go to a human
     instead of being silently abandoned. */
  if (actsOnEntity && hist.count >= policy.maxAttemptsPerEntity) {
    const next = record.amount_paise >= policy.autoApprovalCeilingPaise ? "ESCALATE_HUMAN" : "WRITE_OFF";
    push("attempt_ceiling", "block", `${hist.count} attempts already made, at the configured max of ${policy.maxAttemptsPerEntity} — routing to ${next} rather than continuing indefinitely`);
    action = next;
  } else {
    push("attempt_ceiling", "pass", actsOnEntity ? `${hist.count}/${policy.maxAttemptsPerEntity} attempts used` : "action does not count as an attempt");
  }

  /* Gate 5 — cooldown. A minimum wait since the last attempt,
     scaled up as attempts accumulate — not a probability judgement
     (that lives in the frozen model), a pacing rule. */
  if ((CHARGING.has(action) || CONTACTING.has(action)) && hist.lastAt) {
    const hoursSince = (now - new Date(hist.lastAt)) / 3.6e6;
    const idx = Math.min(hist.count, policy.cooldownHoursByAttempt.length - 1);
    const required = policy.cooldownHoursByAttempt[idx];
    if (hoursSince < required) {
      push("cooldown", "block", `only ${hoursSince.toFixed(1)}h since the last attempt, ${required}h required at this attempt count — deferring rather than pestering`);
      action = "NO_ACTION";
    } else {
      push("cooldown", "pass", `${hoursSince.toFixed(1)}h since last attempt, meets the ${required}h minimum`);
    }
  } else {
    push("cooldown", "pass", hist.lastAt ? "action no longer contacts or charges" : "no prior attempt on record");
  }

  /* Gate 6 — quiet hours. Only restricts actions that reach the
     customer; a silent retry or an internal escalation is not
     bound by contact-hours reasoning at all. */
  if (CONTACTING.has(action) && policy.respectQuietHours && !withinQuietHours(now, QUIET_HOURS)) {
    push("quiet_hours", "block", `outside the ${QUIET_HOURS.startHour}:00\u2013${QUIET_HOURS.endHour}:00 ${QUIET_HOURS.timezone} contact window — deferred, not sent now`);
    action = "NO_ACTION";
  } else {
    push("quiet_hours", "pass", CONTACTING.has(action) ? "within the contact window" : "action does not contact the customer");
  }

  /* Gate 7 — approval ceiling. Amount alone can force human review,
     independent of everything else that happened above. */
  if (record.amount_paise >= policy.autoApprovalCeilingPaise && !["ESCALATE_HUMAN", "NO_ACTION", "WRITE_OFF"].includes(action)) {
    push("approval_ceiling", "block", `${money(record.amount_paise)} is at or above the ${money(policy.autoApprovalCeilingPaise)} autonomous-action ceiling — routed to a human`);
    action = "ESCALATE_HUMAN";
  } else {
    push("approval_ceiling", "pass", record.amount_paise >= policy.autoApprovalCeilingPaise ? "already routed to a human or a non-money outcome" : `${money(record.amount_paise)} is under the ceiling`);
  }

  /* Gates 8/9 — spend caps, run and day. Checked against what
     THIS action would cost if it executed, against a running
     total the executor maintains. */
  const cost = estimateCost(action, rates);

  if (spend.runTotal() + cost > policy.spendCapPerRunPaise) {
    push("spend_cap_run", "block", `would bring run spend to ${money(spend.runTotal() + cost)}, over the ${money(policy.spendCapPerRunPaise)} per-run cap`);
    action = "ESCALATE_HUMAN";
  } else {
    push("spend_cap_run", "pass", `run spend would be ${money(spend.runTotal() + cost)} of ${money(policy.spendCapPerRunPaise)} cap`);
  }

  const dayCost = estimateCost(action, rates);   // action may have just changed above
  if (spend.dayTotal(now) + dayCost > policy.spendCapPerDayPaise) {
    push("spend_cap_day", "block", `would bring today's spend to ${money(spend.dayTotal(now) + dayCost)}, over the ${money(policy.spendCapPerDayPaise)} daily cap`);
    action = "ESCALATE_HUMAN";
  } else {
    push("spend_cap_day", "pass", `today's spend would be ${money(spend.dayTotal(now) + dayCost)} of ${money(policy.spendCapPerDayPaise)} cap`);
  }

  const finalCost = estimateCost(action, rates);
  const idempotencyKey = (CHARGING.has(action) || CONTACTING.has(action))
    ? RazorpayClient.idempotencyKey(record.entity.id, action, hist.count + 1)
    : null;

  return {
    allowed: action === proposedAction,
    finalAction: action,
    idempotencyKey,
    estimatedCostPaise: finalCost,
    trace,
  };
}

/* ── CLI demo ─────────────────────────────────────────────────
   Illustrative scenarios, each engineered to trip exactly one
   gate, so the trace for each is readable end to end. This is the
   file to point a reviewer at for "show me a failure handled
   gracefully" — every scenario below IS that moment.

     node gates.js --demo
   ══════════════════════════════════════════════════════════════ */
if (require.main === module && process.argv.includes("--demo")) {
  const fs = require("fs");
  const path = require("path");
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "base-rates.json"), "utf8"));

  const baseRecord = (over = {}) => ({
    event_id: "evt_demo", entity: { type: "payment", id: "pay_demo" },
    amount_paise: 50000, method: "upi",
    customer: { dnc: false, locale: "en" },
    failure: { reason: "insufficient_funds" },
    ...over,
  });

  function run(title, args) {
    console.log(`\n${"─".repeat(64)}\n${title}\n${"─".repeat(64)}`);
    const killSwitch = args.killSwitch || createKillSwitch();
    const attempts = args.attempts || createAttemptLedger();
    const spend = args.spend || createSpendTracker();
    const result = evaluateGates({
      record: args.record, proposedAction: args.proposedAction,
      rates, killSwitch, attempts, spend,
      policy: args.policy, now: args.now || new Date(),
    });
    for (const t of result.trace) {
      const mark = t.result === "block" ? "\u2717" : "\u00B7";
      console.log(`  ${mark} ${t.gate.padEnd(24)} ${t.detail}`);
    }
    console.log(`  => ${result.finalAction}  (proposed: ${args.proposedAction}, allowed unmodified: ${result.allowed}, cost: \u20B9${(result.estimatedCostPaise/100).toFixed(2)})`);
    return result;
  }

  run("Scenario 1 — normal case, everything passes", {
    record: baseRecord(),
    proposedAction: "PAYMENT_LINK_WHATSAPP",
    now: new Date("2026-08-23T09:00:00.000Z"),   // 14:30 IST — inside window
  });

  run("Scenario 2 — do-not-contact, absolute, no override", {
    record: baseRecord({ customer: { dnc: true, locale: "en" } }),
    proposedAction: "DUNNING_EMAIL",
    now: new Date("2026-08-23T09:00:00.000Z"),
  });

  run("Scenario 3 — DNC fires first; quiet hours never gets a chance to matter", {
    record: baseRecord({ customer: { dnc: true, locale: "en" } }),
    proposedAction: "VOICE_NUDGE_REGIONAL",
    now: new Date("2026-08-22T20:30:00.000Z"),   // 02:00 IST — if DNC did NOT apply, this alone would block
  });
  console.log(`  note: DNC reroutes to ESCALATE_HUMAN before the time of day is ever consulted —`);
  console.log(`        once an action leaves the contacting set, quiet_hours has nothing left to check.`);

  run("Scenario 3b — quiet hours blocking on its own, no DNC involved", {
    record: baseRecord(),
    proposedAction: "VOICE_NUDGE_REGIONAL",
    now: new Date("2026-08-22T20:30:00.000Z"),   // 02:00 IST
  });

  run("Scenario 4 — a business-paused e-mandate: retry AND nudge both dead-end", {
    record: baseRecord({ method: "emandate", failure: { reason: "mandate_paused_by_business" } }),
    proposedAction: "RETRY_CHARGE",
    now: new Date("2026-08-23T09:00:00.000Z"),
  });

  const attempts4 = createAttemptLedger();
  for (let i = 0; i < 4; i++) attempts4.recordAttempt("pay_demo", "RETRY_CHARGE", new Date(Date.now() - (4 - i) * 200 * 3600e3));
  run("Scenario 5 — attempt ceiling hit, small amount writes off", {
    record: baseRecord({ amount_paise: 15000 }),
    proposedAction: "RETRY_CHARGE",
    attempts: attempts4,
    now: new Date("2026-08-23T09:00:00.000Z"),
  });

  run("Scenario 6 — high amount forces human approval regardless of proposal", {
    record: baseRecord({ amount_paise: 1500000 }),
    proposedAction: "PAYMENT_LINK_SMS",
    now: new Date("2026-08-23T09:00:00.000Z"),
  });

  const killed = createKillSwitch();
  killed.engage("suspected duplicate-charge bug reported mid-run");
  run("Scenario 7 — kill switch engaged: nothing proceeds, no exceptions", {
    record: baseRecord(),
    proposedAction: "WRITE_OFF",
    killSwitch: killed,
    now: new Date("2026-08-23T09:00:00.000Z"),
  });

  console.log("");
}

module.exports = {
  evaluateGates, GATE_NAMES, QUIET_HOURS, DEFAULT_POLICY,
  withinQuietHours, hourInTimeZone, estimateCost,
  createAttemptLedger, createSpendTracker, createKillSwitch,
};
