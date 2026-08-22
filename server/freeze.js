"use strict";
/* ══════════════════════════════════════════════════════════════
   FREEZE / VERIFY
   ──────────────────────────────────────────────────────────────
   `node freeze.js`         writes model/FROZEN.json
   `node freeze.js --check` exits non-zero if anything has changed

   The eval harness calls --check before it will emit a reportable
   number. So the claim "the response model was fixed before the
   agent existed" is not a sentence in a README — it is a hash, a
   git timestamp, and a build step that fails when it stops being
   true.

   ── The citation gate ────────────────────────────────────────
   --check also walks base-rates.json and fails on any parameter
   whose `source` is empty. A run can still be executed with
   uncited rates (that is how you develop), but it is stamped
   `reportable: false` and every downstream artefact carries the
   stamp. Nothing that reaches a reviewer can be silently
   uncited.
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const TARGETS = [
  "model/response-model.frozen.js",
  "model/base-rates.json",
  "lib/rng.js",
];
const FROZEN_PATH = path.join(ROOT, "model", "FROZEN.json");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex");
}

/** Walk base-rates.json for leaves with an empty `source`. */
function uncited(node, trail = []) {
  const out = [];
  if (node && typeof node === "object" && !Array.isArray(node)) {
    if ("value" in node && "source" in node) {
      if (!String(node.source).trim()) out.push(trail.join("."));
      return out;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("_")) continue;
      out.push(...uncited(v, [...trail, k]));
    }
  }
  return out;
}

function currentHashes() {
  const h = {};
  for (const t of TARGETS) h[t] = sha256(t);
  return h;
}

function freeze() {
  const payload = {
    frozen_at: new Date().toISOString(),
    note: "Hashes of the customer-response model and its inputs, committed before agent decision logic. Regenerating this file after seeing results invalidates the experiment — the git history of this file is part of the evidence.",
    hashes: currentHashes(),
  };
  fs.writeFileSync(FROZEN_PATH, JSON.stringify(payload, null, 2));
  console.log(`\nfrozen at ${payload.frozen_at}`);
  for (const [f, h] of Object.entries(payload.hashes)) console.log(`  ${h.slice(0, 16)}…  ${f}`);
  console.log(`\n  commit model/FROZEN.json now. Its git timestamp is the proof.\n`);
}

function check() {
  if (!fs.existsSync(FROZEN_PATH)) {
    console.error("FAIL  model/FROZEN.json missing — run `node freeze.js` first");
    process.exit(2);
  }
  const frozen = JSON.parse(fs.readFileSync(FROZEN_PATH, "utf8"));
  const now = currentHashes();

  let drift = 0;
  for (const t of TARGETS) {
    if (frozen.hashes[t] !== now[t]) {
      console.error(`DRIFT ${t}\n        frozen ${String(frozen.hashes[t]).slice(0, 16)}…\n        now    ${now[t].slice(0, 16)}…`);
      drift++;
    }
  }

  const rates = JSON.parse(fs.readFileSync(path.join(ROOT, "model", "base-rates.json"), "utf8"));
  const missing = uncited(rates);

  if (drift) {
    console.error(`\nFAIL  ${drift} frozen file(s) changed since the freeze.`);
    console.error("      If the change is legitimate, say so in the commit message and re-freeze.");
    console.error("      If it followed a result you did not like, the experiment is over.\n");
    process.exit(1);
  }

  console.log("OK    frozen model intact");

  if (missing.length) {
    console.log(`\nNOT REPORTABLE  ${missing.length} base rate(s) have no source:`);
    missing.slice(0, 40).forEach((m) => console.log(`  · ${m}`));
    if (missing.length > 40) console.log(`  … and ${missing.length - 40} more`);
    console.log("\n  Runs still execute. Every artefact will be stamped reportable:false");
    console.log("  until each of these carries a citation.\n");
    process.exit(3);
  }

  console.log("OK    every base rate is cited — runs are reportable\n");
}

if (require.main === module) {
  if (process.argv.includes("--check")) check();
  else freeze();
}

module.exports = { currentHashes, uncited };
