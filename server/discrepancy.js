"use strict";
/* ══════════════════════════════════════════════════════════════
   DISCREPANCY — money owed by Razorpay, not by a customer
   ──────────────────────────────────────────────────────────────
   Every other file in this project recovers money a CUSTOMER owes
   the merchant. This one checks a different direction entirely:
   money the PLATFORM owes the merchant, because the fee it charged
   does not match what the merchant actually contracted.

   ── Why recon.js cannot catch this ────────────────────────────
   recon.js proves INTERNAL consistency: does the settlement match
   the fee that was recorded on the payment? That is a real and
   necessary check, and it will report a payment as `exact` —
   perfectly clean — the moment the settlement correctly reflects
   whatever fee was actually deducted, with no opinion on whether
   that fee itself was the RIGHT one to deduct.

   This file checks EXTERNAL correctness instead: does the recorded
   fee match the rate the merchant actually negotiated? A billing
   system that silently reverts a merchant's special rate back to
   the standard one produces books that are internally perfect —
   every settlement ties out against the (wrong) fee that was
   charged — while the merchant is being systematically overcharged
   in a way reconciliation alone will never surface. Two different
   claims, two different files, on purpose.

   ── What this does NOT do, and why ────────────────────────────
   Razorpay's public API was checked before this was built, not
   assumed. Its Disputes API (razorpay.com/docs/api/disputes/)
   exists for the opposite direction — a customer or issuing bank
   disputing a payment — and only supports accepting or contesting
   a dispute already raised, never filing one. There is no public
   endpoint for a merchant to programmatically dispute Razorpay's
   own fee calculation; that path is a support request, not an API
   call. So this file does not "file" anything. It produces a
   complete, evidence-backed claim, ready for a human to paste into
   a support ticket — automating the tedious 90% (finding the
   pattern, gathering the evidence, computing the numbers) and
   leaving the actual submission, correctly, to a person.

   ── Aggregation, not one ticket per transaction ────────────────
   A rate misconfiguration is an account-level condition, not a
   per-transaction accident — it affects every charge on that
   account until someone fixes the configuration. Filing one ticket
   per affected payment would be spam and would bury the actual
   pattern a support agent needs to see. This groups findings by
   merchant into ONE pattern claim citing the count, the consistent
   rate delta, and the cumulative amount — the way a real finance
   team would actually raise it.
   ══════════════════════════════════════════════════════════════ */

const crypto = require("crypto");
const { CONTRACTED_MDR_BPS } = require("./seed");
const { rupees } = require("./lib/schema");

const CLAIM_POLICY = Object.freeze({
  /* A difference this small and smaller is rounding noise, not a
     rate error — business decision, not a citation. */
  rateToleranceBps: 1,
  /* Below this cumulative amount, a pattern is logged but marked
     "monitor" rather than "file" — the ticket costs staff time
     too, and a ₹15 pattern is not worth spending it. */
  minPatternTotalPaise: 2000,
  minPatternTransactionCount: 3,
  /* A one-off finding that never reaches pattern scale still gets
     its own claim if the single amount alone clears this bar. */
  minIndividualClaimPaise: 5000,
});

/**
 * Independently recompute the expected fee for every captured
 * payment from the merchant's CONTRACTED rate — a completely
 * separate reference from anything recon.js reads — and flag
 * where the recorded fee doesn't match it.
 *
 * @param {Array} ledger canonical records
 * @returns {Array<object>} one entry per payment with a
 *   rate mismatch beyond tolerance (in EITHER direction — see
 *   buildPatternClaims for why only overcharges become claims)
 */
function detectRateDiscrepancies(ledger) {
  const findings = [];
  for (const p of ledger) {
    if (p.kind !== "payment_captured") continue;
    const contractedBps = CONTRACTED_MDR_BPS[p.merchant_id];
    if (contractedBps === undefined) continue;   /* unknown merchant: skip, never guess a contract we don't have */
    if (!p.amount_paise) continue;

    const recordedFee = p.fee_paise ?? 0;
    const expectedFee = Math.round((p.amount_paise * contractedBps) / 10000);
    /* Expressed as an implied rate, not a raw paise delta, so the
       tolerance check is meaningful across wildly different ticket
       sizes — ₹3 off on a ₹150 charge and ₹300 off on a ₹15,000
       charge can be the identical rate error. */
    const impliedBps = (recordedFee / p.amount_paise) * 10000;
    const bpsDelta = impliedBps - contractedBps;
    if (Math.abs(bpsDelta) <= CLAIM_POLICY.rateToleranceBps) continue;

    findings.push({
      payment_id: p.entity.id,
      merchant_id: p.merchant_id,
      ts: p.ts,
      amount_paise: p.amount_paise,
      contracted_bps: contractedBps,
      implied_bps: Math.round(impliedBps * 100) / 100,
      recorded_fee_paise: recordedFee,
      expected_fee_paise: expectedFee,
      /* Positive = merchant was charged more than contracted, i.e.
         Razorpay owes the difference. Negative = merchant was
         charged LESS than contracted — not a claim (nobody disputes
         being undercharged), logged for audit completeness only. */
      overcharge_paise: recordedFee - expectedFee,
    });
  }
  return findings;
}

function claimId(merchantId, paymentIds) {
  return "disc_" + crypto.createHash("sha256").update(merchantId + "|" + paymentIds.sort().join(",")).digest("hex").slice(0, 16);
}

/**
 * Group overcharge findings by merchant into pattern claims.
 * Undercharges are excluded from claims entirely — see the field
 * comment on `overcharge_paise` — but nothing about them is
 * silently dropped from the underlying findings array a caller
 * can still inspect.
 */
function buildPatternClaims(findings) {
  const byMerchant = new Map();
  for (const f of findings) {
    if (f.overcharge_paise <= 0) continue;
    if (!byMerchant.has(f.merchant_id)) byMerchant.set(f.merchant_id, []);
    byMerchant.get(f.merchant_id).push(f);
  }

  const claims = [];
  for (const [merchantId, items] of byMerchant) {
    const totalOvercharge = items.reduce((a, i) => a + i.overcharge_paise, 0);
    const avgImpliedBps = items.reduce((a, i) => a + i.implied_bps, 0) / items.length;
    const readyToFile = items.length >= CLAIM_POLICY.minPatternTransactionCount
                      && totalOvercharge >= CLAIM_POLICY.minPatternTotalPaise;

    const ids = items.map((i) => i.payment_id);
    claims.push({
      claim_id: claimId(merchantId, ids),
      type: "pattern",
      status: readyToFile ? "drafted" : "monitor",
      merchant_id: merchantId,
      transaction_count: items.length,
      total_overcharge_paise: totalOvercharge,
      contracted_bps: items[0].contracted_bps,
      observed_bps: Math.round(avgImpliedBps * 100) / 100,
      period_start: items.reduce((a, i) => (i.ts < a ? i.ts : a), items[0].ts),
      period_end: items.reduce((a, i) => (i.ts > a ? i.ts : a), items[0].ts),
      sample_payment_ids: ids.slice(0, 5),
      all_payment_ids: ids,
    });
  }
  return claims;
}

/**
 * A one-off finding that never accumulates into a merchant-level
 * pattern still deserves its own claim if it clears the individual
 * bar alone. Present in the current synthetic data only if the
 * phenomenon generating it ever stops being purely account-level —
 * kept as a real, tested code path rather than a stub, since a
 * future extension to per-transaction (rather than per-account)
 * rate errors should not require writing this from scratch.
 */
function buildIndividualClaims(findings, patternClaims) {
  const alreadyClaimed = new Set(patternClaims.flatMap((c) => c.all_payment_ids));
  return findings
    .filter((f) => f.overcharge_paise >= CLAIM_POLICY.minIndividualClaimPaise && !alreadyClaimed.has(f.payment_id))
    .map((f) => ({
      claim_id: claimId(f.merchant_id, [f.payment_id]),
      type: "individual",
      status: "drafted",
      merchant_id: f.merchant_id,
      transaction_count: 1,
      total_overcharge_paise: f.overcharge_paise,
      contracted_bps: f.contracted_bps,
      observed_bps: f.implied_bps,
      period_start: f.ts,
      period_end: f.ts,
      sample_payment_ids: [f.payment_id],
      all_payment_ids: [f.payment_id],
    }));
}

/** Render a claim as the ticket text a human pastes into support. */
function renderClaimText(claim) {
  const pct = (bps) => (bps / 100).toFixed(2) + "%";
  const lines = [
    `# Fee Discrepancy Claim — ${claim.merchant_id}`,
    ``,
    `**Claim ID:** ${claim.claim_id}`,
    `**Status:** ${claim.status}${claim.status === "monitor" ? " (below the filing threshold — tracked, not yet submitted)" : ""}`,
    `**Type:** ${claim.type === "pattern" ? "Systematic MDR misapplication" : "Single-transaction fee mismatch"}`,
    ``,
    `## What we found`,
    `${claim.transaction_count} transaction${claim.transaction_count === 1 ? "" : "s"} on this account ${claim.transaction_count === 1 ? "was" : "were"} charged a merchant discount rate of **${pct(claim.observed_bps)}**, but our contracted rate is **${pct(claim.contracted_bps)}**.`,
    ``,
    `- Period: ${claim.period_start.slice(0, 10)} to ${claim.period_end.slice(0, 10)}`,
    `- Cumulative overcharge: **${rupees(claim.total_overcharge_paise)}**`,
    `- Sample payment ID${claim.sample_payment_ids.length === 1 ? "" : "s"} (${claim.sample_payment_ids.length} of ${claim.transaction_count}): ${claim.sample_payment_ids.join(", ")}`,
    ``,
    `## Requested action`,
    `Please confirm the merchant discount rate configured on this account matches our contracted ${pct(claim.contracted_bps)} rate. If the ${pct(claim.observed_bps)} rate was applied in error, we request a credit of ${rupees(claim.total_overcharge_paise)} for the affected transactions listed above.`,
    ``,
    `---`,
    `*Generated automatically from a reconciliation of this account's settlement records against its contracted rate card. Full transaction list and computation available on request.*`,
  ];
  return lines.join("\n");
}

/**
 * Score detection against the ground truth — same discipline as
 * recon.js: precision (of what we flagged, how much was real) and
 * recall (of what was real, how much we caught), not just a count.
 */
function score(findings, truth) {
  const foundIds = new Set(findings.map((f) => f.payment_id));
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const [id, t] of Object.entries(truth.payments)) {
    if (t.rate_matches_contract === undefined) continue;   /* older truth.json without this field */
    const trulyWrong = t.rate_matches_contract === false;
    const flagged = foundIds.has(id);
    if (flagged && trulyWrong) tp++;
    else if (flagged && !trulyWrong) fp++;
    else if (!flagged && trulyWrong) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { confusion: { tp, fp, fn, tn }, precision, recall };
}

/* ── CLI ──────────────────────────────────────────────────────── */
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const dataDir = path.resolve(arg("data", "./data"));

  const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, "ledger.json"), "utf8"));
  /* Optional, same reasoning as recon.js: real, live-captured data
     has no written-in-advance answer key. Detection itself needs
     nothing from truth.json — CONTRACTED_MDR_BPS is a fixed table,
     not derived from it — only the scorecard does. */
  const truthPath = path.join(dataDir, "truth.json");
  const truth = fs.existsSync(truthPath) ? JSON.parse(fs.readFileSync(truthPath, "utf8")) : null;

  const findings = detectRateDiscrepancies(ledger);
  const patternClaims = buildPatternClaims(findings);
  const individualClaims = buildIndividualClaims(findings, patternClaims);
  const allClaims = [...patternClaims, ...individualClaims];
  const sc = truth ? score(findings, truth) : null;

  const pct = (x) => (x * 100).toFixed(1) + "%";

  console.log(`\n\u2500\u2500 DISCREPANCY DETECTION \u2500\u2500`);
  console.log(`  payments examined ...... ${ledger.filter((r) => r.kind === "payment_captured").length}`);
  console.log(`  rate mismatches found .. ${findings.length}`);
  console.log(`  overcharges (claimable). ${findings.filter((f) => f.overcharge_paise > 0).length}`);
  console.log(`  undercharges (audit only) ${findings.filter((f) => f.overcharge_paise < 0).length}`);

  if (!truth) {
    console.log(`\n\u2500\u2500 NO ANSWER KEY \u2500\u2500`);
    console.log(`  No truth.json in ${dataDir} — real, live-captured data has no such thing. Detection`);
    console.log(`  above is real; note that real merchant IDs won't match this project's synthetic`);
    console.log(`  CONTRACTED_MDR_BPS table (acme_retail, kovai_textiles, ...) and will be correctly`);
    console.log(`  skipped rather than guessed at, so 0 findings on real data is expected here.`);
  } else {
  console.log(`\n\u2500\u2500 SCORED AGAINST THE ANSWER KEY \u2500\u2500`);
  console.log(`  precision .............. ${pct(sc.precision)}`);
  console.log(`  recall ................. ${pct(sc.recall)}`);
  console.log(`  confusion .............. TP ${sc.confusion.tp}  FP ${sc.confusion.fp}  FN ${sc.confusion.fn}  TN ${sc.confusion.tn}`);
  }

  console.log(`\n\u2500\u2500 CLAIMS \u2500\u2500`);
  if (!allClaims.length) {
    console.log(`  none this batch.`);
  }
  for (const c of allClaims) {
    console.log(`\n  [${c.status.toUpperCase()}] ${c.claim_id} \u2014 ${c.merchant_id}`);
    console.log(`    ${c.transaction_count} txn(s), ${rupees(c.total_overcharge_paise)} cumulative, ${(c.contracted_bps / 100).toFixed(2)}% contracted vs ${(c.observed_bps / 100).toFixed(2)}% observed`);
  }

  const outDir = path.join(dataDir, "discrepancy");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "findings.json"), JSON.stringify(findings, null, 2));
  fs.writeFileSync(path.join(outDir, "claims.json"), JSON.stringify(allClaims, null, 2));
  fs.writeFileSync(path.join(outDir, "scorecard.json"), JSON.stringify(sc, null, 2));
  for (const c of allClaims) {
    fs.writeFileSync(path.join(outDir, `${c.claim_id}.md`), renderClaimText(c));
  }
  console.log(`\n  written to ${outDir}/ \u2014 one .md ticket draft per claim, ready to paste into Razorpay support.\n`);
}

module.exports = {
  detectRateDiscrepancies, buildPatternClaims, buildIndividualClaims,
  renderClaimText, score, claimId, CLAIM_POLICY,
};
