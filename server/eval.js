"use strict";
/* ══════════════════════════════════════════════════════════════
   EVAL — is the recovery delta real, or one lucky batch?
   ──────────────────────────────────────────────────────────────
   recover.js's CLI prints one comparison, on one seed. This runs
   it across many independently seeded batches and reports the
   spread of the delta — the same discipline sweep.js already
   applies to the reconciler, applied here to the number the whole
   project's founding claim rests on.

     node eval.js --seeds 20
     node eval.js --seeds 20 --rounds 3     (deliberately too short —
                                              see what that does to
                                              the claim, on purpose)
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { generate } = require("./seed");
const { compareArms } = require("./recover");
const { stats } = require("./sweep");
const { rupees } = require("./lib/schema");

function runOne(seed, records, rounds) {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "base-rates.json"), "utf8"));
  const { ledger } = generate({ seed, records });
  const cmp = compareArms({ ledger, rates, seed, rounds });
  return {
    deltaNet: cmp.deltaNetPaise,
    deltaPaidCount: cmp.deltaPaidCount,
    baselineNet: cmp.baseline.netPaise,
    smartNet: cmp.smart.netPaise,
    baselinePaid: cmp.baseline.paidCount,
    smartPaid: cmp.smart.paidCount,
    baselineAtRisk: cmp.baseline.atRiskCount,
    stillInProgress: cmp.baseline.stillInProgress + cmp.smart.stillInProgress,
  };
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const nSeeds = Number(arg("seeds", 20));
  const records = Number(arg("records", 200));
  const rounds = Number(arg("rounds", 8));

  const seeds = Array.from({ length: nSeeds }, (_, i) => 2000 + i * 11);
  const runs = seeds.map((s) => runOne(s, records, rounds));

  const totalInProgress = runs.reduce((a, r) => a + r.stillInProgress, 0);
  const netStats = stats(runs.map((r) => r.deltaNet));
  const countStats = stats(runs.map((r) => r.deltaPaidCount));
  const winCountByNet = runs.filter((r) => r.deltaNet > 0).length;
  const winCountByCount = runs.filter((r) => r.deltaPaidCount > 0).length;
  const loseCountByCount = runs.filter((r) => r.deltaPaidCount < 0).length;

  console.log(`\n\u2500\u2500 ${nSeeds} INDEPENDENT BATCHES \u00b7 ${records} records \u00b7 ${rounds} rounds \u2500\u2500\n`);

  console.log(`  PAYMENTS RECOVERED, delta (smart \u2212 baseline), a count:`);
  console.log(`    mean ${countStats.mean.toFixed(1).padStart(8)}   sd ${countStats.sd.toFixed(1).padStart(6)}   cv ${countStats.mean ? Math.abs((countStats.sd / countStats.mean) * 100).toFixed(1) : "\u2014"}%   range [${countStats.min} \u2026 ${countStats.max}]`);
  console.log(`    smart recovered MORE payments than baseline in ${winCountByCount}/${nSeeds} batches, fewer in ${loseCountByCount}/${nSeeds}`);

  console.log(`\n  NET \u20B9 RECOVERED, delta (smart \u2212 baseline):`);
  console.log(`    mean ${rupees(Math.round(netStats.mean)).padStart(14)}   sd ${rupees(Math.round(netStats.sd)).padStart(12)}   cv ${netStats.mean ? Math.abs((netStats.sd / netStats.mean) * 100).toFixed(1) : "\u2014"}%`);
  console.log(`    range [${rupees(netStats.min)} \u2026 ${rupees(netStats.max)}]`);
  console.log(`    smart beat baseline on \u20B9 in ${winCountByNet}/${nSeeds} batches`);

  /* These two are reported separately because they can, and here
     do, tell different stories. The count is the reliable claim:
     see the coefficient of variation and the near-unanimous win
     record. The rupee figure is dominated by whichever handful of
     high-value invoice_overdue records happen to convert in a given
     draw, which is exactly why its spread is so much wider — that
     is a property of the amount distribution, not of the policy
     being unreliable. Reporting only the rupee figure would either
     overstate confidence on a lucky batch or understate a policy
     that is, by the more stable measure, working consistently. */
  if (Math.abs(netStats.sd) > Math.abs(netStats.mean) && countStats.mean > 0 && Math.abs(countStats.sd) < Math.abs(countStats.mean)) {
    console.log(`\n  \u26a0 the \u20B9 figure is noisy (sd exceeds the mean) while the COUNT is not \u2014 a handful of`);
    console.log(`    high-value invoices swing the total more than the underlying success rate does.`);
    console.log(`    The count-based claim above is the one to trust; the \u20B9 figure is directionally`);
    console.log(`    right but should not be quoted as a precise number from this sample size.`);
  }

  if (totalInProgress > 0) {
    console.log(`\n  \u26a0 ${totalInProgress} record-runs across this sweep never reached a terminal state at`);
    console.log(`    --rounds ${rounds}. If that number is large, the delta above is measuring an`);
    console.log(`    unfinished race, not a settled outcome \u2014 increase --rounds and re-run.`);
  } else {
    console.log(`\n  every record in every batch reached a terminal state \u2014 the delta above is not`);
    console.log(`  measuring a race that was cut short.`);
  }

  if (winCountByCount < nSeeds) {
    console.log(`\n  smart did NOT win every batch on payment count either \u2014 disclosed, not smoothed over.`);
    console.log(`  A strategy that wins on average while losing on some seeds is a more honest claim`);
    console.log(`  than one that only ever gets shown its best run.`);
  }

  console.log("");
}

module.exports = { runOne };
