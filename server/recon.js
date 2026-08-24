"use strict";
/* ══════════════════════════════════════════════════════════════
   RECONCILER  (Track 4 loop, and the verifier for Track 3)
   ──────────────────────────────────────────────────────────────
   Matches captured payments against settlement lines, and for
   every gap either EXPLAINS it or escalates it.

   ── The distinction this whole file turns on ─────────────────
   A reconciler that flags every anomaly scores perfect recall and
   is useless. On this batch, two of the eight break classes are
   not losses at all:

     timing_split     one payment settled across two batches
     refund_netting   a refund deducted before settlement

   Both look exactly like a shortfall to a matcher that compares
   one payment to one line and stops. Flagging them means a person
   spends an afternoon confirming that nothing was wrong. So the
   question is never "does this line differ from expected" — it is
   "can the difference be accounted for from evidence already in
   the ledger". Only what survives that becomes an exception.

   ── The confidence ladder ────────────────────────────────────
   Every payment lands on exactly one rung, and the rung is
   reported. A single "match rate" hides the difference between
   an exact tie-out and a judgement call, and those should not be
   trusted equally by whoever reads the report.

     exact              settles to the paisa, one line
     explained_split    n lines sum to expected
     explained_refund   gap equals a refund joined from the ledger
     explained_fee      gap is a fee variance inside a stated band
     flagged_duplicate  two captures, one order — needs a refund out
     unexplained        genuine break, goes to a human
     orphan_credit      money in with no payment behind it

   Only `unexplained`, `flagged_duplicate` and `orphan_credit`
   reach the exception queue.

   ── Why the fee band is deliberately imperfect ───────────────
   A fee variance and a small amount mismatch overlap in size.
   There is no rule that separates them cleanly, and inventing one
   tuned to this batch would be fitting the answer key rather than
   reconciling. The band is stated, the misclassifications it
   causes are counted, and both appear in the report.
   ══════════════════════════════════════════════════════════════ */

const { rupees } = require("./lib/schema");

/* Widest share of the computed fee that a shortfall may be and
   still be called a fee variance rather than a break. Stated here
   as one number so a reviewer can move it and watch precision and
   recall trade against each other, which is the honest way to
   present a threshold. */
const FEE_VARIANCE_BAND = 0.60;

/* Two captures for the same customer and amount inside this window
   are treated as one order paid twice. Longer, and genuine repeat
   purchases start getting flagged. */
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

/* Minutes an operator spends confirming one flagged exception.
   Used to price false positives — the number that makes an
   over-flagging reconciler look as expensive as it really is. */
const MINUTES_PER_INVESTIGATION = 7;

function index(ledger) {
  const payments = new Map();
  const settlementsBy = new Map();     /* payment_id -> lines[]           */
  const refundsBy = new Map();         /* payment_id -> refunds[]         */
  const orphanCredits = [];

  for (const r of ledger) {
    if (r.kind === "payment_captured") {
      payments.set(r.entity.id, r);
    } else if (r.kind === "settlement_line") {
      if (r.settles_payment_id) {
        if (!settlementsBy.has(r.settles_payment_id)) settlementsBy.set(r.settles_payment_id, []);
        settlementsBy.get(r.settles_payment_id).push(r);
      } else {
        orphanCredits.push(r);
      }
    } else if (r.kind === "refund_processed" && r.refunds_payment_id) {
      if (!refundsBy.has(r.refunds_payment_id)) refundsBy.set(r.refunds_payment_id, []);
      refundsBy.get(r.refunds_payment_id).push(r);
    }
  }
  return { payments, settlementsBy, refundsBy, orphanCredits };
}

/**
 * Detect captures that look like one order paid twice.
 * Grouped on (merchant, customer, amount) inside a time window —
 * not on order id, because the duplicate case in the wild is
 * precisely the one where the second capture carries its own ids.
 */
function findDuplicates(payments) {
  const groups = new Map();
  for (const p of payments.values()) {
    const k = `${p.merchant_id}|${p.customer.id}|${p.amount_paise}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  const dupes = new Map();             /* payment_id -> {partner, role} */
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (let i = 1; i < g.length; i++) {
      if (Date.parse(g[i].ts) - Date.parse(g[i - 1].ts) <= DUPLICATE_WINDOW_MS) {
        /* BOTH rows are flagged, not just the later one.

           The first run flagged only the duplicate and scored a
           false negative, because the answer key records the break
           against the ORIGINAL payment. That looked like a
           detection failure and was not — the pair was found, the
           wrong half was reported.

           Flagging both is also what an operator needs. "This
           payment is a duplicate" leaves them hunting for the
           other one; two linked rows with roles on them is a
           decision they can act on. */
        dupes.set(g[i - 1].entity.id, { partner: g[i].entity.id, role: "original" });
        dupes.set(g[i].entity.id, { partner: g[i - 1].entity.id, role: "duplicate" });
      }
    }
  }
  return dupes;
}

/**
 * Reconcile a ledger.
 * @param {Array} ledger canonical records
 * @param {object} [opts]
 * @param {number} [opts.feeBand]
 * @returns {{results:Array, orphanCredits:Array, stats:object}}
 */
function reconcile(ledger, opts = {}) {
  const feeBand = opts.feeBand ?? FEE_VARIANCE_BAND;
  const { payments, settlementsBy, refundsBy, orphanCredits } = index(ledger);
  const duplicates = findDuplicates(payments);

  const results = [];

  for (const [payId, p] of payments) {
    const lines = settlementsBy.get(payId) || [];
    const refunds = refundsBy.get(payId) || [];

    const fee = p.fee_paise ?? 0;
    const tax = p.tax_paise ?? 0;
    const refunded = refunds.reduce((a, r) => a + r.amount_paise, 0);

    /* What the settlement SHOULD be, given everything the ledger
       already knows. Refunds are part of the expectation, not a
       surprise to be explained after the fact. */
    const expected = p.amount_paise - fee - tax - refunded;
    const settled = lines.reduce((a, l) => a + l.amount_paise, 0);
    const delta = settled - expected;

    const base = {
      payment_id: payId,
      merchant_id: p.merchant_id,
      gross_paise: p.amount_paise,
      fee_paise: fee,
      tax_paise: tax,
      refunded_paise: refunded,
      expected_paise: expected,
      settled_paise: settled,
      delta_paise: delta,
      settlement_lines: lines.length,
      evidence: [],
    };

    /* A duplicate is a finding regardless of whether it settles
       cleanly — in fact it usually DOES settle cleanly, which is
       exactly why a delta-only reconciler never sees it. Checked
       before the delta logic for that reason. */
    if (duplicates.has(payId)) {
      const d = duplicates.get(payId);
      const partner = payments.get(d.partner);
      const gapSec = Math.round(Math.abs(Date.parse(p.ts) - Date.parse(partner.ts)) / 1000);
      results.push({
        ...base,
        tier: "flagged_duplicate",
        reconciles: false,
        severity: "high",
        explanation: d.role === "duplicate"
          ? `duplicate capture — ${rupees(p.amount_paise)} taken a second time ${gapSec}s after ${d.partner}; this one is owed back`
          : `original capture — ${d.partner} charged the same customer ${rupees(p.amount_paise)} again ${gapSec}s later`,
        evidence: [`role: ${d.role}`, `paired with: ${d.partner}`, `gap: ${gapSec}s`, `same customer, same amount, same merchant`],
        action: d.role === "duplicate" ? "REFUND_DUPLICATE" : "REVIEW_PAIR",
      });
      continue;
    }

    if (lines.length === 0) {
      results.push({
        ...base,
        tier: "unexplained",
        reconciles: false,
        severity: "high",
        explanation: `captured ${rupees(p.amount_paise)}, no settlement line in the window`,
        evidence: [`captured ${p.ts}`],
        action: "CHASE_SETTLEMENT",
      });
      continue;
    }

    if (delta === 0) {
      const explainedBy = [];
      if (refunded > 0) explainedBy.push(`refund of ${rupees(refunded)} netted`);
      if (lines.length > 1) explainedBy.push(`${lines.length} settlement batches`);

      const tier = lines.length > 1 ? "explained_split"
                 : refunded > 0 ? "explained_refund"
                 : "exact";

      results.push({
        ...base,
        tier,
        reconciles: true,
        severity: null,
        explanation: explainedBy.length
          ? `ties out once ${explainedBy.join(" and ")} ${explainedBy.length > 1 ? "are" : "is"} accounted for`
          : "ties out to the paisa",
        evidence: lines.map((l) => `${l.entity.id}: ${rupees(l.amount_paise)} on ${l.ts.slice(0, 10)}`),
        action: null,
      });
      continue;
    }

    /* A shortfall proportionate to the fee is a pricing-plan
       difference, not a data error. Overpayment is never a fee
       effect, so the sign is part of the test — a positive delta
       always escalates.

       ── What the first run taught this branch ─────────────────
       This originally returned reconciles:true, and recall came
       back at 56%. Five of the seven misses were fee variances the
       reconciler had explained away. The answer key was right and
       the code was wrong, and the mistake was a conflation:

           "I can explain this"  !=  "nobody needs to see this"

       A fee variance IS explainable and IS money the merchant did
       not expect to lose. It belongs in the queue — just not next
       to a duplicate charge. So it stays an exception and carries
       a severity instead, which is what makes the queue triaged
       rather than a flat pile a person has to re-sort by hand.

       The alternative was to relabel fee_variance as reconciling
       in the answer key. That would have moved recall to 93% and
       meant nothing, because the key would have been edited to
       match the result. */
    if (delta < 0 && fee > 0 && Math.abs(delta) <= fee * feeBand) {
      const pct = ((Math.abs(delta) / fee) * 100).toFixed(1);
      results.push({
        ...base,
        tier: "explained_fee",
        reconciles: false,
        severity: "low",
        explanation: `short by ${rupees(-delta)}, which is ${pct}% of the ${rupees(fee)} fee — consistent with a pricing-plan variance`,
        evidence: [`fee applied differs from fee expected`, `within the stated ${(feeBand * 100).toFixed(0)}% band`, `explained, but still money not received`],
        action: "CONFIRM_PRICING_PLAN",
      });
      continue;
    }

    results.push({
      ...base,
      tier: "unexplained",
      reconciles: false,
      severity: "high",
      explanation: delta > 0
        ? `settled ${rupees(delta)} MORE than expected — an overpayment is never a fee effect`
        : `short by ${rupees(-delta)}, beyond what the fee or any joined refund accounts for`,
      evidence: [
        `gross ${rupees(p.amount_paise)}`,
        `fee ${rupees(fee)} + tax ${rupees(tax)}`,
        refunded ? `refund ${rupees(refunded)}` : "no refund on file",
        `expected ${rupees(expected)}, settled ${rupees(settled)}`,
      ],
      action: "ESCALATE_HUMAN",
    });
  }

  const byTier = {};
  for (const r of results) byTier[r.tier] = (byTier[r.tier] || 0) + 1;

  const bySeverity = { high: 0, low: 0 };
  for (const r of results) if (r.severity) bySeverity[r.severity]++;

  const exceptions = results.filter((r) => !r.reconciles);

  const stats = {
    payments_examined: results.length,
    reconciled: results.filter((r) => r.reconciles).length,
    exceptions: exceptions.length,
    orphan_credits: orphanCredits.length,
    match_rate: results.length ? results.filter((r) => r.reconciles).length / results.length : 0,
    by_tier: byTier,
    by_severity: bySeverity,
    fee_variance_band: feeBand,
    value_reconciled_paise: results.filter((r) => r.reconciles).reduce((a, r) => a + r.settled_paise, 0),
    value_in_exception_paise: exceptions.reduce((a, r) => a + Math.abs(r.expected_paise - r.settled_paise), 0),
    orphan_credit_value_paise: orphanCredits.reduce((a, l) => a + l.amount_paise, 0),
  };

  return { results, orphanCredits, stats };
}

/**
 * Score a reconciliation against the generator's answer key.
 *
 * Positive class = "this payment is an exception". So:
 *   TP  flagged, and truth says it does not reconcile
 *   FP  flagged, and truth says it does      <- costs operator time
 *   FN  passed,  and truth says it does not  <- costs money
 *   TN  passed,  and truth agrees
 *
 * Both error types are reported with their cost, because they are
 * not interchangeable and a single accuracy figure pretends they
 * are.
 */
function score(reconResult, truth) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const falsePositives = [], falseNegatives = [];
  let explainedRight = 0, explainedWrong = 0;
  const misexplained = [];

  for (const r of reconResult.results) {
    const t = truth.payments[r.payment_id];
    if (!t) continue;                          /* not part of the settled cohort */

    const flagged = !r.reconciles;
    const trulyBroken = !t.reconciles;

    if (flagged && trulyBroken) { tp++; }
    else if (flagged && !trulyBroken) { fp++; falsePositives.push({ payment_id: r.payment_id, truth_break: t.break, we_said: r.explanation }); }
    else if (!flagged && trulyBroken) { fn++; falseNegatives.push({ payment_id: r.payment_id, truth_break: t.break, we_said: r.explanation }); }
    else { tn++; }

    /* A reconciler can reach the right verdict via the wrong story
       — call a fee variance a refund and still tie out. The outcome
       is right and the explanation is not, and an operator reading
       "refund netted" on a pricing bug is being actively misled.

       Checked on BOTH sides of the verdict. The first version only
       scored explanations on items that passed, which meant the
       flag/no-flag F1 could read 100% while the reconciler was
       quietly mislabelling why things were flagged. A number that
       clean deserves to be attacked before a reviewer attacks it. */
    const expectedTier = {
      clean: "exact",
      timing_split: "explained_split",
      refund_netting: "explained_refund",
      fee_variance: "explained_fee",
      duplicate_payment: "flagged_duplicate",
      missing_settlement: "unexplained",
      amount_mismatch: "unexplained",
      unmatched_credit: "unexplained",
    }[t.break];

    if (expectedTier) {
      if (r.tier === expectedTier) explainedRight++;
      else {
        explainedWrong++;
        misexplained.push({ payment_id: r.payment_id, truth_break: t.break, our_tier: r.tier, verdict_correct: flagged === trulyBroken });
      }
    }
  }

  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    confusion: { tp, fp, fn, tn },
    precision, recall, f1,
    explanation_accuracy: explainedRight + explainedWrong ? explainedRight / (explainedRight + explainedWrong) : null,
    false_positive_cost_minutes: fp * MINUTES_PER_INVESTIGATION,
    false_negative_value_paise: falseNegatives.reduce((a, x) => {
      const r = reconResult.results.find((y) => y.payment_id === x.payment_id);
      return a + (r ? Math.abs(r.expected_paise - r.settled_paise) : 0);
    }, 0),
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    misexplained,
  };
}

/* ── CLI ──────────────────────────────────────────────────────── */
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

  const dataDir = path.resolve(arg("data", "./data"));
  const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, "ledger.json"), "utf8"));

  /* truth.json is the synthetic seeder's written-in-advance answer
     key. Real, live-captured data (from index.js's webhook
     receiver, exported via export-live-ledger.js) has no such
     thing — nobody knows the "true" classification of a genuine
     external event before the fact, so there is nothing to score
     against. That is expected, not a missing file to fix: this
     mode reports what the reconciler found, with no scorecard,
     rather than crashing or fabricating a comparison that isn't
     possible. Found necessary by a real user hitting this file's
     hard requirement on a directory that never had a truth.json in
     the first place — the earlier version of this script had no
     other option than to throw ENOENT. */
  const truthPath = path.join(dataDir, "truth.json");
  const truth = fs.existsSync(truthPath) ? JSON.parse(fs.readFileSync(truthPath, "utf8")) : null;

  const band = Number(arg("fee-band", FEE_VARIANCE_BAND));
  const out = reconcile(ledger, { feeBand: band });
  const s = truth ? score(out, truth) : null;
  const st = out.stats;

  const pct = (x) => (x * 100).toFixed(1) + "%";

  console.log(`\n── RECONCILIATION ─────────────────────────────────────`);
  console.log(`  payments examined .... ${st.payments_examined}`);
  console.log(`  reconciled ........... ${st.reconciled}   (${pct(st.match_rate)})`);
  console.log(`  exceptions ........... ${st.exceptions}`);
  console.log(`  orphan credits ....... ${st.orphan_credits}  worth ${rupees(st.orphan_credit_value_paise)}`);
  console.log(`  value tied out ....... ${rupees(st.value_reconciled_paise)}`);

  console.log(`\n── CONFIDENCE LADDER ──────────────────────────────────`);
  for (const [tier, n] of Object.entries(st.by_tier).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tier.padEnd(20)} ${String(n).padStart(4)}`);
  }

  console.log(`\n── EXCEPTION QUEUE, TRIAGED ───────────────────────────`);
  console.log(`  high severity ........ ${st.by_severity.high}   (duplicates, missing settlements, unexplained gaps)`);
  console.log(`  low severity ......... ${st.by_severity.low}   (explained, but still money not received)`);

  if (!truth) {
    console.log(`\n── NO ANSWER KEY ───────────────────────────────────────`);
    console.log(`  No truth.json in ${dataDir} — this looks like real, live-captured data, not a`);
    console.log(`  synthetic batch. The reconciliation above is real; there is no scorecard to show`);
    console.log(`  because nobody wrote down the "true" answer for a genuine external event in`);
    console.log(`  advance. Run against ./data (the synthetic seeder's output) to see scoring.`);
  } else {
  console.log(`\n── SCORED AGAINST THE ANSWER KEY ──────────────────────`);
  console.log(`  precision ............ ${pct(s.precision)}   (of what we flagged, how much was real)`);
  console.log(`  recall ............... ${pct(s.recall)}   (of what was real, how much we caught)`);
  console.log(`  F1 ................... ${pct(s.f1)}`);
  if (s.explanation_accuracy !== null) {
    console.log(`  explanation accuracy . ${pct(s.explanation_accuracy)}   (right verdict AND right reason)`);
  }
  console.log(`  confusion ............ TP ${s.confusion.tp}  FP ${s.confusion.fp}  FN ${s.confusion.fn}  TN ${s.confusion.tn}`);

  console.log(`\n── THE COST OF BEING WRONG ────────────────────────────`);
  console.log(`  false positives ...... ${s.confusion.fp} → ${s.false_positive_cost_minutes} operator-minutes burned on non-problems`);
  console.log(`  false negatives ...... ${s.confusion.fn} → ${rupees(s.false_negative_value_paise)} of real breaks shipped as clean`);

  if (s.false_negatives.length) {
    console.log(`\n  missed breaks:`);
    s.false_negatives.slice(0, 8).forEach((x) => console.log(`    · ${x.payment_id}  truth=${x.truth_break}  we said "${x.we_said.slice(0, 62)}"`));
  }
  if (s.false_positives.length) {
    console.log(`\n  false alarms:`);
    s.false_positives.slice(0, 8).forEach((x) => console.log(`    · ${x.payment_id}  truth=${x.truth_break}  we said "${x.we_said.slice(0, 62)}"`));
  }
  if (s.misexplained.length) {
    console.log(`\n  right verdict, wrong reason (${s.misexplained.length}):`);
    s.misexplained.slice(0, 10).forEach((x) => console.log(`    · ${x.payment_id}  truth=${x.truth_break}  we called it ${x.our_tier}`));
    console.log(`\n  These are the cases the flag/no-flag score cannot see. The verdict`);
    console.log(`  was right; the story an operator would read was not.`);
  }
  }

  const exDir = path.join(dataDir, "recon");
  fs.mkdirSync(exDir, { recursive: true });
  fs.writeFileSync(path.join(exDir, "exceptions.json"), JSON.stringify(out.results.filter((r) => !r.reconciles), null, 2));
  fs.writeFileSync(path.join(exDir, "scorecard.json"), JSON.stringify({ stats: st, score: s }, null, 2));
  console.log(`\n  exception queue + scorecard written to ${exDir}\n`);
}

module.exports = { reconcile, score, findDuplicates, FEE_VARIANCE_BAND, MINUTES_PER_INVESTIGATION };
