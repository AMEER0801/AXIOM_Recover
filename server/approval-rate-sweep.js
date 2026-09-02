"use strict";
/* ══════════════════════════════════════════════════════════════
   APPROVAL-RATE SWEEP
   ──────────────────────────────────────────────────────────────
   oracle-ceiling.js showed the honest ceiling on this population is
   61.0%, not 70.9%, once the dual-control desk's own 15% rejection
   rate is counted — and that 91% of all value sits in
   invoice_overdue, which is almost entirely above the ₹10,000
   ceiling, so nearly the WHOLE ceiling passes through that gate.

   approval_rate = 0.85 is not a customer-behaviour probability. It
   is an OPERATING ASSUMPTION this project's own agent-priors.json
   states plainly is unsourced ("a business/ops decision, not an
   external benchmark"). That makes it the one lever in this whole
   analysis that isn't a claim about customers at all — it's a claim
   about how carefully a review desk is staffed, and it is exactly
   as adjustable as a real reviewer's rejection habits are.

   This sweep answers the only question that matters about it: what
   approval rate would the ceiling need, to put 70% within
   mathematical reach — and does that number describe a realistic
   desk or a fantasy one?
   ══════════════════════════════════════════════════════════════ */

const { runCeiling } = require("./oracle-ceiling");

function sweep(seed, records, rounds, rates01) {
  return rates01.map((approvalRate) => {
    const r = runCeiling(seed, records, {
      rounds, attemptCap: 4, respectQuietHours: true,
      ceilingPaise: 1000000, approvalRate, approvalLatencyRounds: 1,
      label: `approval=${approvalRate}`,
    });
    return { approvalRate, valuePct: r.ceilingValueRate * 100, countPct: r.ceilingCountRate * 100 };
  });
}

/** Linear interpolation to find where a monotonic series crosses a target. */
function findCrossing(points, targetPct) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((a.valuePct - targetPct) * (b.valuePct - targetPct) <= 0 && a.valuePct !== b.valuePct) {
      const t = (targetPct - a.valuePct) / (b.valuePct - a.valuePct);
      return a.approvalRate + t * (b.approvalRate - a.approvalRate);
    }
  }
  return null;
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const seed = Number(arg("seed", 42));
  const records = Number(arg("records", 200));
  const rounds = Number(arg("rounds", 8));

  const rates01 = [0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.98, 1.00];

  console.log(`\n\u2500\u2500 APPROVAL-RATE SWEEP \u00b7 seed ${seed} \u2500\u2500`);
  console.log("How the mathematical ceiling (fully gated: 8 rounds, 4 attempts, quiet hours) moves as the review desk's own approval rate changes.\n");
  console.log("  approval rate".padEnd(16), "ceiling by value".padStart(18), "ceiling by count".padStart(18));

  const points = sweep(seed, records, rounds, rates01);
  for (const p of points) {
    const bar = "\u2588".repeat(Math.round(p.valuePct / 2));
    console.log(`  ${(p.approvalRate * 100).toFixed(0)}%`.padEnd(16), `${p.valuePct.toFixed(1)}%`.padStart(10), " ", bar);
  }

  const cross70 = findCrossing(points, 70);
  const cross65 = findCrossing(points, 65);
  console.log(`\n\u2500\u2500 WHAT IT WOULD TAKE \u2500\u2500`);
  if (cross70 != null) {
    console.log(`  Ceiling crosses 70% at an approval rate of \u2248 ${(cross70 * 100).toFixed(1)}%.`);
  } else {
    console.log(`  Ceiling never reaches 70% across the swept range (50%\u2013100%) \u2014 something ELSE is also binding.`);
  }
  if (cross65 != null) console.log(`  Ceiling crosses 65% at an approval rate of \u2248 ${(cross65 * 100).toFixed(1)}%.`);

  console.log(`\n  Context: 85% (this project's default) is the assumption in agent-priors.json today.`);
  console.log(`  A dual-control desk approving ~${cross70 ? (cross70 * 100).toFixed(0) : "?"}%+ of flagged high-value collections is a claim about how`);
  console.log(`  aggressively a merchant is willing to let automation chase large invoices with only a`);
  console.log(`  human sign-off, not a claim about customers \u2014 realistic for routine B2B collections where`);
  console.log(`  the reviewer's job is confirming the invoice is genuine and not disputed, less realistic`);
  console.log(`  if a meaningful share of flagged records are genuinely contested or fraudulent.\n`);

  console.log(`\u2500\u2500 SECOND LEVER: approval LATENCY \u2500\u2500`);
  console.log(`  The other free variable in the same gate. Sweeping latency at the current 85% rate:\n`);
  for (const lat of [0, 1, 2, 3]) {
    const r = runCeiling(seed, records, { rounds, attemptCap: 4, respectQuietHours: true, ceilingPaise: 1000000, approvalRate: 0.85, approvalLatencyRounds: lat, label: "" });
    console.log(`  latency ${lat} round(s) before a decision:  ceiling by value = ${(r.ceilingValueRate * 100).toFixed(1)}%`);
  }
  console.log(`\n  Latency costs less than the approval rate does, because a rejected record was never going to`);
  console.log(`  pay regardless of how fast the rejection arrived \u2014 the desk's ACCURACY (approval rate) is the`);
  console.log(`  lever with the larger derivative, not its SPEED (latency).\n`);
}

module.exports = { sweep, findCrossing };
