"use strict";
/* ══════════════════════════════════════════════════════════════
   RECOVER — the loop that turns infrastructure into an agent
   ──────────────────────────────────────────────────────────────
   Everything built through gates.js is measurement and safety.
   Nothing yet has looked at a struggling payment and DONE anything
   about it. This file is that missing piece:

       propose (policy)  ->  gate (gates.js)  ->  execute (rzp.js,
       dry-run)  ->  simulate the customer (frozen model, TEST MODE
       ONLY)  ->  record the attempt and the spend  ->  emit a
       settlement pair for anything that got paid, so recon.js can
       independently confirm the money actually landed

   That last step is the point of building the reconciler first.
   "The agent recovered ₹X" is not accepted on the agent's own
   say-so here — the exact same confidence-ladder matcher that
   tears apart a settlement file is run again on whatever this
   loop produced, and only what reconciles counts.

   ── Policies are swappable, on purpose ────────────────────────
   A policy is a pure function: (record, history, rates) -> one of
   INTERVENTIONS. gates.js validates whatever comes out of it
   against the same closed vocabulary regardless of how it was
   produced. Today both policies here are transparent, rule-based,
   and reproducible; an LLM-based policy could sit behind the exact
   same interface tomorrow without changing anything downstream of
   it — the firewall does not care where a proposal came from, only
   whether it is allowed to execute.

   ── The baseline is mandatory, not decoration ─────────────────
   A single "the agent recovered ₹X" number is unfalsifiable —
   there is nothing to compare it to. Every batch here is run
   twice, through the identical gates and the identical seeded
   customer population, once with `baselinePolicy` (retry
   everything, blindly) and once with `smartPolicy`. The number
   that gets reported is the DELTA between the two, net of cost —
   not either arm's number in isolation.

   ── Why a shared seed does not mean shared draws across policies
   response-model.frozen.js keys its RNG on (seed, event_id,
   attemptNo, intervention) — not on which policy is calling it.
   If baseline proposes RETRY_CHARGE and smart proposes
   DUNNING_EMAIL for the same record at the same attempt count,
   they draw from two different streams, because those are two
   different real-world actions with two different real-world
   odds — there is no "same dice roll" to share between them. What
   the shared seed guarantees is that re-running either arm alone
   reproduces it exactly, and that both arms face the same starting
   population — not that their individual draws are coupled.

   ── This loop never touches a real Razorpay account ───────────
   RazorpayClient defaults to dry-run (see lib/rzp.js), and the
   customer's response is always taken from the frozen simulator
   here, never from a real webhook. "Live" mode — real API calls,
   real customers, outcomes arriving asynchronously via
   index.js's webhook receiver instead of being resolved inline —
   is a real extension of this same code, not a rewrite: swap the
   `simulate` step for "wait for a webhook" and the propose/gate/
   execute spine is unchanged.
   ══════════════════════════════════════════════════════════════ */

const { RazorpayClient } = require("./lib/rzp");
const {
  evaluateGates, createAttemptLedger, createSpendTracker, createKillSwitch, DEFAULT_POLICY,
} = require("./gates");
const { resolve, INTERVENTIONS, CHARGING, CONTACTING, __v: v } = require("./model/response-model.frozen");
const { rngFor } = require("./lib/rng");
const { createAuditChain } = require("./audit");

const ACTING = new Set([...CHARGING, ...CONTACTING]);
const TERMINAL = new Set(["WRITE_OFF", "ESCALATE_HUMAN"]);   // stop working this record once reached
const AT_RISK_KINDS = new Set(["payment_failed", "checkout_abandoned", "subscription_halted", "invoice_overdue"]);

/* ── Policy 1: the mandatory baseline ─────────────────────────
   "Retry everything, blindly" — no branching on failure reason,
   no channel selection, no locale awareness. This is what a
   business does with zero intelligence layered on top of Razorpay:
   fire a retry, and once attempts run out, write it off. It exists
   so the smart policy has something honest to be compared against
   — not to be a strawman; gates.js will correctly reject the
   proposals that are physically impossible (a suspended mandate,
   for instance), and how OFTEN that happens is itself part of the
   comparison. */
function baselinePolicy(record, hist) {
  if (hist.count >= DEFAULT_POLICY.maxAttemptsPerEntity) return "WRITE_OFF";
  return "RETRY_CHARGE";
}

/* ── Policy 2: the rule-based recovery policy ──────────────────
   Branches on the same failure-reason taxonomy the frozen model
   scores against — that is domain knowledge a real business has
   (Razorpay tells a merchant exactly why a payment failed), not
   the agent peeking at the simulator's hidden dice. What it does
   NOT do is read base-rates.json's exact probability numbers and
   argmax against them — that would make this an oracle playing
   against its own answer key, not a policy. */
function smartPolicy(record, hist) {
  const reason = record.failure?.reason;

  /* Dead on arrival: no retry and no message changes the outcome.
     Escalating immediately spends one human review instead of
     wasting a contact attempt that cannot succeed. */
  const DEAD = new Set(["card_expired", "card_blocked", "invalid_account", "mandate_revoked"]);
  if (DEAD.has(reason)) return hist.count === 0 ? "ESCALATE_HUMAN" : "WRITE_OFF";

  /* The business-paused mandate finding from Day 5: messaging the
     customer cannot fix a block that sits on the business side.
     A good policy should not even propose the wasted nudge — gates
     would catch it anyway, but a policy that never tries a doomed
     action is a better policy, not just a safely-caught one. */
  if (reason === "mandate_paused_by_business") return "ESCALATE_HUMAN";

  /* Only the customer can resume their own pause — one nudge is
     worth trying before giving up. */
  if (reason === "mandate_paused_by_customer") return hist.count === 0 ? "PAYMENT_LINK_WHATSAPP" : "ESCALATE_HUMAN";

  /* Soft declines recover well from a silent retry within the
     first couple of attempts — no need to spend money contacting
     anyone yet. */
  const SOFT = new Set(["insufficient_funds", "gateway_error", "issuer_down", "payment_timeout"]);
  if (SOFT.has(reason) && hist.count < 2) return "RETRY_CHARGE";

  /* Past that, escalate the channel with the attempt count —
     cheapest first, and prefer the customer's own language once a
     voice channel is on the table. This is the "Bhasha Recovery"
     idea from early in the project, wired in as an actual decision
     rather than left as a pitch line: a locale mismatch on a
     regional-language customer is exactly the gap a rule-based
     policy can close for free. */
  if (hist.count === 0) return "DUNNING_EMAIL";
  if (hist.count === 1) return "PAYMENT_LINK_SMS";
  if (hist.count === 2) {
    return (record.customer?.locale && record.customer.locale !== "en") ? "VOICE_NUDGE_REGIONAL" : "PAYMENT_LINK_WHATSAPP";
  }
  return "ESCALATE_HUMAN";
}

const POLICIES = Object.freeze({ baseline: baselinePolicy, smart: smartPolicy });

/**
 * Build the two ledger rows a successful recovery needs so the
 * reconciler can independently confirm it — a captured payment and
 * the settlement line for it, net of Razorpay's own fee and tax,
 * computed the same way seed.js computes them for consistency.
 */
function makeSettledPair({ record, action, seed, roundIndex }) {
  const feeBps = 200;
  const fee = Math.round((record.amount_paise * feeBps) / 10000);
  const tax = Math.round(fee * 0.18);
  const net = record.amount_paise - fee - tax;
  const rand = rngFor(seed, "recover-settle", record.entity.id, roundIndex);
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");

  const payId = `pay_${hex(14)}`;
  const capturedAt = new Date();
  const settledAt = new Date(capturedAt.getTime() + (24 + Math.floor(rand() * 48)) * 3600e3);

  return [
    {
      event_id: `evt_${hex(14)}`, ts: capturedAt.toISOString(), kind: "payment_captured",
      merchant_id: record.merchant_id, entity: { type: "payment", id: payId },
      customer: record.customer, amount_paise: record.amount_paise, currency: "INR",
      method: record.method, failure: null, attempt_no: 0,
      fee_paise: fee, tax_paise: tax,
      raw: { simulated: true, recovered_from: record.entity.id, recovered_via: action },
    },
    {
      event_id: `evt_${hex(14)}`, ts: settledAt.toISOString(), kind: "settlement_line",
      merchant_id: record.merchant_id, entity: { type: "settlement", id: `setl_${hex(12)}` },
      customer: record.customer, amount_paise: net, currency: "INR",
      method: record.method, failure: null, attempt_no: 0,
      settles_payment_id: payId,
      raw: { simulated: true },
    },
  ];
}

/**
 * Run one policy across one at-risk population, for a number of
 * "rounds" of elapsed time — so cooldowns and quiet hours have
 * something real to enforce, instead of every record getting
 * exactly one shot.
 *
 * @param {object}  a
 * @param {Array}   a.ledger        canonical records (only at-risk kinds are worked)
 * @param {Function} a.policy       (record, hist, rates) -> proposed action
 * @param {object}  a.rates         parsed base-rates.json
 * @param {number}  a.seed          drives both the simulated outcomes and settlement ids
 * @param {number}  [a.rounds]      how many collection cycles to simulate
 * @param {number}  [a.hoursPerRound]
 * @param {Date}    [a.startAt]
 * @param {object}  [a.policyConfig] gate policy overrides (spend caps etc.)
 */
async function runBatch({ ledger, policy, rates, seed, rounds = 6, hoursPerRound = 30, startAt = new Date("2026-08-01T06:00:00.000Z"), policyConfig }) {
  const killSwitch = createKillSwitch();
  const attempts = createAttemptLedger();
  const spend = createSpendTracker();

  /* The audit chain's clock is driven by the simulated run time,
     not wall-clock. Two things follow: the log reads in the order
     the decisions actually happened in simulated time, and the
     same seed produces a byte-identical chain — so the head hash
     itself is reproducible and can be quoted as a run fingerprint.
     A wall-clock timestamp would make every run's hashes differ
     even when nothing about the decisions changed. */
  let auditClockAt = startAt;
  const audit = createAuditChain({ clock: () => auditClockAt });

  audit.append("run_started", {
    seed, rounds, hoursPerRound,
    policy_name: policy.name || "anonymous",
    started_at: startAt.toISOString(),
    gate_policy: { ...DEFAULT_POLICY, ...(policyConfig || {}) },
  });

  /* Work on clones — DNC can flip mid-run (an opt-out), and the
     caller's original ledger must not be mutated out from under a
     second run using the same source data. */
  const atRisk = ledger
    .filter((r) => AT_RISK_KINDS.has(r.kind))
    .map((r) => ({ ...r, customer: { ...r.customer } }));

  const resolved = new Set();
  const perRecordLog = new Map();
  const emitted = [];
  let optOuts = 0;

  for (let round = 0; round < rounds; round++) {
    const now = new Date(startAt.getTime() + round * hoursPerRound * 3600e3);
    auditClockAt = now;

    for (const record of atRisk) {
      if (resolved.has(record.entity.id)) continue;

      const hist = attempts.get(record.entity.id);
      /* await, not a direct call — baselinePolicy and smartPolicy are
         plain synchronous functions and return immediately either
         way, so this costs them nothing. It is what lets an async
         policy (llm-policy.js's llmPolicy, a real network call)
         plug into the exact same slot without runBatch needing to
         know or care which kind of policy it was handed. */
      const proposed = await policy(record, hist, rates);
      const gateResult = evaluateGates({ record, proposedAction: proposed, rates, killSwitch, attempts, spend, policy: policyConfig, now });

      const entry = { round, at: now.toISOString(), proposed, final: gateResult.finalAction, allowed: gateResult.allowed, paid: false, opted_out: false, cost_paise: 0 };

      /* The decision goes into the chain BEFORE anything executes.
         An audit log written after the fact records what a system
         decided it did; this one records what it decided to do,
         and then separately what happened — so a crash between the
         two leaves evidence rather than a gap. */
      audit.append("decision", {
        round,
        entity_id: record.entity.id,
        amount_paise: record.amount_paise,
        method: record.method,
        failure_reason: record.failure?.reason || null,
        attempt_no: hist.count + 1,
        proposed,
        final: gateResult.finalAction,
        allowed: gateResult.allowed,
        idempotency_key: gateResult.idempotencyKey,
        estimated_cost_paise: gateResult.estimatedCostPaise,
        trace: gateResult.trace,
      });

      if (ACTING.has(gateResult.finalAction)) {
        audit.append("execution", {
          round,
          entity_id: record.entity.id,
          final: gateResult.finalAction,
          idempotency_key: gateResult.idempotencyKey,
          mode: "dry-run",
          attempt_no: hist.count + 1,
        });

        const sim = resolve({
          record, intervention: gateResult.finalAction, attemptNo: hist.count + 1,
          hoursSinceFail: (record.hours_since_event ?? 48) + round * hoursPerRound,
          messageLocale: record.customer?.locale || "en",
          rates, seed,
        });

        attempts.recordAttempt(record.entity.id, gateResult.finalAction, now);
        spend.record(sim.direct_cost_paise, now);

        entry.paid = sim.paid;
        entry.cost_paise = sim.direct_cost_paise;
        entry.opted_out = sim.opted_out;

        audit.append("outcome", {
          round,
          entity_id: record.entity.id,
          final: gateResult.finalAction,
          amount_paise: record.amount_paise,
          paid: sim.paid,
          cost_paise: sim.direct_cost_paise,
          opted_out: sim.opted_out,
          run_spend_after_paise: spend.runTotal(),
        });

        if (sim.paid) {
          resolved.add(record.entity.id);
          emitted.push(...makeSettledPair({ record, action: gateResult.finalAction, seed, roundIndex: round }));
        }
        if (sim.opted_out && !record.customer.dnc) {
          record.customer.dnc = true;
          optOuts++;
          audit.append("state_change", {
            round,
            entity_id: record.entity.id,
            change: "customer_opted_out",
            effect: "added to do-not-contact; no further messaging action can target this customer",
          });
        }
      } else if (TERMINAL.has(gateResult.finalAction)) {
        resolved.add(record.entity.id);
      }
      /* NO_ACTION (a cooldown or quiet-hours deferral) leaves the
         record unresolved on purpose — it gets another proposal
         next round rather than being counted as anything final. */

      if (!perRecordLog.has(record.entity.id)) perRecordLog.set(record.entity.id, []);
      perRecordLog.get(record.entity.id).push(entry);
    }
  }

  const grossPaise = emitted.filter((r) => r.kind === "payment_captured").reduce((a, r) => a + r.amount_paise, 0);
  const optOutLossPaise = optOuts * v(rates, "opt_out_loss_paise");
  const costPaise = spend.runTotal();
  const netPaise = grossPaise - costPaise - optOutLossPaise;
  const stillInProgress = atRisk.length - resolved.size;

  audit.append("run_ended", {
    at_risk: atRisk.length,
    resolved: resolved.size,
    still_in_progress: stillInProgress,
    paid: emitted.filter((r) => r.kind === "payment_captured").length,
    opt_outs: optOuts,
    gross_paise: grossPaise,
    cost_paise: costPaise,
    opt_out_loss_paise: optOutLossPaise,
    net_paise: netPaise,
  });

  return {
    atRiskCount: atRisk.length,
    resolvedCount: resolved.size,
    /* Anything not in `resolved` when the loop ends is NOT a
       failure — it may simply still be mid-cooldown, waiting for
       its next scheduled attempt. Reported explicitly rather than
       left for a reader to misread a low resolvedCount as a low
       success rate. `rounds` defaults to a value empirically
       confirmed (see recover.js CLI) to drive this to zero for
       both policies on the default synthetic batch; a caller using
       a shorter window should read this field before trusting any
       rate computed from resolvedCount. */
    stillInProgress,
    paidCount: emitted.filter((r) => r.kind === "payment_captured").length,
    optOuts,
    grossPaise, costPaise, optOutLossPaise, netPaise,
    emitted,
    perRecordLog,
    spend, attempts,
    audit,
  };
}

/**
 * Run both arms on the identical at-risk population and report the
 * comparison. This — not either arm alone — is the number the
 * project's founding claim rests on.
 */
async function compareArms({ ledger, rates, seed, rounds, hoursPerRound, startAt, policyConfig }) {
  const baseline = await runBatch({ ledger, policy: baselinePolicy, rates, seed, rounds, hoursPerRound, startAt, policyConfig });
  const smart = await runBatch({ ledger, policy: smartPolicy, rates, seed, rounds, hoursPerRound, startAt, policyConfig });
  return {
    baseline, smart,
    deltaNetPaise: smart.netPaise - baseline.netPaise,
    deltaPaidCount: smart.paidCount - baseline.paidCount,
    deltaOptOuts: smart.optOuts - baseline.optOuts,
  };
}

/* ── CLI ──────────────────────────────────────────────────────── */
if (require.main === module) {
(async () => {
  const fs = require("fs");
  const path = require("path");
  const { generate } = require("./seed");
  const { rupees } = require("./lib/schema");

  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const seed = Number(arg("seed", 42));
  const records = Number(arg("records", 200));
  /* 8 rounds at the default 30h spacing is the empirically smallest
     window in which BOTH policies drive every record to a terminal
     state on the default seed — verified by running 6/8/10/14/20
     and confirming paid counts stop changing at 8. Below that,
     "resolved" undercounts baseline in particular, since its
     blind-retry cooldown schedule (up to 72h between attempts) is
     slower to exhaust than the smart policy's faster channel
     escalation — that is a real dynamic, not a bug, and is exactly
     why `stillInProgress` is reported rather than silently folded
     into "not recovered." */
  const rounds = Number(arg("rounds", 8));

  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "base-rates.json"), "utf8"));
  const { ledger } = generate({ seed, records });

  const cmp = await compareArms({ ledger, rates, seed, rounds });

  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "\u2014");
  const row = (label, b, s) => console.log(`  ${label.padEnd(24)} ${String(b).padStart(12)}   ${String(s).padStart(12)}`);

  console.log(`\n\u2500\u2500 RECOVERY RUN \u00b7 seed ${seed} \u00b7 ${cmp.baseline.atRiskCount} at-risk records \u00b7 ${rounds} rounds \u2500\u2500`);
  console.log(`\n  ${"".padEnd(24)} ${"baseline".padStart(12)}   ${"smart".padStart(12)}`);
  row("resolved", cmp.baseline.resolvedCount, cmp.smart.resolvedCount);
  row("still in progress", cmp.baseline.stillInProgress, cmp.smart.stillInProgress);
  row("paid", cmp.baseline.paidCount, cmp.smart.paidCount);
  row("recovery rate", pct(cmp.baseline.paidCount, cmp.baseline.atRiskCount), pct(cmp.smart.paidCount, cmp.smart.atRiskCount));
  row("opt-outs caused", cmp.baseline.optOuts, cmp.smart.optOuts);

  if (cmp.baseline.stillInProgress > 0 || cmp.smart.stillInProgress > 0) {
    console.log(`\n  \u26a0 ${cmp.baseline.stillInProgress + cmp.smart.stillInProgress} record-runs had not reached a terminal state (paid, written off, or`);
    console.log(`    escalated) when the window closed — they are cooling down, not failed. The comparison`);
    console.log(`    above is against a moving target; re-run with more --rounds before trusting the delta.`);
  }
  console.log("");
  row("gross recovered", rupees(cmp.baseline.grossPaise), rupees(cmp.smart.grossPaise));
  row("direct cost", rupees(cmp.baseline.costPaise), rupees(cmp.smart.costPaise));
  row("opt-out loss (est.)", rupees(cmp.baseline.optOutLossPaise), rupees(cmp.smart.optOutLossPaise));
  row("NET recovered", rupees(cmp.baseline.netPaise), rupees(cmp.smart.netPaise));

  console.log(`\n  DELTA (smart \u2212 baseline), net of cost:  ${rupees(cmp.deltaNetPaise)}`);
  console.log(`  This is the number the project's claim rests on \u2014 not either arm alone.\n`);

  const outDir = path.join(__dirname, "data", "recover");
  fs.mkdirSync(outDir, { recursive: true });

  /* ── the audit trail ─────────────────────────────────────────
     Verified before it is written, not after. A chain that fails
     its own integrity check should never reach disk looking like
     a valid artefact. */
  const { verifyChain, toCSV, gateCoverage } = require("./audit");
  const { GATE_NAMES } = require("./gates");
  const auditEntries = cmp.smart.audit.entries();
  const chainCheck = verifyChain(auditEntries);

  console.log(`\u2500\u2500 AUDIT TRAIL (smart arm) \u2500\u2500`);
  console.log(`  entries .............. ${auditEntries.length}`);
  console.log(`  chain integrity ...... ${chainCheck.ok ? "intact" : `BROKEN at entry ${chainCheck.brokenAt}: ${chainCheck.reason}`}`);
  console.log(`  head hash ............ ${cmp.smart.audit.head().slice(0, 24)}\u2026`);
  console.log(`  (same seed reproduces this hash exactly \u2014 it is a fingerprint of the whole run)`);

  const cov = gateCoverage(auditEntries, GATE_NAMES);
  console.log(`\n\u2500\u2500 GATE COVERAGE \u00b7 ${cov.firedCount}/${cov.total} gates fired across ${cov.decisions} decisions \u2500\u2500`);
  for (const f of cov.fired) console.log(`  \u2717 ${f.gate.padEnd(26)} blocked ${f.blocks} time${f.blocks === 1 ? "" : "s"}`);
  console.log(`\n  silent this run \u2014 and why:`);
  for (const s of cov.silent) console.log(`  \u00b7 ${s.gate.padEnd(26)} [${s.kind}] ${s.why}`);
  if (cov.unclassified.length) {
    console.log(`\n  \u26a0 ${cov.unclassified.length} gate(s) silent with NO recorded explanation: ${cov.unclassified.join(", ")}`);
  }
  console.log(`\n  Every gate above has a direct unit test that forces it to fire. "Silent this run"`);
  console.log(`  means this scenario did not reach it \u2014 not that the code is unexercised.\n`);

  const reconLedgerSmart = [...ledger, ...cmp.smart.emitted];
  /* Written as ledger.json + truth.json, the exact names recon.js
     reads — caught by actually running the documented next command
     rather than trusting the instruction. The first version wrote
     "post-recovery-ledger.smart.json" and told the reader to run
     recon.js against the directory, which crashed on a missing
     file. An instruction that has never been executed is not
     documentation, it is a guess. */
  fs.writeFileSync(path.join(outDir, "ledger.json"), JSON.stringify(reconLedgerSmart, null, 2));
  /* recon.js also needs the answer key. The original truth covers
     the pre-existing settled population; recovered payments are
     additions and legitimately have no truth entry, so score()
     skips them (`if (!t) continue;`) rather than counting them as
     errors — the reconciliation VERDICT on them is still computed
     and asserted in the test suite. */
  const { truth } = generate({ seed, records });
  fs.writeFileSync(path.join(outDir, "truth.json"), JSON.stringify(truth, null, 2));
  fs.writeFileSync(path.join(outDir, "audit.smart.json"), JSON.stringify({ chain_verified: chainCheck, head: cmp.smart.audit.head(), coverage: cov, entries: auditEntries }, null, 2));
  fs.writeFileSync(path.join(outDir, "audit.smart.csv"), toCSV(auditEntries));
  fs.writeFileSync(path.join(outDir, "comparison.json"), JSON.stringify({
    seed, records, rounds,
    baseline: { ...cmp.baseline, emitted: undefined, perRecordLog: undefined, spend: undefined, attempts: undefined, audit: undefined },
    smart: { ...cmp.smart, emitted: undefined, perRecordLog: undefined, spend: undefined, attempts: undefined, audit: undefined },
    deltaNetPaise: cmp.deltaNetPaise, deltaPaidCount: cmp.deltaPaidCount, deltaOptOuts: cmp.deltaOptOuts,
  }, null, 2));

  console.log(`  written to ${outDir}/`);
  console.log(`    ledger.json + truth.json          reconcile the recovered money:  npm run recon:recovered`);
  console.log(`    audit.smart.json                  full chain, every gate trace, verifiable`);
  console.log(`    audit.smart.csv                   the scannable view`);
  console.log(`    comparison.json                   baseline vs smart totals`);
  console.log("");

  /* ── the optional third arm ────────────────────────────────────
     Off by default: it needs GROQ_API_KEY, needs network access,
     and is NOT swept across seeds the way the other two arms are —
     an LLM's output is not guaranteed reproducible run to run even
     at temperature 0, and repeating an unreliable measurement 20
     times does not make it reliable, it makes it an expensive
     unreliable measurement. So this runs once, on a smaller batch,
     and says exactly that.

     On money: Groq's free tier is genuinely free, gated by rate
     limits (30 requests/minute) rather than a per-token charge —
     verified against Groq's current docs, not assumed. Every call
     is paced to stay under that limit, which is also why this is
     slow: 20 records over 4 rounds is up to 80 calls, and at ~2.1s
     apart that is a couple of minutes of wall-clock time for what
     the other two arms finish instantly. That trade is the actual
     price of "zero investment," paid in time instead of money. */
  if (process.argv.includes("--llm")) {
    if (!process.env.GROQ_API_KEY) {
      console.log(`  \u2500\u2500 --llm requested, but GROQ_API_KEY is not set \u2500\u2500`);
      console.log(`  Get a free key (no card required) at https://console.groq.com/keys, set`);
      console.log(`  GROQ_API_KEY, and re-run. This arm makes real network calls and is skipped`);
      console.log(`  rather than faked \u2014 there is no offline stand-in for "what did the model say."\n`);
    } else {
      const { llmPolicy, FREE_TIER_RPM, PACE_MS } = require("./llm-policy");
      const llmRecords = Number(arg("llm-records", 20));
      const llmRounds = Number(arg("llm-rounds", 4));
      const maxCalls = llmRecords * llmRounds;
      const estSeconds = Math.ceil((maxCalls * PACE_MS) / 1000);

      console.log(`\u2500\u2500 LLM ARM (Groq, free tier) \u2500\u2500 seed ${seed} \u00b7 ${llmRecords} records \u00b7 ${llmRounds} rounds \u2500\u2500`);
      console.log(`  Paced to stay under Groq's free-tier cap of ${FREE_TIER_RPM} requests/minute \u2014 up to`);
      console.log(`  ${maxCalls} calls, so this may take up to ~${estSeconds}s. Cost: \u20B90.00 on the free tier,`);
      console.log(`  gated by rate limit rather than billed per token.`);
      console.log(`  This run is NOT swept across seeds like the two arms above, and is not`);
      console.log(`  guaranteed to reproduce exactly on a second run \u2014 both facts are the point,`);
      console.log(`  not an oversight. See README for why.\n`);

      const { ledger: llmLedger } = generate({ seed, records: llmRecords });
      const t0 = Date.now();
      const llmResult = await runBatch({ ledger: llmLedger, policy: llmPolicy, rates, seed, rounds: llmRounds });
      const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);

      const smartOnSameBatch = await runBatch({ ledger: llmLedger, policy: smartPolicy, rates, seed, rounds: llmRounds });
      const baseOnSameBatch = await runBatch({ ledger: llmLedger, policy: baselinePolicy, rates, seed, rounds: llmRounds });

      const rowL = (label, b, s2, l) => console.log(`  ${label.padEnd(22)} ${String(b).padStart(12)}   ${String(s2).padStart(12)}   ${String(l).padStart(12)}`);
      console.log(`  ${"".padEnd(22)} ${"baseline".padStart(12)}   ${"smart".padStart(12)}   ${"llm".padStart(12)}`);
      rowL("paid", baseOnSameBatch.paidCount, smartOnSameBatch.paidCount, llmResult.paidCount);
      rowL("NET recovered", rupees(baseOnSameBatch.netPaise), rupees(smartOnSameBatch.netPaise), rupees(llmResult.netPaise));
      console.log(`\n  wall-clock time for the LLM arm: ${elapsedS}s (${llmRecords} records \u00d7 up to ${llmRounds} rounds of API calls)`);
      console.log(`  smart beat llm on this single run: ${smartOnSameBatch.netPaise > llmResult.netPaise ? "yes" : "no"}`);
      console.log(`  \u2014 a single run either way is an anecdote, not a verdict. Re-run with a fresh`);
      console.log(`  seed before drawing a conclusion; the number will move.\n`);
    }
  }
})();
}

module.exports = {
  baselinePolicy, smartPolicy, POLICIES,
  runBatch, compareArms, makeSettledPair,
  AT_RISK_KINDS, ACTING, TERMINAL,
};
