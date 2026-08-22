"use strict";
/* ══════════════════════════════════════════════════════════════
   RECONCILER SWEEP
   ──────────────────────────────────────────────────────────────
   One batch scoring 100% is not a result. It is one batch.

   This runs the reconciler across many independently seeded
   batches and reports the spread, using the same statistics the
   AXIOM benchmark module uses on model runs: mean, standard
   deviation, and coefficient of variation, with anything above
   10% CV marked unstable rather than quietly averaged.

   It also sweeps the one threshold in the reconciler — the fee
   variance band — so the threshold is presented as a curve a
   reader can disagree with, rather than a number that appeared
   from nowhere already tuned.

     node sweep.js --seeds 25
     node sweep.js --seeds 25 --band-sweep
   ══════════════════════════════════════════════════════════════ */

const { generate } = require("./seed");
const { reconcile, score, FEE_VARIANCE_BAND } = require("./recon");

/* Same estimator as the AXIOM benchmark module — sample standard
   deviation (n-1), because these are samples of possible batches,
   not the population of all batches. */
function stats(xs) {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, sd: 0, cv: 0, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, cv: mean ? (sd / mean) * 100 : 0, min: Math.min(...xs), max: Math.max(...xs) };
}

function runOne(seed, records, band) {
  const { ledger, truth } = generate({ seed, records });
  const out = reconcile(ledger, { feeBand: band });
  const s = score(out, truth);
  return {
    precision: s.precision,
    recall: s.recall,
    f1: s.f1,
    explanation_accuracy: s.explanation_accuracy ?? 1,
    fp: s.confusion.fp,
    fn: s.confusion.fn,
    fp_minutes: s.false_positive_cost_minutes,
    fn_value: s.false_negative_value_paise,
    exceptions: out.stats.exceptions,
    high: out.stats.by_severity.high,
    low: out.stats.by_severity.low,
  };
}

function line(label, st, asPct = true) {
  const f = (x) => (asPct ? (x * 100).toFixed(1) + "%" : x.toFixed(1));
  const flag = st.cv > 10 ? "  UNSTABLE" : "";
  return `  ${label.padEnd(22)} ${f(st.mean).padStart(7)}  ± ${f(st.sd).padStart(6)}   cv ${st.cv.toFixed(1).padStart(5)}%   [${f(st.min)} … ${f(st.max)}]${flag}`;
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const nSeeds = Number(arg("seeds", 25));
  const records = Number(arg("records", 200));
  const bandSweep = process.argv.includes("--band-sweep");

  const seeds = Array.from({ length: nSeeds }, (_, i) => 1000 + i * 7);

  if (!bandSweep) {
    console.log(`\n── ${nSeeds} INDEPENDENT BATCHES · ${records} records each · fee band ${(FEE_VARIANCE_BAND * 100).toFixed(0)}% ──\n`);
    const runs = seeds.map((s) => runOne(s, records, FEE_VARIANCE_BAND));

    console.log(line("precision", stats(runs.map((r) => r.precision))));
    console.log(line("recall", stats(runs.map((r) => r.recall))));
    console.log(line("F1", stats(runs.map((r) => r.f1))));
    console.log(line("explanation accuracy", stats(runs.map((r) => r.explanation_accuracy))));
    console.log("");
    console.log(line("exceptions per batch", stats(runs.map((r) => r.exceptions)), false));
    console.log(line("  high severity", stats(runs.map((r) => r.high)), false));
    console.log(line("  low severity", stats(runs.map((r) => r.low)), false));
    console.log("");
    console.log(line("false positives", stats(runs.map((r) => r.fp)), false));
    console.log(line("false negatives", stats(runs.map((r) => r.fn)), false));

    const perfect = runs.filter((r) => r.f1 === 1).length;
    const perfectExpl = runs.filter((r) => r.explanation_accuracy === 1).length;
    console.log(`\n  batches with a perfect verdict F1 .......... ${perfect}/${nSeeds}`);
    console.log(`  batches with a perfect explanation score ... ${perfectExpl}/${nSeeds}`);
    console.log(`\n  A high verdict F1 here says the flag/no-flag rule is sound on the`);
    console.log(`  eight break classes this generator produces. It says nothing about`);
    console.log(`  a ninth class nobody enumerated, which is what real settlement`);
    console.log(`  files contain. The explanation score is the more honest number.\n`);
  } else {
    console.log(`\n── FEE VARIANCE BAND SWEEP · ${nSeeds} batches per point ──`);
    console.log(`\n  The band is the reconciler's only tunable threshold. Widening it`);
    console.log(`  explains more shortfalls as pricing variance; narrowing it sends`);
    console.log(`  more to a human. Neither end is free.\n`);
    console.log(`  band     precision    recall        F1     expl.acc   low-sev/batch`);
    console.log(`  ─────────────────────────────────────────────────────────────────`);
    for (const band of [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.5]) {
      const runs = seeds.map((s) => runOne(s, records, band));
      const p = stats(runs.map((r) => r.precision)).mean;
      const rc = stats(runs.map((r) => r.recall)).mean;
      const f = stats(runs.map((r) => r.f1)).mean;
      const e = stats(runs.map((r) => r.explanation_accuracy)).mean;
      const lo = stats(runs.map((r) => r.low)).mean;
      const mark = band === FEE_VARIANCE_BAND ? "  <- shipped" : "";
      console.log(`  ${String((band * 100).toFixed(0) + "%").padStart(4)}     ${(p * 100).toFixed(1).padStart(7)}%   ${(rc * 100).toFixed(1).padStart(6)}%   ${(f * 100).toFixed(1).padStart(6)}%    ${(e * 100).toFixed(1).padStart(6)}%   ${lo.toFixed(1).padStart(8)}${mark}`);
    }
    console.log(`\n  At a 0% band nothing is explained as a fee effect, so every`);
    console.log(`  variance escalates and the low-severity queue is empty — the`);
    console.log(`  pricing questions are still there, just mixed in with the real`);
    console.log(`  breaks where a person has to re-sort them.`);
    console.log(`\n  The curve then FLATTENS past 60%, and that flatness is an artefact`);
    console.log(`  of this generator, not a property of settlement files. The seeder`);
    console.log(`  draws fee variances at 15-50% of the fee, so a 60% band already`);
    console.log(`  captures all of them and widening it further changes nothing.`);
    console.log(`  Real fee variances have no such ceiling, and a band chosen on`);
    console.log(`  this plateau would be chosen on the generator's shape.`);
    console.log(`\n  60% is shipped because it is the narrowest band that clears the`);
    console.log(`  generator's stated range — not because the curve says so.\n`);
  }
}

module.exports = { stats, runOne };
