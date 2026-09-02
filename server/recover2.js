"use strict";
/* ══════════════════════════════════════════════════════════════
   RECOVER2 — the corrected loop
   ──────────────────────────────────────────────────────────────
   recover.js stays exactly as it is. This runner exists alongside
   it so both sets of numbers can be produced from one clone and
   the difference between them can be pointed at, rather than a
   corrected number quietly replacing a published one and the git
   history being the only trace. `npm run recover` still prints
   35.0% and ₹14,276.28; `npm run recover2` prints what those
   figures become once three accounting errors are fixed.

   Four changes, all in this file and its three collaborators, and
   NONE of them touch model/response-model.frozen.js or
   model/base-rates.json. The freeze check still passes. Every
   number below is the same simulated world scored the same way —
   what changed is the policy, the bookkeeping, and what happens
   after a human is asked to look at something.

   1. Escalation labour is billed. recover.js computes the ₹70
      reviewer cost in gates.js's estimateCost(), writes it into
      the audit chain, and then never adds it to the spend tracker,
      because ESCALATE_HUMAN is not in its ACTING set. The smart
      arm escalates 78 times and the baseline 28, so the reported
      delta carries ₹3,500 of unbilled labour. Fixed in both arms —
      which makes the headline delta smaller and correct.

   2. Recovery is reported by value as well as by count. The
      published 35% is a count. By value the same run recovers
      3.2%, because the 24 records holding 91% of the money are the
      ones the approval ceiling condemns. One number was on the
      slide; the other was the business.

   3. Ceiling escalations go to a review queue that comes back.
      See approvals.js.

   4. The policy ranks by expected value and learns during the run.
      See policy-ev.js and bandit.js.

   ── The comparison stays honest ───────────────────────────────
   All three arms run on the identical seeded population, through
   the identical gate firewall, scored by the identical frozen
   model, with the identical corrected accounting. The approval
   queue is offered to every arm, not just the new one — otherwise
   the EV arm would be winning on a privilege rather than on a
   decision, and the whole point of keeping a baseline is to make
   that kind of thing impossible to hide.
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const {
  evaluateGates, createAttemptLedger, createSpendTracker, createKillSwitch, DEFAULT_POLICY, estimateCost,
} = require("./gates");
const { resolve, CHARGING, CONTACTING, __v: v } = require("./model/response-model.frozen");
const { createAuditChain, verifyChain } = require("./audit");
const { createBandit } = require("./bandit");
const { createApprovalQueue } = require("./approvals");
const { createEvPolicy } = require("./policy-ev");
const { baselinePolicy, smartPolicy, makeSettledPair, AT_RISK_KINDS } = require("./recover");

const ACTING = new Set([...CHARGING, ...CONTACTING]);

/**
 * Run one policy over one population.
 *
 * @param {object}   a
 * @param {Array}    a.ledger
 * @param {Function} a.policy      (record, hist, rates, ctx) -> action
 * @param {object}   a.rates       parsed base-rates.json (the frozen truth; passed to the
 *                                 SIMULATOR only, never handed to the policy's beliefs)
 * @param {object}   a.priors      parsed agent-priors.json
 * @param {number}   a.seed
 * @param {number}   [a.rounds]
 * @param {boolean}  [a.useApprovals]  route ceiling escalations through review
 * @param {object}   [a.bandit]        supply one to have this arm learn
 */
async function runBatch2({
  ledger, policy, rates, priors, seed, rounds = 8, hoursPerRound = 30,
  startAt = new Date("2026-08-01T06:00:00.000Z"), policyConfig, useApprovals = true, bandit = null,
}) {
  const killSwitch = createKillSwitch();
  const attempts = createAttemptLedger();
  const spend = createSpendTracker();
  const approvals = createApprovalQueue({ priors, seed });
  const gatePolicy = { ...DEFAULT_POLICY, ...(policyConfig || {}) };

  let auditClockAt = startAt;
  const audit = createAuditChain({ clock: () => auditClockAt });
  audit.append("run_started", {
    seed, rounds, hoursPerRound,
    policy_name: policy.name || "anonymous",
    accounting: "escalation_labour_billed",
    approvals_enabled: useApprovals,
    bandit_enabled: Boolean(bandit),
    gate_policy: gatePolicy,
  });

  const atRisk = ledger
    .filter((r) => AT_RISK_KINDS.has(r.kind))
    .map((r) => ({ ...r, customer: { ...r.customer } }));

  const resolved = new Set();
  const perRecordLog = new Map();
  const emitted = [];
  let optOuts = 0;
  let escalationCostPaise = 0;
  let escalations = 0;

  for (let round = 0; round < rounds; round++) {
    const now = new Date(startAt.getTime() + round * hoursPerRound * 3600e3);
    auditClockAt = now;

    /* Advance the review desk before the round's decisions, so an
       approval that landed overnight is usable this round rather
       than next. */
    if (useApprovals) {
      for (const d of approvals.tick(round)) {
        audit.append("state_change", {
          round, entity_id: d.entityId,
          change: d.approved ? "approval_granted" : "approval_rejected",
          amount_paise: d.amount_paise,
          effect: d.approved
            ? "record returns to automated collection with dual-control approval attached"
            : "reviewer declined; record written off",
        });
        if (!d.approved) resolved.add(d.entityId);
      }
    }

    for (const record of atRisk) {
      if (resolved.has(record.entity.id)) continue;
      /* A record waiting on a reviewer is not idle-able and not
         failed — it is out of the automation's hands this round. */
      if (useApprovals && approvals.isPending(record.entity.id)) continue;

      const hist = attempts.get(record.entity.id);

      /* An approved record must be able to pass Gate 7. Raising the
         ceiling for this one record is exactly what the approval
         means, and it is scoped to the approved record only. */
      const approvedHere = useApprovals && approvals.decision(record.entity.id)?.approved === true;
      const effectivePolicy = approvedHere
        ? { ...(policyConfig || {}), autoApprovalCeilingPaise: Number.MAX_SAFE_INTEGER }
        : policyConfig;

      const proposed = await policy(record, hist, rates, { now, round, approvals });
      const gateResult = evaluateGates({
        record, proposedAction: proposed, rates, killSwitch, attempts, spend,
        policy: effectivePolicy, now,
      });

      const entry = {
        round, at: now.toISOString(), proposed, final: gateResult.finalAction,
        allowed: gateResult.allowed, paid: false, opted_out: false, cost_paise: 0,
      };

      audit.append("decision", {
        round, entity_id: record.entity.id, amount_paise: record.amount_paise,
        method: record.method, failure_reason: record.failure?.reason || null,
        attempt_no: hist.count + 1, proposed, final: gateResult.finalAction,
        allowed: gateResult.allowed, idempotency_key: gateResult.idempotencyKey,
        estimated_cost_paise: gateResult.estimatedCostPaise,
        dual_control_approved: approvedHere || undefined,
        trace: gateResult.trace,
      });

      if (ACTING.has(gateResult.finalAction)) {
        audit.append("execution", {
          round, entity_id: record.entity.id, final: gateResult.finalAction,
          idempotency_key: gateResult.idempotencyKey, mode: "dry-run", attempt_no: hist.count + 1,
        });

        const sim = resolve({
          record, intervention: gateResult.finalAction, attemptNo: hist.count + 1,
          hoursSinceFail: (record.hours_since_event ?? 48) + round * hoursPerRound,
          messageLocale: record.customer?.locale || "en",
          rates, seed,
        });

        attempts.recordAttempt(record.entity.id, gateResult.finalAction, now);
        spend.record(sim.direct_cost_paise, now);

        /* Feedback. The bandit sees only what this run observed —
           whether the customer paid — never the probability that
           produced it. */
        /* attemptNo here is hist.count + 1 — same number just handed
           to resolve() a few lines up, and now also the number that
           routes RETRY_CHARGE feedback into the correct 1/2/3/4+
           bucket instead of one pooled arm (see bandit.js). */
        if (bandit) bandit.update(bandit.failureClass(record), gateResult.finalAction, sim.paid, hist.count + 1);

        entry.paid = sim.paid;
        entry.cost_paise = sim.direct_cost_paise;
        entry.opted_out = sim.opted_out;

        audit.append("outcome", {
          round, entity_id: record.entity.id, final: gateResult.finalAction,
          amount_paise: record.amount_paise, paid: sim.paid,
          cost_paise: sim.direct_cost_paise, opted_out: sim.opted_out,
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
            round, entity_id: record.entity.id, change: "customer_opted_out",
            effect: "added to do-not-contact; no further messaging action can target this customer",
          });
        }
      } else if (gateResult.finalAction === "ESCALATE_HUMAN") {
        /* THE FIX. Reviewer time is real money and is charged to
           whichever arm asked for it. recover.js drops this on the
           floor for both arms — unequally, since the smart policy
           escalates 2.8x more often than the baseline. */
        const cost = estimateCost("ESCALATE_HUMAN", rates);

        if (useApprovals && !approvals.isDecided(record.entity.id)) {
          const q = approvals.request(record.entity.id, {
            round, amountPaise: record.amount_paise, action: gateResult.finalAction,
          });
          if (q.queued) {
            escalations++;
            escalationCostPaise += q.costPaise;
            spend.record(q.costPaise, now);
            audit.append("outcome", {
              round, entity_id: record.entity.id, final: "ESCALATE_HUMAN",
              amount_paise: record.amount_paise, paid: false, cost_paise: q.costPaise,
              opted_out: false, queued_for_approval: true,
              run_spend_after_paise: spend.runTotal(),
            });
          }
          /* Deliberately NOT marked resolved: the record is in a
             queue and will come back. This single line is the
             difference between reviewing ₹14.76L and abandoning it. */
        } else {
          escalations++;
          escalationCostPaise += cost;
          spend.record(cost, now);
          audit.append("outcome", {
            round, entity_id: record.entity.id, final: "ESCALATE_HUMAN",
            amount_paise: record.amount_paise, paid: false, cost_paise: cost,
            opted_out: false, run_spend_after_paise: spend.runTotal(),
          });
          resolved.add(record.entity.id);
        }
      } else if (gateResult.finalAction === "WRITE_OFF") {
        resolved.add(record.entity.id);
      }

      if (!perRecordLog.has(record.entity.id)) perRecordLog.set(record.entity.id, []);
      perRecordLog.get(record.entity.id).push(entry);
    }
  }

  const paidRows = emitted.filter((r) => r.kind === "payment_captured");
  const grossPaise = paidRows.reduce((a, r) => a + r.amount_paise, 0);
  const atRiskValuePaise = atRisk.reduce((a, r) => a + r.amount_paise, 0);
  const optOutLossPaise = optOuts * v(rates, "opt_out_loss_paise");
  const costPaise = spend.runTotal();
  const netPaise = grossPaise - costPaise - optOutLossPaise;
  const outstanding = approvals.outstanding();

  audit.append("run_ended", {
    at_risk: atRisk.length, resolved: resolved.size,
    still_in_progress: atRisk.length - resolved.size,
    paid: paidRows.length, opt_outs: optOuts,
    gross_paise: grossPaise, cost_paise: costPaise,
    escalation_cost_paise: escalationCostPaise,
    opt_out_loss_paise: optOutLossPaise, net_paise: netPaise,
    at_risk_value_paise: atRiskValuePaise,
    value_recovery_pct: Number(((grossPaise / atRiskValuePaise) * 100).toFixed(2)),
    approvals: approvals.stats(),
  });

  return {
    atRiskCount: atRisk.length,
    atRiskValuePaise,
    resolvedCount: resolved.size,
    stillInProgress: atRisk.length - resolved.size,
    paidCount: paidRows.length,
    optOuts, escalations, escalationCostPaise,
    grossPaise, costPaise, optOutLossPaise, netPaise,
    approvalStats: approvals.stats(),
    outstandingReviews: outstanding,
    emitted, perRecordLog, spend, attempts, audit,
  };
}

/**
 * Warm the bandit on OTHER populations before the evaluation batch.
 *
 * A deployed collections agent does not meet its first customer with
 * nothing but a vendor benchmark; it has months of its own outcomes.
 * Evaluating a learner cold and a fixed rule-based policy side by
 * side measures the learner's first day, not its steady state, and
 * a bandit's first day is by construction its worst.
 *
 * The training seeds are disjoint from the evaluation seed and
 * generate entirely separate synthetic populations, so nothing about
 * the scored batch leaks into the prior — this is a train/test split,
 * not a rehearsal on the exam. The eval batch is never in the warm-up
 * set, and `warmupSeeds` is printed with the results so the split is
 * visible rather than asserted.
 */
async function warmBandit({ bandit, rates, priors, records, rounds, evalSeed, warmupSeeds }) {
  const { generate } = require("./seed");
  for (const s of warmupSeeds) {
    if (s === evalSeed) continue;
    const { ledger } = generate({ seed: s, records });
    const queueRef = { current: null };
    const p = createEvPolicy({
      priors, bandit,
      approvals: { decision: (id) => queueRef.current?.decision(id) ?? null },
      ceilingPaise: DEFAULT_POLICY.autoApprovalCeilingPaise,
      optOutLossPaise: v(rates, "opt_out_loss_paise"),
    });
    const wrapped = (rec, hist, r, ctx) => {
      queueRef.current = ctx?.approvals || queueRef.current;
      return p(rec, hist, r, ctx);
    };
    await runBatch2({ ledger, policy: wrapped, rates, priors, seed: s, rounds, useApprovals: true, bandit });
  }
  return bandit;
}

/** All arms, identical population, identical accounting. */
async function compareAll({ ledger, rates, priors, seed, rounds = 8, policyConfig, bandit: warmed = null }) {
  const bandit = warmed || createBandit({ priors, seed });
  const evPolicy = createEvPolicy({
    priors, bandit,
    approvals: { decision: () => null },   // replaced per-run below
    ceilingPaise: (policyConfig?.autoApprovalCeilingPaise ?? DEFAULT_POLICY.autoApprovalCeilingPaise),
    optOutLossPaise: v(rates, "opt_out_loss_paise"),
  });

  /* The EV policy needs to see the queue belonging to ITS run, so it
     is rebuilt with a live handle inside a thin wrapper. */
  const evWithQueue = (queueRef) => {
    const p = createEvPolicy({
      priors, bandit, approvals: { decision: (id) => queueRef.current?.decision(id) ?? null },
      ceilingPaise: (policyConfig?.autoApprovalCeilingPaise ?? DEFAULT_POLICY.autoApprovalCeilingPaise),
      optOutLossPaise: v(rates, "opt_out_loss_paise"),
    });
    return Object.defineProperty((rec, hist, r, ctx) => {
      queueRef.current = ctx?.approvals || queueRef.current;
      return p(rec, hist, r, ctx);
    }, "name", { value: "evPolicy" });
  };

  const common = { ledger, rates, priors, seed, rounds, policyConfig, useApprovals: true };
  const queueRef = { current: null };

  const baseline = await runBatch2({ ...common, policy: baselinePolicy });
  const smart = await runBatch2({ ...common, policy: smartPolicy });
  const ev = await runBatch2({ ...common, policy: evWithQueue(queueRef), bandit });

  return { baseline, smart, ev, bandit, evPolicyUnused: evPolicy };
}

/* ── CLI ──────────────────────────────────────────────────────── */
if (require.main === module) {
  (async () => {
    const { generate } = require("./seed");
    const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
    const seed = Number(arg("seed", 42));
    const records = Number(arg("records", 200));
    const rounds = Number(arg("rounds", 8));

    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "base-rates.json"), "utf8"));
    const priors = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "agent-priors.json"), "utf8"));
    const warmup = Number(arg("warmup", 12));
    const { ledger } = generate({ seed, records });

    /* Seeds 90001.. — disjoint from every other seed range in the
       project: eval seeds are 42+7k, and ui/build-ui.js sweeps recon
       over 1000+7k, which an earlier 1001.. warm-up range collided
       with at 1007. Far away and obviously so. */
    const warmupSeeds = Array.from({ length: warmup }, (_, i) => 90001 + i);
    let bandit0 = createBandit({ priors, seed });
    if (warmup > 0) {
      bandit0 = await warmBandit({ bandit: bandit0, rates, priors, records, rounds, evalSeed: seed, warmupSeeds });
    }

    const { baseline, smart, ev, bandit } = await compareAll({ ledger, rates, priors, seed, rounds, bandit: bandit0 });

    const R = (p) => "\u20B9" + (p / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 });
    const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "\u2014");
    const row = (label, ...vals) => console.log(`  ${label.padEnd(26)}${vals.map((x) => String(x).padStart(14)).join("")}`);

    console.log(`\n  warm-up: bandit trained on ${warmup} held-out population(s), seeds ${warmupSeeds[0]}\u2013${warmupSeeds[warmupSeeds.length-1] || "\u2014"} \u00b7 evaluated on seed ${seed} (never trained on)`);
    console.log(`\n\u2500\u2500 CORRECTED RECOVERY RUN \u00b7 seed ${seed} \u00b7 ${baseline.atRiskCount} at-risk \u00b7 ${R(baseline.atRiskValuePaise)} at stake \u00b7 ${rounds} rounds \u2500\u2500`);
    console.log(`\n  ${"".padEnd(26)}${["baseline", "smart", "ev+bandit"].map((s) => s.padStart(14)).join("")}`);
    row("records recovered", baseline.paidCount, smart.paidCount, ev.paidCount);
    row("recovery rate (count)", pct(baseline.paidCount, baseline.atRiskCount), pct(smart.paidCount, smart.atRiskCount), pct(ev.paidCount, ev.atRiskCount));
    console.log("");
    row("gross recovered", R(baseline.grossPaise), R(smart.grossPaise), R(ev.grossPaise));
    row("recovery rate (VALUE)", pct(baseline.grossPaise, baseline.atRiskValuePaise), pct(smart.grossPaise, smart.atRiskValuePaise), pct(ev.grossPaise, ev.atRiskValuePaise));
    console.log("");
    row("escalations", baseline.escalations, smart.escalations, ev.escalations);
    row("  reviewer labour", R(baseline.escalationCostPaise), R(smart.escalationCostPaise), R(ev.escalationCostPaise));
    row("messaging cost", R(baseline.costPaise - baseline.escalationCostPaise), R(smart.costPaise - smart.escalationCostPaise), R(ev.costPaise - ev.escalationCostPaise));
    row("opt-outs", baseline.optOuts, smart.optOuts, ev.optOuts);
    row("opt-out loss", R(baseline.optOutLossPaise), R(smart.optOutLossPaise), R(ev.optOutLossPaise));
    console.log("");
    row("NET recovered", R(baseline.netPaise), R(smart.netPaise), R(ev.netPaise));

    console.log(`\n  delta vs baseline, net:   smart ${R(smart.netPaise - baseline.netPaise)}   \u00b7   ev+bandit ${R(ev.netPaise - baseline.netPaise)}`);

    const a = ev.approvalStats;
    console.log(`\n\u2500\u2500 DUAL-CONTROL REVIEW DESK (ev arm) \u2500\u2500`);
    console.log(`  reviews requested ${a.reviews_requested} \u00b7 approved ${a.approved} \u00b7 rejected ${a.rejected} \u00b7 still pending ${a.still_pending}`);
    console.log(`  config: ${(a.approval_rate_config * 100).toFixed(0)}% approval rate, ${a.latency_rounds_config}-round latency \u2014 an OPS assumption, swept not asserted`);
    if (a.still_pending) console.log(`  \u26a0 ${a.still_pending} review(s) unresolved at window close \u2014 work in progress, not failed recovery`);

    const rev = bandit.revisions();
    console.log(`\n\u2500\u2500 WHAT THE BANDIT LEARNED \u2500\u2500`);
    if (!rev.length) console.log("  no arm gathered enough evidence to move off its prior this run");
    for (const r of rev.slice(0, 8)) {
      console.log(`  ${(r.ctx + " / " + r.channel).padEnd(38)} prior ${(r.prior * 100).toFixed(1).padStart(5)}%  \u2192  ${(r.belief * 100).toFixed(1).padStart(5)}%  (${r.pulls} pulls)`);
    }

    /* verifyChain is a free function returning {ok}, not a method on
       the chain returning {valid}. Calling a method that does not
       exist yielded undefined and printed "BROKEN" on a chain that
       was perfectly intact — a false alarm is its own kind of bug in
       an integrity check. */
    const vr = verifyChain(ev.audit.entries());
    console.log(`\n\u2500\u2500 AUDIT \u2500\u2500`);
    console.log(`  ev-arm chain entries ${ev.audit.length()} \u00b7 integrity ${vr.ok ? "intact" : "BROKEN at seq " + vr.brokenAt}`);
    console.log(`  head ${ev.audit.head().slice(0, 26)}\u2026  (reproduces exactly on the same seed)`);
    console.log("");
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runBatch2, compareAll, warmBandit };
