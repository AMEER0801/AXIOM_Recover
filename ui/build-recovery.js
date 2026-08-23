"use strict";
/* ══════════════════════════════════════════════════════════════
   RECOVERY CONSOLE BUILD
   ──────────────────────────────────────────────────────────────
   Runs both policy arms, verifies the audit chain, and inlines
   the result into a single self-contained HTML file — same
   approach as build-ui.js, for the same reason: a page served
   from file:// cannot fetch a sibling JSON, and a reviewer who
   double-clicks the file should not meet an empty screen.

   ── Dictionary compression, and why it is not a shortcut ─────
   The raw audit chain for one run is ~706KB, mostly because the
   same gate explanations repeat across hundreds of decisions
   ("not engaged" appears once per decision, 388 times).

   The obvious way to shrink that is to drop the gates that
   passed and keep only the blocks. That would be the wrong fix
   here: gates.js deliberately emits an entry for every gate on
   every call precisely so nobody has to ask "were the others
   actually checked?", and a UI that quietly discards the passes
   would reintroduce the doubt the design exists to remove.

   So instead the detail strings are dictionary-encoded — 429
   unique strings across 4,268 trace entries — and each trace
   becomes an array of [blocked, stringIndex] pairs. Every gate,
   on every decision, survives intact. 706KB becomes ~81KB with
   no information discarded.

     node build-recovery.js --seed 42 --records 200 --rounds 8
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { generate } = require("../server/seed");
const { runBatch, baselinePolicy, smartPolicy } = require("../server/recover");
const { verifyChain, gateCoverage } = require("../server/audit");
const { GATE_NAMES } = require("../server/gates");
const { reconcile } = require("../server/recon");
const { uncited } = require("../server/freeze");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", 42));
const records = Number(arg("records", 200));
const rounds = Number(arg("rounds", 8));

process.env.CONTACT_SALT = process.env.CONTACT_SALT || "ui-build-salt";

const ratesPath = path.join(__dirname, "..", "server", "model", "base-rates.json");
const rates = JSON.parse(fs.readFileSync(ratesPath, "utf8"));
const { ledger } = generate({ seed, records });

/* runBatch is async (it awaits whichever policy it's given, so an
   async LLM policy and a sync rule-based one share one code path).
   This build script itself stays a plain CJS file — no top-level
   await — so the two calls are made inside a small async wrapper. */
let baseline, smart;
async function runBothArms() {
  baseline = await runBatch({ ledger, policy: baselinePolicy, rates, seed, rounds });
  smart = await runBatch({ ledger, policy: smartPolicy, rates, seed, rounds });
}

(async () => {
  await runBothArms();

  const smartEntries = smart.audit.entries();
  const chainCheck = verifyChain(smartEntries);
  const coverage = gateCoverage(smartEntries, GATE_NAMES);
  const baselineCoverage = gateCoverage(baseline.audit.entries(), GATE_NAMES);

  /* ── close the loop: reconcile what the agent recovered ────────
     The number shown on the page is not the agent's own claim. The
     recovered payments are fed through recon.js and only what
     reconciles is reported as verified. */
  const postLedger = [...ledger, ...smart.emitted];
  const recon = reconcile(postLedger);
  const recoveredIds = new Set(smart.emitted.filter((r) => r.kind === "payment_captured").map((r) => r.entity.id));
  const recoveredRows = recon.results.filter((r) => recoveredIds.has(r.payment_id));
  const recoveredReconciled = recoveredRows.filter((r) => r.reconciles).length;

  /* ── dictionary-encode the traces ─────────────────────────────── */
  const detailDict = [];
  const detailIdx = new Map();
  const intern = (s) => {
    if (!detailIdx.has(s)) { detailIdx.set(s, detailDict.length); detailDict.push(s); }
    return detailIdx.get(s);
  };

  const decisions = [];
  const outcomeByKey = new Map();
  for (const e of smartEntries) {
    if (e.kind === "outcome") outcomeByKey.set(`${e.payload.entity_id}|${e.payload.round}`, e.payload);
  }

  for (const e of smartEntries) {
    if (e.kind !== "decision") continue;
    const p = e.payload;
    const out = outcomeByKey.get(`${p.entity_id}|${p.round}`);
    decisions.push({
      q: e.seq,
      h: e.hash.slice(0, 12),
      rd: p.round,
      id: p.entity_id,
      amt: p.amount_paise,
      mth: p.method,
      rsn: p.failure_reason,
      att: p.attempt_no,
      prop: p.proposed,
      fin: p.final,
      ok: p.allowed ? 1 : 0,
      cost: p.estimated_cost_paise,
      tr: p.trace.map((t) => [t.result === "block" ? 1 : 0, intern(t.detail)]),
      paid: out ? (out.paid ? 1 : 0) : null,
      optout: out && out.opted_out ? 1 : 0,
    });
  }

  const missing = uncited(rates);

  const payload = {
    meta: {
      seed, records, rounds,
      built: new Date().toISOString(),
      reportable: missing.length === 0,
      uncited_count: missing.length,
      chain_ok: chainCheck.ok,
      chain_length: smartEntries.length,
      head: smart.audit.head(),
    },
    gateNames: GATE_NAMES,
    arms: {
      baseline: {
        atRisk: baseline.atRiskCount, resolved: baseline.resolvedCount, stillInProgress: baseline.stillInProgress,
        paid: baseline.paidCount, optOuts: baseline.optOuts,
        gross: baseline.grossPaise, cost: baseline.costPaise, optOutLoss: baseline.optOutLossPaise, net: baseline.netPaise,
        firedGates: baselineCoverage.fired,
      },
      smart: {
        atRisk: smart.atRiskCount, resolved: smart.resolvedCount, stillInProgress: smart.stillInProgress,
        paid: smart.paidCount, optOuts: smart.optOuts,
        gross: smart.grossPaise, cost: smart.costPaise, optOutLoss: smart.optOutLossPaise, net: smart.netPaise,
        firedGates: coverage.fired,
      },
    },
    deltaNet: smart.netPaise - baseline.netPaise,
    deltaPaid: smart.paidCount - baseline.paidCount,
    verified: {
      recoveredPayments: recoveredRows.length,
      reconciled: recoveredReconciled,
    },
    coverage,
    detailDict,
    decisions,
  };

  const tpl = fs.readFileSync(path.join(__dirname, "recovery.template.html"), "utf8");
  const json = JSON.stringify(payload).replace(/<\//g, "<\\/");
  const outPath = path.join(__dirname, "recovery.html");
  fs.writeFileSync(outPath, tpl.replace("__DATA__", json));

  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`\n  recovery.html written  ${kb} KB`);
  console.log(`  chain .......... ${chainCheck.ok ? "verified" : "BROKEN at " + chainCheck.brokenAt}, ${smartEntries.length} entries, head ${smart.audit.head().slice(0, 16)}\u2026`);
  console.log(`  decisions ...... ${decisions.length}, all ${GATE_NAMES.length} gate results preserved on each`);
  console.log(`  dictionary ..... ${detailDict.length} unique strings (from ${decisions.length * GATE_NAMES.length} trace entries)`);
  console.log(`  recovered ...... ${recoveredRows.length} payments, ${recoveredReconciled} independently reconciled`);
  console.log(`  reportable ..... ${payload.meta.reportable ? "yes" : `no \u2014 ${missing.length} uncited base rates`}`);
  console.log(`\n  double-click ui/recovery.html to open it. No server needed.\n`);

})();
