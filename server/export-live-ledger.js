"use strict";
/* ══════════════════════════════════════════════════════════════
   EXPORT-LIVE-LEDGER — bridges the webhook receiver's log into
   the shape recon.js, discrepancy.js, and recover.js expect
   ──────────────────────────────────────────────────────────────
   Found necessary through real manual testing, not designed in
   advance: index.js's webhook receiver appends each ingested
   event as one line of a durable NDJSON file (`data/ingested.jsonl`
   — one JSON object per line, the correct shape for an
   append-only live log). recon.js and discrepancy.js instead
   expect a single JSON array at `data/ledger.json`.

   A real user hit this gap directly: after successfully sending a
   real, signed webhook to a running server, the natural next step
   was "now reconcile it" — and every offline tool refused, because
   nothing bridges the two shapes. Manual attempts to paper over it
   (fetching GET /ledger's `{count, records}` wrapper and writing
   the raw object as `ledger.json`, then copying that same object
   in as a stand-in `truth.json`) produced "ledger is not iterable"
   and a 0-everything reconciliation — the wrapper object isn't an
   array, and a copy of the ledger is not an answer key.

   This script does the conversion correctly and repeatably instead
   of leaving every user to reconstruct it once by hand.

     node export-live-ledger.js
     node export-live-ledger.js --data ./data
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");

function exportLiveLedger({ dataDir }) {
  const src = path.join(dataDir, "ingested.jsonl");
  const dest = path.join(dataDir, "ledger.json");

  if (!fs.existsSync(src)) {
    return { ok: false, reason: `no live-ingested data found at ${src}` };
  }

  const lines = fs.readFileSync(src, "utf8").split("\n").filter(Boolean);
  const records = lines.map((l) => JSON.parse(l));

  fs.writeFileSync(dest, JSON.stringify(records, null, 2));
  return { ok: true, count: records.length, dest };
}

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const dataDir = path.resolve(arg("data", "./data"));

  const result = exportLiveLedger({ dataDir });

  if (!result.ok) {
    console.log(`\n${result.reason}.`);
    console.log(`Nothing has been received by index.js's webhook receiver yet, or DATA_DIR points`);
    console.log(`somewhere else than expected. Start the server and send it at least one webhook`);
    console.log(`first — see the VS Code testing guide, Level 3 or 4.\n`);
    process.exit(1);
  }

  console.log(`\n${result.count} live-ingested record(s) exported to ${result.dest}\n`);
  console.log(`This is REAL data — there is no answer key for it, and there shouldn't be: nobody`);
  console.log(`knows the "true" classification of a genuine external event before it happens. The`);
  console.log(`synthetic seeder's truth.json only makes sense for its own written-in-advance`);
  console.log(`batches. recon.js and discrepancy.js both run without one and say so plainly:\n`);
  console.log(`  node recon.js --data ${path.relative(process.cwd(), dataDir) || "."}`);
  console.log(`  node discrepancy.js --data ${path.relative(process.cwd(), dataDir) || "."}\n`);
}

module.exports = { exportLiveLedger };
