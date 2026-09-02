"use strict";
/* ══════════════════════════════════════════════════════════════
   CORRECTED RECOVERY CONSOLE BUILD
   ──────────────────────────────────────────────────────────────
   Sibling to build-recovery.js, which stays exactly as it is.

   That file is not wrong. It is a faithful renderer of a run that
   was measured wrong: it reads runBatch() from recover.js, so it
   shows 25.0% / 35.0% and a ₹14,276.28 delta, it has no column for
   recovery by VALUE, and the escalation labour that recover.js
   never bills is missing from its cost row too. A dashboard cannot
   fix its input. Fixing the input is what recover2.js does; this
   file renders that.

   Same construction as its sibling and for the same reasons: run
   the engine here, inline the result into one self-contained HTML
   file, because a page opened from file:// cannot fetch a sibling
   JSON and a reviewer who double-clicks should not meet an empty
   screen. The page formats and arranges; it does not calculate.

   ── What the console has to make visible ─────────────────────
   One thing above all. On seed 42, 20% of the records hold 93% of
   the money, so a recovery rate counted per record and a recovery
   rate counted per rupee are different numbers that move in
   OPPOSITE directions: smartPolicy beats the baseline by 5.8
   points of records and loses to it by 4.0 points of value. Every
   other panel here is supporting evidence for that one fact, so it
   gets the top of the page and the only piece of motion.

     node build-recovery2.js --seed 42 --records 200 --rounds 8
     node build-recovery2.js --quick     (skip sweeps, ~10x faster)
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { generate } = require("../server/seed");
const { compareAll, runBatch2, warmBandit } = require("../server/recover2");
const { createBandit } = require("../server/bandit");
const { createEvPolicy } = require("../server/policy-ev");
const { runBatch, baselinePolicy, smartPolicy } = require("../server/recover");
const { verifyChain, gateCoverage } = require("../server/audit");
const { GATE_NAMES, DEFAULT_POLICY, estimateCost } = require("../server/gates");
const { uncited } = require("../server/freeze");
const { __v: v } = require("../server/model/response-model.frozen");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(`--${n}`);

const seed = Number(arg("seed", 42));
const records = Number(arg("records", 200));
const rounds = Number(arg("rounds", 8));
const warmup = Number(arg("warmup", 12));
const quick = has("quick");

process.env.CONTACT_SALT = process.env.CONTACT_SALT || "ui-build-salt";

const SERVER = path.join(__dirname, "..", "server");
const rates = JSON.parse(fs.readFileSync(path.join(SERVER, "model", "base-rates.json"), "utf8"));
const priors = JSON.parse(fs.readFileSync(path.join(SERVER, "model", "agent-priors.json"), "utf8"));
const CEILING = DEFAULT_POLICY.autoApprovalCeilingPaise;
const WARM_SEEDS = Array.from({ length: warmup }, (_, i) => 90001 + i);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

/* Deterministic paired bootstrap — same method as eval2.js, and
   Math.random() stays banned here too: a confidence interval that
   moves between builds is not a confidence interval. */
function bootCI(diffs, iters = 4000) {
  const { rngFor } = require("../server/lib/rng");
  const rand = rngFor("bootstrap-ui", diffs.length, iters);
  const out = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rand() * diffs.length)];
    out.push(s / diffs.length);
  }
  out.sort((a, b) => a - b);
  return { lo: out[Math.floor(0.025 * iters)], hi: out[Math.floor(0.975 * iters)] };
}

function armSummary(r) {
  const messaging = r.costPaise - r.escalationCostPaise;
  return {
    atRisk: r.atRiskCount, atRiskValue: r.atRiskValuePaise,
    paid: r.paidCount, gross: r.grossPaise,
    countPct: Number(((r.paidCount / r.atRiskCount) * 100).toFixed(1)),
    valuePct: Number(((r.grossPaise / r.atRiskValuePaise) * 100).toFixed(1)),
    escalations: r.escalations, escalationCost: r.escalationCostPaise,
    messagingCost: messaging, optOuts: r.optOuts, optOutLoss: r.optOutLossPaise,
    cost: r.costPaise, net: r.netPaise,
  };
}

(async () => {
  const t0 = Date.now();
  const { ledger } = generate({ seed, records });

  /* ── 1. the ORIGINAL run, for the before/after ledger ────────
     Rendered next to the corrected one rather than replaced, so the
     difference between the two is inspectable on the page instead
     of living only in a git diff. */
  const origBase = await runBatch({ ledger, policy: baselinePolicy, rates, seed, rounds });
  const origSmart = await runBatch({ ledger, policy: smartPolicy, rates, seed, rounds });
  const escCost = estimateCost("ESCALATE_HUMAN", rates);
  const countEsc = (r) => { let n = 0; for (const [, log] of r.perRecordLog) for (const e of log) if (e.final === "ESCALATE_HUMAN") n++; return n; };
  const origBaseEsc = countEsc(origBase), origSmartEsc = countEsc(origSmart);

  /* ── 2. the CORRECTED run ────────────────────────────────────── */
  let bandit = createBandit({ priors, seed });
  if (warmup > 0) bandit = await warmBandit({ bandit, rates, priors, records, rounds, evalSeed: seed, warmupSeeds: WARM_SEEDS });
  const { baseline, smart, ev } = await compareAll({ ledger, rates, priors, seed, rounds, bandit });

  const evEntries = ev.audit.entries();
  const chainCheck = verifyChain(evEntries);
  const coverage = gateCoverage(evEntries, GATE_NAMES);

  /* ── 3. value concentration ──────────────────────────────────
     The Lorenz-style fact the whole review turns on, computed here
     rather than in the browser. */
  const AT_RISK_KINDS = new Set(["payment_failed", "checkout_abandoned", "subscription_halted", "invoice_overdue"]);
  const atRisk = ledger.filter((r) => AT_RISK_KINDS.has(r.kind));
  const sorted = atRisk.map((r) => r.amount_paise).sort((a, b) => b - a);
  const totalValue = sorted.reduce((a, b) => a + b, 0);
  const above = atRisk.filter((r) => r.amount_paise >= CEILING);
  const aboveValue = above.reduce((a, r) => a + r.amount_paise, 0);

  let cum = 0;
  const lorenz = sorted.map((amt, i) => { cum += amt; return { i: i + 1, cumPct: Number(((cum / totalValue) * 100).toFixed(2)) }; });

  /* ── 4. multi-seed CIs and the churn curve ───────────────────── */
  let multiseed = null, churn = null;
  if (!quick) {
    const nSeeds = 20, wu = 8, wSeeds = Array.from({ length: wu }, (_, i) => 90001 + i);
    const evalSeeds = Array.from({ length: nSeeds }, (_, i) => 42 + i * 7);
    const acc = { baseline: { c: [], v: [], n: [] }, smart: { c: [], v: [], n: [] }, ev: { c: [], v: [], n: [] } };
    for (const s of evalSeeds) {
      const { ledger: L } = generate({ seed: s, records });
      let b = createBandit({ priors, seed: s });
      b = await warmBandit({ bandit: b, rates, priors, records, rounds, evalSeed: s, warmupSeeds: wSeeds });
      const r = await compareAll({ ledger: L, rates, priors, seed: s, rounds, bandit: b });
      for (const k of ["baseline", "smart", "ev"]) {
        acc[k].c.push(100 * r[k].paidCount / r[k].atRiskCount);
        acc[k].v.push(100 * r[k].grossPaise / r[k].atRiskValuePaise);
        acc[k].n.push(r[k].netPaise);
      }
    }
    const dv = (k) => acc[k].v.map((x, i) => x - acc.baseline.v[i]);
    const dn = (k) => acc[k].n.map((x, i) => x - acc.baseline.n[i]);
    multiseed = {
      seeds: nSeeds, warmup: wu,
      arms: Object.fromEntries(["baseline", "smart", "ev"].map((k) => [k, {
        countMean: Number(mean(acc[k].c).toFixed(1)), countSd: Number(sd(acc[k].c).toFixed(1)),
        valueMean: Number(mean(acc[k].v).toFixed(1)), valueSd: Number(sd(acc[k].v).toFixed(1)),
        netMean: Math.round(mean(acc[k].n)),
      }])),
      ciValue: { smart: bootCI(dv("smart")), ev: bootCI(dv("ev")) },
      ciNet: { smart: bootCI(dn("smart")), ev: bootCI(dn("ev")) },
      wins: { smart: dn("smart").filter((x) => x > 0).length, ev: dn("ev").filter((x) => x > 0).length },
    };

    const wS = [90001, 90002, 90003, 90004, 90005, 90006];
    churn = [];
    for (const loss of [48000, 150000, 300000, 600000, 1200000, 2500000]) {
      const vals = [], oos = [], voices = [];
      for (const s of [42, 49, 56]) {
        const { ledger: L } = generate({ seed: s, records });
        let b = createBandit({ priors, seed: s });
        b = await warmBandit({ bandit: b, rates, priors, records, rounds, evalSeed: s, warmupSeeds: wS });
        const qr = { current: null };
        const p = createEvPolicy({ priors, bandit: b, approvals: { decision: (id) => qr.current?.decision(id) ?? null }, ceilingPaise: CEILING, optOutLossPaise: loss });
        const wrapped = (rec, h, rt, c) => { qr.current = c?.approvals || qr.current; return p(rec, h, rt, c); };
        const out = await runBatch2({ ledger: L, policy: wrapped, rates, priors, seed: s, rounds, useApprovals: true, bandit: b });
        let voice = 0;
        for (const [, log] of out.perRecordLog) for (const e of log) if (e.final === "VOICE_NUDGE_REGIONAL") voice++;
        vals.push(100 * out.grossPaise / out.atRiskValuePaise); oos.push(out.optOuts); voices.push(voice);
      }
      churn.push({ loss, valuePct: Number(mean(vals).toFixed(1)), optOuts: Number(mean(oos).toFixed(1)), voice: Math.round(mean(voices)) });
    }
  }

  /* ── 5. the ev arm's decisions, dictionary-encoded ────────────
     Same technique and same reasoning as build-recovery.js: every
     gate result on every decision survives, including the passes.
     Dropping the passes would be the easy win and the wrong one —
     gates.js emits all eleven precisely so nobody has to ask
     whether the others were checked. */
  const dict = [], idx = new Map();
  const intern = (s) => { if (!idx.has(s)) { idx.set(s, dict.length); dict.push(s); } return idx.get(s); };
  const outcomeBy = new Map();
  for (const e of evEntries) if (e.kind === "outcome") outcomeBy.set(`${e.payload.entity_id}|${e.payload.round}`, e.payload);
  const decisions = [];
  for (const e of evEntries) {
    if (e.kind !== "decision") continue;
    const p = e.payload, o = outcomeBy.get(`${p.entity_id}|${p.round}`);
    decisions.push({
      q: e.seq, h: e.hash.slice(0, 12), rd: p.round, id: p.entity_id,
      amt: p.amount_paise, mth: p.method, rsn: p.failure_reason, att: p.attempt_no,
      prop: p.proposed, fin: p.final, ok: p.allowed ? 1 : 0, cost: p.estimated_cost_paise,
      appr: p.dual_control_approved ? 1 : 0,
      tr: p.trace.map((t) => [t.result === "block" ? 1 : 0, intern(t.detail)]),
      paid: o ? (o.paid ? 1 : 0) : null, optout: o && o.opted_out ? 1 : 0,
    });
  }

  const missing = uncited(rates);
  const payload = {
    meta: {
      seed, records, rounds, warmup,
      warmSeeds: [WARM_SEEDS[0], WARM_SEEDS[WARM_SEEDS.length - 1]],
      /* Wall-clock is the ONE non-reproducible byte in this artifact.
         Everything else — every figure, the chain head, the bootstrap
         intervals — is seeded and reproduces exactly. SOURCE_DATE_EPOCH
         pins it so two builds can be byte-compared, which is the point
         of a project that hashes its own model. */
      built: (process.env.SOURCE_DATE_EPOCH
        ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000)
        : new Date()).toISOString(),
      reportable: missing.length === 0, uncitedCount: missing.length,
      chainOk: chainCheck.ok, chainLength: evEntries.length, head: ev.audit.head(),
      ceiling: CEILING, quick,
    },
    gateNames: GATE_NAMES,
    original: {
      baseline: { paid: origBase.paidCount, atRisk: origBase.atRiskCount, gross: origBase.grossPaise, net: origBase.netPaise, escalations: origBaseEsc, unbilled: origBaseEsc * escCost },
      smart: { paid: origSmart.paidCount, atRisk: origSmart.atRiskCount, gross: origSmart.grossPaise, net: origSmart.netPaise, escalations: origSmartEsc, unbilled: origSmartEsc * escCost },
      deltaNet: origSmart.netPaise - origBase.netPaise,
      unbilledSkew: (origSmartEsc - origBaseEsc) * escCost,
      totalValue,
    },
    corrected: { baseline: armSummary(baseline), smart: armSummary(smart), ev: armSummary(ev) },
    concentration: {
      total: atRisk.length, totalValue, ceiling: CEILING,
      aboveCount: above.length, aboveValue,
      aboveCountPct: Number(((above.length / atRisk.length) * 100).toFixed(1)),
      aboveValuePct: Number(((aboveValue / totalValue) * 100).toFixed(1)),
      lorenz,
    },
    approvals: ev.approvalStats,
    bandit: bandit.revisions().slice(0, 10),
    multiseed, churn,
    coverage, detailDict: dict, decisions,
  };

  const tpl = fs.readFileSync(path.join(__dirname, "recovery2.template.html"), "utf8");
  const json = JSON.stringify(payload).replace(/<\//g, "<\\/");
  const outPath = path.join(__dirname, "recovery2.html");
  fs.writeFileSync(outPath, tpl.replace("__DATA__", json));

  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`\n  recovery2.html written  ${kb} KB  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`  chain .......... ${chainCheck.ok ? "verified" : "BROKEN at " + chainCheck.brokenAt}, ${evEntries.length} entries, head ${ev.audit.head().slice(0, 16)}\u2026`);
  console.log(`  decisions ...... ${decisions.length}, all ${GATE_NAMES.length} gate results kept on each`);
  console.log(`  dictionary ..... ${dict.length} unique strings`);
  console.log(`  concentration .. ${above.length}/${atRisk.length} records hold ${payload.concentration.aboveValuePct}% of the value`);
  console.log(`  sweeps ......... ${quick ? "skipped (--quick)" : `${multiseed.seeds}-seed CIs + ${churn.length}-point churn curve`}`);
  console.log(`  reportable ..... ${payload.meta.reportable ? "yes" : `no \u2014 ${missing.length} uncited base rates`}`);
  console.log(`\n  double-click ui/recovery2.html to open it. No server needed.\n`);
})().catch((e) => { console.error(e); process.exit(1); });
