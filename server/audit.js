"use strict";
/* ══════════════════════════════════════════════════════════════
   AUDIT — the hash-chained record of every money decision
   ──────────────────────────────────────────────────────────────
   Razorpay's stated bar for this track is: "Every money action
   explainable, bounded and gated. Show the audit trail and one
   failure handled gracefully."

   gates.js covers bounded and gated. It also produces a complete
   explanation of every verdict — but that explanation lived only
   in memory, for the duration of one process. This file makes it
   an artefact: append-only, ordered, exportable, and linked so
   that a change to any past entry is detectable.

   ── How the chain works ───────────────────────────────────────
   Each entry stores the hash of the one before it, and its own
   hash covers that link:

       hash(n) = sha256( seq | ts | hash(n-1) | canonical(payload) )

   Edit entry 3's payload and entry 3's hash no longer matches;
   recompute entry 3's hash and entry 4's prev_hash no longer
   matches. A single edit anywhere breaks every link after it, and
   verify() reports the exact sequence number where the break
   starts.

   ── What this is NOT ──────────────────────────────────────────
   This is tamper-EVIDENT, not tamper-PROOF, and the difference
   matters enough to state plainly rather than let a reviewer
   assume the stronger claim.

   Anyone who can rewrite the whole file can recompute every hash
   from the point of their edit onward and produce a chain that
   verifies perfectly. What this defends against is a casual or
   partial edit — someone changing one amount, deleting one
   inconvenient row, or reordering entries — not a determined
   attacker with write access and five minutes.

   Real tamper-proofing needs an anchor OUTSIDE the file: signing
   each entry with a key the writer does not hold, or periodically
   committing the head hash somewhere append-only. Both are
   documented as the upgrade path rather than implied to already
   be here.

   ── Canonical serialisation ───────────────────────────────────
   JSON.stringify does not guarantee key order for objects built
   at different times, and a hash over inconsistently-ordered keys
   would produce spurious "tampering" on a perfectly honest file.
   canonical() sorts keys recursively so the same logical payload
   always hashes identically.
   ══════════════════════════════════════════════════════════════ */

const crypto = require("crypto");

const GENESIS_PREV = "0".repeat(64);

/* Entry kinds. A closed set, so a reader can enumerate what can
   possibly appear in a log rather than discovering types by
   grepping. */
const KINDS = Object.freeze([
  "run_started",
  "decision",      /* a proposal met the gates — trace included    */
  "execution",     /* an allowed action was actually carried out   */
  "outcome",       /* what the action produced                     */
  "state_change",  /* opt-out, DNC flip, kill switch, etc.         */
  "run_ended",
]);

/** Recursively key-sorted JSON, so equal payloads hash equally. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

function hashEntry({ seq, ts, prev_hash, kind, payload }) {
  return crypto.createHash("sha256")
    .update(`${seq}|${ts}|${prev_hash}|${kind}|${canonical(payload)}`)
    .digest("hex");
}

/**
 * Create an append-only audit chain.
 *
 * @param {object} [opts]
 * @param {() => Date} [opts.clock] injectable, so tests can produce
 *   a deterministic chain instead of one that changes every run.
 */
function createAuditChain({ clock } = {}) {
  const entries = [];
  const now = clock || (() => new Date());

  function append(kind, payload) {
    if (!KINDS.includes(kind)) throw new Error(`audit: unknown entry kind "${kind}"`);
    const seq = entries.length;
    const ts = now().toISOString();
    const prev_hash = seq === 0 ? GENESIS_PREV : entries[seq - 1].hash;
    const entry = { seq, ts, prev_hash, kind, payload };
    entry.hash = hashEntry(entry);
    /* Frozen on append. The chain is append-only by construction,
       not merely by convention — a caller cannot reach back and
       adjust an entry it already wrote. */
    entries.push(Object.freeze(entry));
    return entry;
  }

  return {
    append,
    entries: () => entries.slice(),
    head: () => (entries.length ? entries[entries.length - 1].hash : GENESIS_PREV),
    length: () => entries.length,
  };
}

/**
 * Walk a chain and report the first break.
 * @returns {{ok:true, length:number, head:string}
 *          |{ok:false, brokenAt:number, reason:string}}
 */
function verifyChain(entries) {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) return { ok: false, brokenAt: i, reason: `sequence number is ${e.seq}, expected ${i} — an entry was inserted, removed or reordered` };
    const expectedPrev = i === 0 ? GENESIS_PREV : entries[i - 1].hash;
    if (e.prev_hash !== expectedPrev) return { ok: false, brokenAt: i, reason: `prev_hash does not match entry ${i - 1}'s hash — the chain is cut here` };
    const recomputed = hashEntry({ seq: e.seq, ts: e.ts, prev_hash: e.prev_hash, kind: e.kind, payload: e.payload });
    if (recomputed !== e.hash) return { ok: false, brokenAt: i, reason: `stored hash does not match this entry's own contents — entry ${i} was modified after it was written` };
  }
  return { ok: true, length: entries.length, head: entries.length ? entries[entries.length - 1].hash : GENESIS_PREV };
}

/**
 * Flatten the chain to CSV — one row per entry, with the fields an
 * auditor actually reads first. The full payload stays in the JSON
 * export; this is the scannable view.
 */
function toCSV(entries) {
  const esc = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["seq", "ts", "kind", "entity_id", "proposed", "final", "allowed", "blocked_by", "amount_paise", "cost_paise", "outcome", "hash"];
  const rows = entries.map((e) => {
    const p = e.payload || {};
    const blocked = Array.isArray(p.trace) ? p.trace.filter((t) => t.result === "block").map((t) => t.gate).join(" ") : "";
    return [
      e.seq, e.ts, e.kind,
      p.entity_id, p.proposed, p.final,
      p.allowed === undefined ? "" : p.allowed,
      blocked,
      p.amount_paise, p.cost_paise,
      p.paid === undefined ? "" : (p.paid ? "paid" : "not_paid"),
      e.hash.slice(0, 16),
    ].map(esc).join(",");
  });
  return [header.join(","), ...rows].join("\n");
}

/**
 * Summarise which gates actually did work across a whole run.
 * A gate that never fires in any run is either unnecessary or
 * untested by the scenario — either way worth seeing.
 */
function gateActivity(entries) {
  const blocks = {};
  let decisions = 0;
  for (const e of entries) {
    if (e.kind !== "decision") continue;
    decisions++;
    for (const t of e.payload.trace || []) {
      if (t.result === "block") blocks[t.gate] = (blocks[t.gate] || 0) + 1;
    }
  }
  return { decisions, blocks };
}

/* Why a gate can legitimately never fire in a healthy run. Written
   down rather than left for a reader to assume the charitable
   explanation — or the uncharitable one.

   The distinction that matters: EVERY gate here has direct unit
   tests in test/smoke.js that force it to fire. "Never fired in
   this run" therefore means "this scenario didn't reach it," not
   "this code has never been executed." Those are very different
   claims and conflating them would be the dishonest version of
   this report. */
const NEVER_FIRE_REASONS = Object.freeze({
  kill_switch: { kind: "by-design", why: "only fires when a human engages it; a clean run should never trip it" },
  action_allowlist: { kind: "by-design", why: "only fires on a malformed proposal; both shipped policies emit valid actions only" },
  business_paused_no_nudge: { kind: "backstop", why: "smartPolicy already refuses to propose a nudge here, so the gate has nothing to catch — it exists for a policy that isn't as careful" },
  mandate_charge_block: { kind: "backstop", why: "a policy that checks the failure reason first never reaches it; it exists to catch one that doesn't" },
  attempt_ceiling: { kind: "backstop", why: "both policies self-terminate at or before the ceiling, so the gate is a second line rather than the first" },
  cooldown: { kind: "scenario", why: "depends on how tightly a policy re-proposes; fires for blind retry, not for one that escalates channels" },
  quiet_hours: { kind: "scenario", why: "only fires if the run's simulated clock lands outside the contact window" },
  do_not_contact: { kind: "scenario", why: "only fires once some customer has actually opted out" },
  approval_ceiling: { kind: "scenario", why: "only fires when the batch contains amounts at or above the ceiling" },
  spend_cap_run: { kind: "scenario", why: "only fires if the run's cumulative spend approaches the cap" },
  spend_cap_day: { kind: "scenario", why: "only fires if a single simulated day's spend approaches the cap" },
});

/**
 * Full coverage report: which gates fired, which didn't, and which
 * category each silent gate falls into.
 *
 * @param {Array} entries
 * @param {Array<string>} allGateNames  from gates.js GATE_NAMES
 */
function gateCoverage(entries, allGateNames) {
  const { decisions, blocks } = gateActivity(entries);
  const fired = allGateNames.filter((g) => blocks[g]);
  const silent = allGateNames.filter((g) => !blocks[g]).map((g) => ({
    gate: g,
    ...(NEVER_FIRE_REASONS[g] || { kind: "unclassified", why: "no explanation recorded — investigate before shipping" }),
  }));
  return {
    decisions,
    total: allGateNames.length,
    firedCount: fired.length,
    fired: fired.map((g) => ({ gate: g, blocks: blocks[g] })),
    silent,
    unclassified: silent.filter((s) => s.kind === "unclassified").map((s) => s.gate),
  };
}

module.exports = {
  createAuditChain, verifyChain, toCSV, gateActivity, gateCoverage,
  canonical, hashEntry, KINDS, GENESIS_PREV, NEVER_FIRE_REASONS,
};
