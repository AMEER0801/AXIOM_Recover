"use strict";
/* ══════════════════════════════════════════════════════════════
   UI BUILD
   ──────────────────────────────────────────────────────────────
   Runs the seeder and the reconciler, then inlines the result
   into a single self-contained HTML file.

   ── Why inline rather than fetch ─────────────────────────────
   The console has to open by double-clicking it. A page served
   from file:// cannot fetch a sibling JSON — the browser blocks
   it as a cross-origin request — so a reviewer would be met with
   an empty screen and a console error. Inlining removes the
   failure mode entirely and keeps the single-file, zero-server
   property the rest of this project has.

   ── The numbers on screen are not computed in the browser ────
   Every figure the console displays comes from recon.js and
   sweep.js, the same code the test suite exercises. The page
   formats and arranges; it does not calculate. That separation
   is deliberate — a dashboard that does its own arithmetic is a
   second implementation nobody tests.

     node build-ui.js --seed 42 --records 200 --sweep 25
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { generate } = require("../server/seed");
const { reconcile, score, MINUTES_PER_INVESTIGATION } = require("../server/recon");
const { stats, runOne } = require("../server/sweep");
const { uncited } = require("../server/freeze");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const seed = Number(arg("seed", 42));
const records = Number(arg("records", 200));
const nSweep = Number(arg("sweep", 25));

process.env.CONTACT_SALT = process.env.CONTACT_SALT || "ui-build-salt";

/* ── the batch on screen ──────────────────────────────────────── */
const { ledger, truth } = generate({ seed, records });
const out = reconcile(ledger);
const sc = score(out, truth);

/* ── the sweep behind the headline numbers ────────────────────
   The scorecard reports the sweep, not this single batch. One
   batch is an anecdote; the console should not present it as a
   measurement just because it happens to be the one being shown. */
const seeds = Array.from({ length: nSweep }, (_, i) => 1000 + i * 7);
const runs = seeds.map((s) => runOne(s, records, out.stats.fee_variance_band));
const prec = stats(runs.map((r) => r.precision));
const rec = stats(runs.map((r) => r.recall));
const expl = stats(runs.map((r) => r.explanation_accuracy));
const fpMin = stats(runs.map((r) => r.fp_minutes));

/* ── reportable? ──────────────────────────────────────────────
   The same gate the CLI enforces, surfaced in the interface. A
   reviewer should be able to see from the page itself whether
   the underlying assumptions are cited yet. */
const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "server", "model", "base-rates.json"), "utf8"));
const missing = uncited(rates);

const payload = {
  meta: {
    seed, records,
    built: new Date().toISOString(),
    reportable: missing.length === 0,
    uncited_count: missing.length,
    sweep_batches: nSweep,
    minutes_per_investigation: MINUTES_PER_INVESTIGATION,
  },
  stats: out.stats,
  score: {
    batch: { precision: sc.precision, recall: sc.recall, f1: sc.f1, explanation_accuracy: sc.explanation_accuracy, confusion: sc.confusion },
    sweep: {
      precision: prec.mean, precision_sd: prec.sd,
      recall: rec.mean, recall_sd: rec.sd,
      explanation_accuracy: expl.mean, explanation_sd: expl.sd,
      fp_minutes: fpMin.mean,
      batches: nSweep,
    },
  },
  /* Trimmed to what the page draws. Shipping the whole ledger would
     put customer records into a file a reviewer might forward. */
  results: out.results.map((r) => ({
    payment_id: r.payment_id,
    gross_paise: r.gross_paise,
    fee_paise: r.fee_paise,
    tax_paise: r.tax_paise,
    refunded_paise: r.refunded_paise,
    expected_paise: r.expected_paise,
    settled_paise: r.settled_paise,
    delta_paise: r.delta_paise,
    tier: r.tier,
    severity: r.severity,
    reconciles: r.reconciles,
    explanation: r.explanation,
    evidence: r.evidence,
    action: r.action,
  })),
  orphans: out.orphanCredits.map((o) => ({ id: o.entity.id, amount_paise: o.amount_paise, ts: o.ts })),
};

const tpl = fs.readFileSync(path.join(__dirname, "ledger.template.html"), "utf8");
/* JSON.stringify can emit "</script>" inside a string and close the
   tag early. Escaping the slash is the standard fix and costs
   nothing. */
const json = JSON.stringify(payload).replace(/<\//g, "<\\/");
const html = tpl.replace("__DATA__", json);

const outPath = path.join(__dirname, "ledger.html");
fs.writeFileSync(outPath, html);

const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`\n  ledger.html written  ${kb} KB  ${payload.results.length} payments`);
console.log(`  batch ......... seed ${seed}, ${records} records`);
console.log(`  scorecard ..... ${nSweep} batches  precision ${(prec.mean * 100).toFixed(1)}%  recall ${(rec.mean * 100).toFixed(1)}%  explanation ${(expl.mean * 100).toFixed(1)}%`);
console.log(`  reportable .... ${payload.meta.reportable ? "yes" : `no — ${missing.length} uncited base rates`}`);
console.log(`\n  double-click ui/ledger.html to open it. No server needed.\n`);
