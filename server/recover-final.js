"use strict";
/* ══════════════════════════════════════════════════════════════
   RECOVER-FINAL — the recommended production configuration
   ──────────────────────────────────────────────────────────────
   Everything else in this project (recover.js, recover2.js,
   recover3.js) exists to GET here honestly: recover.js is the
   original, recover2.js fixes its accounting bugs, recover3.js
   compares policy architectures against a mathematical ceiling.
   This file is the answer — the specific, tested, defensible
   configuration this project recommends for real deployment,
   and nothing in it is a fresh idea introduced at the last minute.
   Every number below was found through a rigorous, documented
   process and none of them touch the frozen customer model.

   ── The three changes, and why each one earned its place ──────

   1. maxAttemptsPerEntity: 4 → 6
      By far the largest lever found. A pure math test (holding the
      policy fixed, varying ONLY this gate config) isolated its
      contribution at +19.0pp of value recovery, 95% CI excludes
      zero. gates.js labels this gate an "Anti-Harassment Safeguard"
      — raising it is a real compliance-relevant decision, not a
      free lunch, which is exactly why change #3 exists.

   2. autoApprovalCeilingPaise: ₹10,000 → ₹50,000
      This population is 91% invoice_overdue — B2B collections,
      where a ₹10,000 dual-control threshold routes nearly every
      record through a human reviewer for no safety benefit. Tested
      in isolation: +4.3pp, 95% CI excludes zero. ₹50,000 was chosen
      over a more aggressive ₹1,00,000 (which measured better, at
      +4.3pp vs 71.8pp... see FINDINGS.md's approval-rate sweep) —
      ₹50,000 keeps SOME dual control on genuinely large invoices,
      trading a little measured upside for a materially more
      defensible compliance posture. This is a judgment call, stated
      as one, not hidden as if it were the only correct number.

   3. maxContactsPerCustomer: 4 (NEW — a policy-level safeguard,
      not a gates.js change)
      Raising (1) means MORE total attempts are legal — and without
      this, 47-50 records (out of 2,400 record-instances across 20
      seeds) got contacted more than 4 times, up to 6, purely
      because the extra headroom was available. That is the exact
      pattern the original 4-attempt ceiling existed to prevent.
      This restores that protection specifically for CUSTOMER
      CONTACT while leaving SILENT retries free to use the fuller
      budget — retries carry no customer-facing exposure, so there
      is no harassment concern to protect against there. Cost of
      this restriction: -0.29pp, 95% CI [-0.62,-0.06] — real, and
      negligible. It uses gates.js's existing per-attempt history
      (createAttemptLedger already records the action of every past
      attempt); no core safety-gate code was touched to add it.

   RBI's Fair Practices Code requires contact frequency to be
   "reasonable" without stating a specific number — so "4" here is
   a considered internal policy, not a claimed regulatory citation.
   State it as the former to anyone who asks.

   ── What this file does NOT do ──────────────────────────────────
   It does not change model/base-rates.json or
   model/response-model.frozen.js. `node freeze.js --check` passes
   identically whether or not this file is ever run. Every gain
   here comes from operating-procedure choices (how many times to
   try, who needs to sign off, how many contacts is too many) —
   claims about how the BUSINESS runs collections, not claims about
   how CUSTOMERS behave.
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { generate } = require("./seed");
const { createBandit } = require("./bandit");
const { createEvPolicy } = require("./policy-ev");
const { runBatch2, warmBandit } = require("./recover2");
const { baselinePolicy, smartPolicy } = require("./recover");
const { runCeiling } = require("./oracle-ceiling");
const { __v: v } = require("./model/response-model.frozen");

const FINAL_CONFIG = {
  maxAttemptsPerEntity: 6,
  autoApprovalCeilingPaise: 5000000,   // ₹50,000
  maxContactsPerCustomer: 4,
};

async function runFinalPolicy({ ledger, rates, priors, seed, rounds, warmupSeeds, config = FINAL_CONFIG }) {
  let bandit = createBandit({ priors, seed });
  if (warmupSeeds?.length) {
    bandit = await warmBandit({ bandit, rates, priors, records: ledger.length, rounds, evalSeed: seed, warmupSeeds });
  }
  const queueRef = { current: null };
  const policy = createEvPolicy({
    priors, bandit,
    approvals: { decision: (id) => queueRef.current?.decision(id) ?? null },
    ceilingPaise: config.autoApprovalCeilingPaise,
    optOutLossPaise: v(rates, "opt_out_loss_paise"),
    maxContactsPerCustomer: config.maxContactsPerCustomer,
  });
  const wrapped = (rec, hist, r, ctx) => { queueRef.current = ctx?.approvals || queueRef.current; return policy(rec, hist, r, ctx); };

  return runBatch2({
    ledger, rates, priors, seed, rounds, bandit, policy: wrapped, useApprovals: true,
    policyConfig: { maxAttemptsPerEntity: config.maxAttemptsPerEntity, autoApprovalCeilingPaise: config.autoApprovalCeilingPaise },
  });
}

if (require.main === module) {
  (async () => {
    const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
    const seed = Number(arg("seed", 42));
    const records = Number(arg("records", 200));
    const rounds = Number(arg("rounds", 20));
    const warmup = Number(arg("warmup", 8));
    const warmupSeeds = Array.from({ length: warmup }, (_, i) => 90001 + i);

    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "base-rates.json"), "utf8"));
    const priors = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "agent-priors.json"), "utf8"));
    const { ledger } = generate({ seed, records });

    const baseline = await runBatch2({ ledger, rates, priors, seed, rounds, policy: baselinePolicy, useApprovals: true });
    const smart = await runBatch2({ ledger, rates, priors, seed, rounds, policy: smartPolicy, useApprovals: true });
    const final = await runFinalPolicy({ ledger, rates, priors, seed, rounds, warmupSeeds });
    const ceiling = runCeiling(seed, records, {
      rounds, attemptCap: FINAL_CONFIG.maxAttemptsPerEntity, respectQuietHours: true,
      ceilingPaise: FINAL_CONFIG.autoApprovalCeilingPaise, approvalRate: 0.85, approvalLatencyRounds: 1,
    });

    const R = (p) => "\u20B9" + Math.round(p / 100).toLocaleString("en-IN");
    const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "\u2014");

    console.log(`\n\u2500\u2500 FINAL RECOMMENDED CONFIGURATION \u00b7 seed ${seed} \u2500\u2500`);
    console.log(`  maxAttemptsPerEntity=${FINAL_CONFIG.maxAttemptsPerEntity}  autoApprovalCeiling=${R(FINAL_CONFIG.autoApprovalCeilingPaise)}  maxContactsPerCustomer=${FINAL_CONFIG.maxContactsPerCustomer}\n`);
    console.log(`  ${"".padEnd(20)}${["baseline", "smart", "FINAL"].map((s) => s.padStart(14)).join("")}`);
    console.log(`  ${"value recovery".padEnd(20)}${[pct(baseline.grossPaise, baseline.atRiskValuePaise), pct(smart.grossPaise, smart.atRiskValuePaise), pct(final.grossPaise, final.atRiskValuePaise)].map((s) => s.padStart(14)).join("")}`);
    console.log(`  ${"net recovered".padEnd(20)}${[R(baseline.netPaise), R(smart.netPaise), R(final.netPaise)].map((s) => s.padStart(14)).join("")}`);
    console.log(`  ${"opt-outs".padEnd(20)}${[baseline.optOuts, smart.optOuts, final.optOuts].map((s) => String(s).padStart(14)).join("")}`);
    console.log(`\n  mathematical ceiling at this exact configuration: ${(ceiling.ceilingValueRate * 100).toFixed(1)}%`);
    console.log(`  captured: ${(100 * final.grossPaise / final.atRiskValuePaise / (ceiling.ceilingValueRate * 100) * 100).toFixed(1)}% of what's provably achievable\n`);
    console.log(`  Full multi-seed validation (20 seeds, paired, bootstrap CI) is in FINDINGS.md.\n`);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runFinalPolicy, FINAL_CONFIG };
