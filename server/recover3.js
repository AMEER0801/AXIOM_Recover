"use strict";
/* ══════════════════════════════════════════════════════════════
   RECOVER3 — does the DP policy actually close the gap?
   ──────────────────────────────────────────────────────────────
   Four arms, identical population, identical accounting:
     baseline  — blind retry
     smart     — the original rule ladder
     ev        — greedy one-step expected value (policy-ev.js)
     dp        — PSRL-style lookahead (policy-dp.js)

   Reported against the oracle ceiling from oracle-ceiling.js so the
   number that matters is not "did dp beat ev" but "how much of the
   PROVABLY available gap did it close."
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { generate } = require("./seed");
const { createBandit } = require("./bandit");
const { createEvPolicy } = require("./policy-ev");
const { createDpPolicy } = require("./policy-dp");
const { runBatch2, warmBandit } = require("./recover2");
const { baselinePolicy, smartPolicy } = require("./recover");
const { DEFAULT_POLICY } = require("./gates");
const { __v: v } = require("./model/response-model.frozen");
const { runCeiling } = require("./oracle-ceiling");

const CEILING = DEFAULT_POLICY.autoApprovalCeilingPaise;

function wrapWithQueue(makePolicy) {
  const queueRef = { current: null };
  const p = makePolicy(queueRef);
  const wrapped = (rec, hist, r, ctx) => { queueRef.current = ctx?.approvals || queueRef.current; return p(rec, hist, r, ctx); };
  return wrapped;
}

async function runFourArms({ ledger, rates, priors, seed, rounds, warmupSeeds }) {
  const banditForEv = createBandit({ priors, seed });
  const banditForDp = createBandit({ priors, seed });
  if (warmupSeeds?.length) {
    await warmBandit({ bandit: banditForEv, rates, priors, records: ledger.length, rounds, evalSeed: seed, warmupSeeds });
    await warmBandit({ bandit: banditForDp, rates, priors, records: ledger.length, rounds, evalSeed: seed, warmupSeeds });
  }

  const evPolicy = wrapWithQueue((qref) => createEvPolicy({
    priors, bandit: banditForEv, approvals: { decision: (id) => qref.current?.decision(id) ?? null },
    ceilingPaise: CEILING, optOutLossPaise: v(rates, "opt_out_loss_paise"),
  }));
  const dpPolicy = wrapWithQueue((qref) => createDpPolicy({
    priors, bandit: banditForDp, approvals: { decision: (id) => qref.current?.decision(id) ?? null },
    totalRounds: rounds, ceilingPaise: CEILING, optOutLossPaise: v(rates, "opt_out_loss_paise"),
  }));

  const common = { ledger, rates, priors, seed, rounds, useApprovals: true };
  const baseline = await runBatch2({ ...common, policy: baselinePolicy });
  const smart = await runBatch2({ ...common, policy: smartPolicy });
  const ev = await runBatch2({ ...common, policy: evPolicy, bandit: banditForEv });
  const dp = await runBatch2({ ...common, policy: dpPolicy, bandit: banditForDp });
  return { baseline, smart, ev, dp };
}

if (require.main === module) {
  (async () => {
    const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
    const seed = Number(arg("seed", 42));
    const records = Number(arg("records", 200));
    const rounds = Number(arg("rounds", 8));
    const warmup = Number(arg("warmup", 12));
    const warmupSeeds = Array.from({ length: warmup }, (_, i) => 90001 + i);

    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "base-rates.json"), "utf8"));
    const priors = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "agent-priors.json"), "utf8"));
    const { ledger } = generate({ seed, records });

    const { baseline, smart, ev, dp } = await runFourArms({ ledger, rates, priors, seed, rounds, warmupSeeds });
    const ceiling = runCeiling(seed, records, { rounds, attemptCap: 4, respectQuietHours: true, label: "fully gated" });

    const R = (p) => "\u20B9" + Math.round(p / 100).toLocaleString("en-IN");
    const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "\u2014");
    const row = (label, ...vals) => console.log(`  ${label.padEnd(22)}${vals.map((x) => String(x).padStart(13)).join("")}`);

    console.log(`\n\u2500\u2500 FOUR ARMS vs THE ORACLE CEILING \u00b7 seed ${seed} \u00b7 ${baseline.atRiskCount} at-risk \u2500\u2500`);
    console.log(`\n  ${"".padEnd(22)}${["baseline", "smart", "ev(greedy)", "dp(PSRL)"].map((s) => s.padStart(13)).join("")}`);
    row("paid", baseline.paidCount, smart.paidCount, ev.paidCount, dp.paidCount);
    row("value-recovery %", pct(baseline.grossPaise, baseline.atRiskValuePaise), pct(smart.grossPaise, smart.atRiskValuePaise), pct(ev.grossPaise, ev.atRiskValuePaise), pct(dp.grossPaise, dp.atRiskValuePaise));
    row("net recovered", R(baseline.netPaise), R(smart.netPaise), R(ev.netPaise), R(dp.netPaise));

    const evPct = 100 * ev.grossPaise / ev.atRiskValuePaise;
    const dpPct = 100 * dp.grossPaise / dp.atRiskValuePaise;
    const ceilPct = ceiling.ceilingValueRate * 100;

    console.log(`\n\u2500\u2500 GAP TO THE MATHEMATICAL CEILING (${ceilPct.toFixed(1)}%, fully gated) \u2500\u2500`);
    console.log(`  greedy EV policy  captures ${(100 * evPct / ceilPct).toFixed(0)}% of the achievable ceiling  (${evPct.toFixed(1)} of ${ceilPct.toFixed(1)} points)`);
    console.log(`  DP (PSRL) policy  captures ${(100 * dpPct / ceilPct).toFixed(0)}% of the achievable ceiling  (${dpPct.toFixed(1)} of ${ceilPct.toFixed(1)} points)`);
    console.log(`  gap closed by switching from greedy to lookahead: ${(dpPct - evPct).toFixed(1)} points\n`);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runFourArms };
