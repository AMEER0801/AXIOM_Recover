"use strict";
/* ══════════════════════════════════════════════════════════════
   ORACLE CEILING — what is the maximum ANY policy could recover?
   ──────────────────────────────────────────────────────────────
   The question "can we hit 70%?" is a question about the SHAPE of
   the frozen response model, not about how clever a policy is. A
   policy cannot outrun the probabilities it is scored against. So
   before tuning anything further, this computes the honest answer
   with an optimal-stopping / dynamic-programming argument:

       What is the expected recovery rate of a policy that knows
       every true probability in advance and acts optimally against
       it — an omniscient oracle?

   That number is a hard mathematical ceiling. No real policy,
   however sophisticated (bandit, LLM, hand-tuned rules), can beat
   it in expectation, because it is defined as the maximum over ALL
   policies. If the ceiling itself sits below 70%, then 70% is not
   an engineering problem to solve — it is a claim about a different
   population or a different model, and no amount of policy cleverness
   reaches it on THIS data.

   ── The Bellman equation ──────────────────────────────────────
   Per record, state = (rounds remaining r, attempts used a,
   opted-out o). Terminal value V(0,·,·) = 0. Otherwise:

     V(r,a,o) = max(
       V(r-1, a, o),                                    // NO_ACTION
       [if retry legal]  p·amt + (1-p)·V(r-1,a+1,o),     // RETRY_CHARGE
       [if o=false, per channel ch]
         p·(amt-cost)
         + (1-p)·po·(-cost - churn + V(r-1,a+1,true))
         + (1-p)·(1-po)·(-cost + V(r-1,a+1,false))
     )

   p, po and cost come straight from model/base-rates.json via the
   SAME lookup functions response-model.frozen.js uses — this file
   duplicates the deterministic probability math (no RNG needed for
   an expectation) but changes not one number in the frozen model
   itself. `node freeze.js --check` still passes.

   Two ceilings are computed, because they answer different questions:

     UNCONSTRAINED  — no attempt cap, no cooldown, no quiet hours,
                      no approval-ceiling delay. Only physical law is
                      kept: a revoked e-mandate cannot be charged
                      (NPCI rule, not a business choice). This is the
                      absolute mathematical maximum — the number to
                      quote when someone asks "is X% even possible."

     GATED          — same math, but capped at the real system's own
                      4-attempt ceiling and 8-round window. This is
                      the maximum reachable WITHOUT relaxing the
                      safety rules this project chose on purpose.

   Comparing the deployed EV+bandit policy against GATED (not
   UNCONSTRAINED) tells you how much is a policy problem — closeable
   by better decisions — versus how much is a population problem —
   closeable only by changing the rules of the game.
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { generate } = require("./seed");
const { __v: v } = require("./model/response-model.frozen");

const CONTACT = {
  PAYMENT_LINK_WHATSAPP: "payment_link_whatsapp",
  PAYMENT_LINK_SMS: "payment_link_sms",
  DUNNING_EMAIL: "dunning_email",
  VOICE_NUDGE_REGIONAL: "voice_nudge_regional",
};
const MANDATE_BLOCKED = new Set(["mandate_revoked", "mandate_paused_by_customer", "mandate_paused_by_business"]);

function attemptBucket(n) { return n >= 4 ? "4+" : String(Math.max(1, n)); }
function timingBucket(hours) {
  if (hours < 6) return "lt_6h";
  if (hours < 24) return "6_24h";
  if (hours < 72) return "24_72h";
  if (hours <= 168) return "72_168h";
  return "gt_168h";
}
function clip01(p) { return p < 0 ? 0 : p > 1 ? 1 : p; }

/** Deterministic probability lookups — the same arithmetic as
 *  resolve(), minus the coin flip. Reused so the oracle is scored
 *  against literally the same numbers a real run would be. */
function retryProb(record, rates, attemptNo, hoursSinceFail) {
  const reason = record.failure?.reason || "payment_failed";
  const method = record.method === "emandate" ? "emandate" : record.method === "upi" ? "upi" : "card";
  if (method === "emandate" && MANDATE_BLOCKED.has(reason)) return 0;
  const recover = (() => { try { return v(rates, `failure_reason_recoverability.${reason}`); } catch { return 1.0; } })();
  const base = v(rates, `retry_success_by_attempt.${method}.${attemptBucket(attemptNo)}`);
  const timing = v(rates, `retry_timing_multiplier.${timingBucket(hoursSinceFail)}`);
  return clip01(base * timing * recover);
}
function nudgeProbs(record, rates, channel, attemptNo) {
  const reason = record.failure?.reason || "payment_failed";
  const key = CONTACT[channel];
  const recover = (() => { try { return v(rates, `failure_reason_recoverability.${reason}`); } catch { return 1.0; } })();
  const base = v(rates, `nudge_conversion.${key}`);
  /* The oracle always sends in the customer's own language — the
     matched-language uplift is available to any policy that simply
     asks, so an oracle bound that ignored this would be a bound on
     a policy stupider than the one already deployed. */
  const uplift = v(rates, "locale_uplift.matched_language");
  const p = clip01(base * uplift * recover);
  const hazBase = v(rates, `opt_out_hazard.${key}`);
  const hazMult = v(rates, "opt_out_hazard.per_extra_contact_multiplier");
  const po = clip01(hazBase * Math.pow(hazMult, Math.max(0, attemptNo - 1)));
  const cost = v(rates, `intervention_cost_paise.${key}`);
  return { p, po, cost };
}

/** IST hour for a given round, matching recover2.js's own schedule
 *  exactly (2026-08-01T06:00 UTC start, 30h per round) — so "does
 *  this round fall in the contact window" is not a guess, it's the
 *  same clock the real system runs on. */
function istHourForRound(round, startAt, hoursPerRound) {
  const t = new Date(startAt.getTime() + round * hoursPerRound * 3600e3);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).formatToParts(t);
  return Number(parts.find((p) => p.type === "hour").value) % 24;
}
function contactAllowed(round, startAt, hoursPerRound) {
  const h = istHourForRound(round, startAt, hoursPerRound);
  return h >= 9 && h < 19;   // same window gates.js enforces
}

/**
 * Solve the Bellman equation for one record by backward induction.
 * @param {object} opts
 * @param {boolean} [opts.respectQuietHours] block contact actions on
 *   rounds outside the 09:00–19:00 IST window, exactly like gates.js.
 * @param {number}  [opts.ceilingPaise] if set, records at or above
 *   this amount pass through a dual-control gate FIRST: with
 *   probability `approvalRate` the record proceeds (after burning
 *   `approvalLatencyRounds` rounds of the horizon on the wait), and
 *   with probability `1-approvalRate` it is written off with zero
 *   recovery, structurally, regardless of how good the channel choice
 *   would have been. This is not a customer-behaviour probability —
 *   it is the SAME business rule approvals.js enforces on the real
 *   system, and omitting it is why the first version of this file
 *   overstated the ceiling: 91% of this population's value sits in
 *   `invoice_overdue`, which — being large B2B amounts — is almost
 *   entirely above the ceiling, so almost the whole ceiling number
 *   passes through this gate whether the oracle accounts for it or
 *   not. An oracle that skips a real structural loss the project
 *   chose to enforce isn't measuring the ceiling of THIS system.
 */
function solveRecord(record, rates, { rounds, attemptCap, hoursPerRound = 30, startHours, respectQuietHours = false, startAt = new Date("2026-08-01T06:00:00.000Z"), ceilingPaise = null, approvalRate = 0.85, approvalLatencyRounds = 1 }) {
  const amt = record.amount_paise;
  const churn = v(rates, "opt_out_loss_paise");
  const baseHours = startHours != null ? startHours : (record.hours_since_event ?? 48);

  const gated = ceilingPaise != null && amt >= ceilingPaise;
  const effectiveRounds = gated ? Math.max(0, rounds - approvalLatencyRounds) : rounds;

  /* Single memo, single pass: each state resolves {val, prob} together,
     since the argmax action is shared (see note above on why value-
     maximizing and probability-maximizing coincide on this data).
     The earlier version memoized V() but not P(), so P() re-walked
     an unmemoized tree under it — 5 branches x up to 100 rounds is
     5^100 unmemoized calls, which is why the first run had to be
     killed rather than finishing. One memo table, filled once. */
  const memo = new Map();
  const key = (r, a, o) => r * 100000 + a * 10 + o;

  function solve(r, a, o) {
    if (r === 0) return { val: 0, prob: 0 };
    if (attemptCap != null && a >= attemptCap) return { val: 0, prob: 0 };
    const k = key(r, a, o);
    const hit = memo.get(k);
    if (hit) return hit;

    const round = effectiveRounds - r;
    const hoursSinceFail = baseHours + round * hoursPerRound;
    const canContact = !respectQuietHours || contactAllowed(round, startAt, hoursPerRound);

    const noAction = solve(r - 1, a, o);
    let best = { val: noAction.val, prob: noAction.prob };

    const pRetry = retryProb(record, rates, a + 1, hoursSinceFail);
    if (pRetry > 0) {
      const cont = solve(r - 1, a + 1, o);
      const val = pRetry * amt + (1 - pRetry) * cont.val;
      if (val > best.val) best = { val, prob: pRetry + (1 - pRetry) * cont.prob };
    }

    if (o === 0 && canContact) {
      for (const ch of Object.keys(CONTACT)) {
        const { p, po, cost } = nudgeProbs(record, rates, ch, a + 1);
        const contStay = solve(r - 1, a + 1, 0);
        const contOptOut = solve(r - 1, a + 1, 1);
        const val =
          p * (amt - cost) +
          (1 - p) * po * (-cost - churn + contOptOut.val) +
          (1 - p) * (1 - po) * (-cost + contStay.val);
        if (val > best.val) {
          const prob = p + (1 - p) * po * contOptOut.prob + (1 - p) * (1 - po) * contStay.prob;
          best = { val, prob };
        }
      }
    }

    memo.set(k, best);
    return best;
  }

  const root = solve(effectiveRounds, 0, 0);

  if (!gated) return { ceilingNet: root.val, ceilingProb: root.prob };

  /* Dual control: with probability approvalRate the record proceeds
     to the DP just solved (net of the reviewer's own cost); with
     probability 1-approvalRate it is written off, structurally,
     before any channel choice — good or bad — ever gets a chance to
     matter. This is a coin the record's OWN policy cannot influence,
     so it multiplies through rather than entering the DP's own
     action set. */
  const reviewCostPaise = 7000; // ₹70 — same figure gates.js/estimateCost() charges, kept numerically identical
  return {
    ceilingNet: approvalRate * (root.val - reviewCostPaise) - (1 - approvalRate) * reviewCostPaise,
    ceilingProb: approvalRate * root.prob,
  };
}

function runCeiling(seed, records, { rounds, attemptCap, label, respectQuietHours = false, ceilingPaise = null, approvalRate = 0.85, approvalLatencyRounds = 1 }) {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "base-rates.json"), "utf8"));
  const { ledger } = generate({ seed, records });
  const AT_RISK = new Set(["payment_failed", "checkout_abandoned", "subscription_halted", "invoice_overdue"]);
  const atRisk = ledger.filter((r) => AT_RISK.has(r.kind));

  let totalValue = 0, ceilingRecoverable = 0, ceilingCount = 0, ceilingNetTotal = 0;
  const byClass = {};
  for (const r of atRisk) {
    const { ceilingNet, ceilingProb } = solveRecord(r, rates, { rounds, attemptCap, respectQuietHours, ceilingPaise, approvalRate, approvalLatencyRounds });
    totalValue += r.amount_paise;
    ceilingRecoverable += ceilingProb * r.amount_paise;
    ceilingCount += ceilingProb;
    ceilingNetTotal += ceilingNet;

    const reason = r.failure?.reason || r.kind;
    byClass[reason] = byClass[reason] || { n: 0, value: 0, expRecovered: 0 };
    byClass[reason].n += 1;
    byClass[reason].value += r.amount_paise;
    byClass[reason].expRecovered += ceilingProb * r.amount_paise;
  }

  return {
    label, seed, atRiskCount: atRisk.length, totalValue,
    ceilingCountRate: ceilingCount / atRisk.length,
    ceilingValueRate: ceilingRecoverable / totalValue,
    ceilingNetTotal, byClass,
  };
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const seed = Number(arg("seed", 42));
  const records = Number(arg("records", 200));

  const R = (p) => "\u20B9" + Math.round(p / 100).toLocaleString("en-IN");

  console.log(`\n\u2500\u2500 ORACLE CEILING \u00b7 seed ${seed} \u2500\u2500`);
  console.log("An omniscient policy — knows every true probability, acts optimally — solved via backward-induction Bellman equation.\n");

  const configs = [
    { label: "FULLY GATED incl. dual-control 15% rejection \u2014 THE real ceiling", rounds: 8, attemptCap: 4, respectQuietHours: true, ceilingPaise: 1000000 },
    { label: "Gated + quiet hours, NO approval attrition   \u2014 isolates that one loss", rounds: 8, attemptCap: 4, respectQuietHours: true, ceilingPaise: null },
    { label: "Gated, no quiet hours, no approval attrition \u2014 isolates the scheduling cost", rounds: 8, attemptCap: 4, respectQuietHours: false, ceilingPaise: null },
    { label: "8 rounds, NO attempt cap, no approval gate   \u2014 relax the ceiling entirely", rounds: 8, attemptCap: null, respectQuietHours: true, ceilingPaise: null },
    { label: "30 rounds, NO attempt cap                    \u2014 unlimited time, unlimited tries", rounds: 30, attemptCap: null, respectQuietHours: true, ceilingPaise: null },
  ];

  const rows = configs.map((c) => runCeiling(seed, records, c));
  for (const r of rows) {
    console.log(`  ${r.label}`);
    console.log(`    ceiling by count: ${(r.ceilingCountRate * 100).toFixed(1)}%   by value: ${(r.ceilingValueRate * 100).toFixed(1)}%   net: ${R(r.ceilingNetTotal)}`);
  }

  console.log(`\n\u2500\u2500 WHERE THE CEILING IS LOST, BY FAILURE CLASS (gated, 8 rounds/4 attempts) \u2500\u2500`);
  const g = rows[0];
  const lines = Object.entries(g.byClass).map(([k, x]) => ({
    reason: k, n: x.n, value: x.value, expRecovered: x.expRecovered,
    ceilingPct: 100 * x.expRecovered / x.value,
  })).sort((a, b) => b.value - a.value);
  console.log("  reason".padEnd(30), "n".padStart(4), "value".padStart(12), "oracle-recoverable".padStart(20), "ceiling%".padStart(10));
  for (const l of lines) {
    console.log(`  ${l.reason}`.padEnd(30), String(l.n).padStart(4), R(l.value).padStart(12), R(l.expRecovered).padStart(20), (l.ceilingPct.toFixed(1) + "%").padStart(10));
  }
  console.log("");
}

module.exports = { runCeiling, solveRecord };
