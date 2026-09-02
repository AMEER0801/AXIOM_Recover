"use strict";
/* ══════════════════════════════════════════════════════════════
   CONSOLE-EVAL — the multi-seed sweep behind /api/eval
   ──────────────────────────────────────────────────────────────
   The console's Evidence screen must never present a single-seed
   number as the story. This script runs the recommended FINAL
   configuration (recover-final.js: attempt cap 6, ₹50,000 dual-
   control ceiling, 4-contact sub-cap) against its baseline across
   N independent populations, paired seed-by-seed, and writes the
   per-seed arrays plus paired bootstrap intervals to
   server/data/console-eval.json, where console-api.js serves it.

   Everything here is deterministic: the seeds are fixed, the
   bootstrap uses the project's seeded rngFor, and no Math.random()
   exists anywhere in the path. The only wall-clock value written
   is generatedAt, which labels WHEN the artifact was produced,
   never WHAT it contains. Regenerate with:

       npm run eval:console

   and the numbers will come back identical (the generatedAt
   string is the only byte that moves).
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { generate } = require("./seed");
const { runBatch2, warmBandit } = require("./recover2");
const { baselinePolicy, smartPolicy } = require("./recover");
const { runFinalPolicy, FINAL_CONFIG } = require("./recover-final");
const { createBandit } = require("./bandit");
const { runCeiling } = require("./oracle-ceiling");
const { rngFor } = require("./lib/rng");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SEEDS = Number(arg("seeds", 20));
const RECORDS = Number(arg("records", 200));
const ROUNDS = Number(arg("rounds", 20));
const WARMUP = Number(arg("warmup", 8));

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const cv = (a) => { const m = mean(a); return m === 0 ? 0 : (sd(a) / Math.abs(m)) * 100; };

/* Paired bootstrap, deterministic — a CI that moves between runs
   is not a CI, and Math.random() is banned project-wide. */
function bootCI(diffs, iters = 4000) {
  const rand = rngFor("console-eval-bootstrap", diffs.length, iters);
  const means = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rand() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * iters)], hi: means[Math.floor(0.975 * iters)] };
}

function deltaStat(diffs) {
  return {
    mean: Number(mean(diffs).toFixed(2)),
    sd: Number(sd(diffs).toFixed(2)),
    cv: Number(cv(diffs).toFixed(1)),
    min: Number(Math.min(...diffs).toFixed(2)),
    max: Number(Math.max(...diffs).toFixed(2)),
    wins: diffs.filter((x) => x > 0).length,
    batches: diffs.length,
  };
}

(async () => {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "base-rates.json"), "utf8"));
  const priors = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "agent-priors.json"), "utf8"));
  const warmupSeeds = Array.from({ length: WARMUP }, (_, i) => 90001 + i);
  const evalSeeds = Array.from({ length: SEEDS }, (_, i) => 42 + i * 7);

  const acc = {
    baseline: { count: [], value: [], net: [], optOuts: [] },
    smart: { count: [], value: [], net: [], optOuts: [] },
    final: { count: [], value: [], net: [], optOuts: [] },
  };
  const ceilings = [];

  for (let i = 0; i < evalSeeds.length; i++) {
    const seed = evalSeeds[i];
    const { ledger } = generate({ seed, records: RECORDS });

    const baseline = await runBatch2({
      ledger, rates, priors, seed, rounds: ROUNDS, policy: baselinePolicy, useApprovals: true,
      policyConfig: { maxAttemptsPerEntity: FINAL_CONFIG.maxAttemptsPerEntity, autoApprovalCeilingPaise: FINAL_CONFIG.autoApprovalCeilingPaise },
    });
    const smart = await runBatch2({
      ledger, rates, priors, seed, rounds: ROUNDS, policy: smartPolicy, useApprovals: true,
      policyConfig: { maxAttemptsPerEntity: FINAL_CONFIG.maxAttemptsPerEntity, autoApprovalCeilingPaise: FINAL_CONFIG.autoApprovalCeilingPaise },
    });
    const final = await runFinalPolicy({ ledger, rates, priors, seed, rounds: ROUNDS, warmupSeeds });

    for (const [k, r] of [["baseline", baseline], ["smart", smart], ["final", final]]) {
      acc[k].count.push(r.paidCount);
      acc[k].value.push(Number((100 * r.grossPaise / r.atRiskValuePaise).toFixed(2)));
      acc[k].net.push(r.netPaise);
      acc[k].optOuts.push(r.optOuts);
    }
    ceilings.push(Number((runCeiling(seed, RECORDS, {
      rounds: ROUNDS, attemptCap: FINAL_CONFIG.maxAttemptsPerEntity, respectQuietHours: true,
      ceilingPaise: FINAL_CONFIG.autoApprovalCeilingPaise, approvalRate: 0.85, approvalLatencyRounds: 1,
    }).ceilingValueRate * 100).toFixed(2)));

    process.stdout.write(`  seed ${seed} done (${i + 1}/${evalSeeds.length})\r`);
  }

  /* Paired deltas: FINAL minus baseline, seed by seed. */
  const dCount = acc.final.count.map((x, i) => x - acc.baseline.count[i]);
  const dValue = acc.final.value.map((x, i) => x - acc.baseline.value[i]);
  const dNet = acc.final.net.map((x, i) => x - acc.baseline.net[i]);

  const out = {
    schema: "console-eval/1",
    arms: ["baseline", "smart", "final"],
    config: FINAL_CONFIG,
    provenance: {
      seeds: evalSeeds,
      warmupSeeds,
      records: RECORDS,
      rounds: ROUNDS,
      warmup: WARMUP,
      pairing: "each seed runs every arm on the identical population",
      bootstrap: "paired, deterministic (rngFor), 4000 iterations",
      generatedAt: new Date().toISOString(),
      regenerate: "npm run eval:console",
    },
    perArm: {
      baseline: { valuePct: acc.baseline.value, countPct: acc.baseline.count, netPaise: acc.baseline.net, optOuts: acc.baseline.optOuts },
      smart: { valuePct: acc.smart.value, countPct: acc.smart.count, netPaise: acc.smart.net, optOuts: acc.smart.optOuts },
      final: { valuePct: acc.final.value, countPct: acc.final.count, netPaise: acc.final.net, optOuts: acc.final.optOuts },
    },
    countDelta: deltaStat(dCount),
    valueDelta: deltaStat(dValue),
    rupeeDelta: deltaStat(dNet),
    valueDeltaCi: bootCI(dValue),
    netDeltaCi: bootCI(dNet),
    oracleCeilingPct: { mean: Number(mean(ceilings).toFixed(2)), sd: Number(sd(ceilings).toFixed(2)), perSeed: ceilings },
    headline: {
      baselineValuePctMean: Number(mean(acc.baseline.value).toFixed(1)),
      finalValuePctMean: Number(mean(acc.final.value).toFixed(1)),
      finalCaptureOfCeilingPct: Number((100 * mean(acc.final.value) / mean(ceilings)).toFixed(1)),
      finalWins: dValue.filter((x) => x > 0).length,
      seeds: SEEDS,
    },
  };

  const outPath = path.join(__dirname, "data", "console-eval.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log(`\n── console-eval · ${SEEDS} seeds · FINAL config ──`);
  console.log(`  value recovery: baseline ${out.headline.baselineValuePctMean}% → final ${out.headline.finalValuePctMean}%  (paired Δ ${out.valueDelta.mean}pp, 95% CI [${out.valueDeltaCi.lo.toFixed(1)}, ${out.valueDeltaCi.hi.toFixed(1)}])`);
  console.log(`  oracle ceiling ${out.oracleCeilingPct.mean}% · final captures ${out.headline.finalCaptureOfCeilingPct}% of it`);
  console.log(`  wrote ${path.relative(process.cwd(), outPath)}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
