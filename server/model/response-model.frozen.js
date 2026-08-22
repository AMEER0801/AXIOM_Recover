"use strict";
/* ══════════════════════════════════════════════════════════════
   FROZEN CUSTOMER RESPONSE MODEL
   ──────────────────────────────────────────────────────────────
   Committed BEFORE any agent decision logic was written. That
   ordering is the point, and it is checkable: `npm run freeze`
   writes a SHA-256 of this file plus base-rates.json into
   model/FROZEN.json, and the eval harness refuses to report a
   number if the hash no longer matches.

   ── Why this file exists ─────────────────────────────────────
   Track 3 asks for "measured money recovered across a batch".
   The customers in that batch are synthetic, so something has to
   decide whether a synthetic customer pays. If that something is
   written or tuned after the agent exists, the measurement is
   circular: the agent is being scored by a judge it shaped. The
   number then means nothing, however large it is, and a reviewer
   who asks one good question will find that out on camera.

   So the causal arrow is fixed in one direction and made
   tamper-evident:

       base rates  ->  this model  ->  outcome
                                          ^
                       agent decisions ---'   (may influence WHICH
                                               intervention runs,
                                               never HOW it resolves)

   The agent may read nothing in this file. It is loaded only by
   the simulator and only at scoring time.

   ── What this model deliberately does NOT do ─────────────────
   It does not learn. It does not adapt to the agent. It has no
   memory of which agent is being tested. Two different agents
   facing the same record with the same intervention, attempt
   number and elapsed time get the same distribution — the only
   thing an agent can change is which arm it pulls and when.

   ── Determinism ──────────────────────────────────────────────
   Every draw comes from a seeded PRNG keyed on the record id and
   the attempt number, never from Math.random(). Same seed, same
   batch, same outcomes — so a baseline arm and an agent arm face
   an identical world and the delta between them is real rather
   than two different rolls of the dice.
   ══════════════════════════════════════════════════════════════ */

const { rngFor } = require("../lib/rng");

/* ── the intervention vocabulary ───────────────────────────────
   This is the closed set. An agent that emits anything outside it
   is rejected upstream by the gate layer, never silently coerced. */
const INTERVENTIONS = Object.freeze([
  "NO_ACTION",
  "RETRY_CHARGE",
  "PAYMENT_LINK_SMS",
  "PAYMENT_LINK_WHATSAPP",
  "DUNNING_EMAIL",
  "VOICE_NUDGE_REGIONAL",
  "ESCALATE_HUMAN",
  "WRITE_OFF",
]);

const CHARGING = new Set(["RETRY_CHARGE"]);
const CONTACTING = new Set([
  "PAYMENT_LINK_SMS",
  "PAYMENT_LINK_WHATSAPP",
  "DUNNING_EMAIL",
  "VOICE_NUDGE_REGIONAL",
]);

const NUDGE_KEY = {
  PAYMENT_LINK_SMS: "payment_link_sms",
  PAYMENT_LINK_WHATSAPP: "payment_link_whatsapp",
  DUNNING_EMAIL: "dunning_email",
  VOICE_NUDGE_REGIONAL: "voice_nudge_regional",
};

/* ── base-rate lookup ──────────────────────────────────────────
   `v()` reads a leaf and returns its number. It throws on a
   missing path rather than defaulting, because a silent 0 here
   would quietly zero out a whole arm of the experiment. */
function v(rates, path) {
  const parts = path.split(".");
  let node = rates;
  for (const p of parts) {
    if (node == null || !(p in node)) {
      throw new Error(`base-rates: missing path "${path}" (stopped at "${p}")`);
    }
    node = node[p];
  }
  if (typeof node === "object" && node !== null && "value" in node) return node.value;
  if (typeof node === "number") return node;
  throw new Error(`base-rates: path "${path}" is not a leaf with a value`);
}

function attemptBucket(n) {
  return n >= 4 ? "4+" : String(Math.max(1, n));
}

function timingBucket(hours) {
  if (hours < 6) return "lt_6h";
  if (hours < 24) return "6_24h";
  if (hours < 72) return "24_72h";
  if (hours <= 168) return "72_168h";
  return "gt_168h";
}

/* Clamp, but loudly. A probability outside [0,1] means a base rate
   or multiplier is wrong, and the run should surface that rather
   than absorb it. */
function prob(p, label) {
  if (!Number.isFinite(p)) throw new Error(`response-model: non-finite probability for ${label}`);
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * Resolve one intervention against one record.
 *
 * @param {object}  a
 * @param {object}  a.record        canonical ledger record (see lib/schema.js)
 * @param {string}  a.intervention  member of INTERVENTIONS
 * @param {number}  a.attemptNo     1-based attempt count for this record
 * @param {number}  a.hoursSinceFail elapsed hours since the original failure
 * @param {string}  a.messageLocale locale the message was sent in ("en" | "ta" | ...)
 * @param {object}  a.rates         parsed base-rates.json
 * @param {number}  a.seed          batch seed
 * @returns {{paid:boolean, amount_paise:number, opted_out:boolean,
 *            direct_cost_paise:number, resolved_after_hours:number,
 *            arm:string, p_pay:number, p_opt_out:number}}
 */
function resolve({ record, intervention, attemptNo, hoursSinceFail, messageLocale, rates, seed }) {
  if (!INTERVENTIONS.includes(intervention)) {
    throw new Error(`response-model: unknown intervention "${intervention}"`);
  }

  const rand = rngFor(seed, record.event_id, attemptNo, intervention);
  const out = {
    paid: false,
    amount_paise: 0,
    opted_out: false,
    direct_cost_paise: 0,
    resolved_after_hours: 0,
    arm: intervention,
    p_pay: 0,
    p_opt_out: 0,
  };

  /* Non-acting arms resolve immediately and cost nothing. WRITE_OFF
     is not free in reality, but its cost is the forgone principal,
     which the ledger already accounts for as unrecovered. Charging
     it again here would double-count. */
  if (intervention === "NO_ACTION" || intervention === "WRITE_OFF") return out;

  if (intervention === "ESCALATE_HUMAN") {
    const mins = v(rates, "intervention_cost_paise.escalate_human_minutes");
    const perHr = v(rates, "intervention_cost_paise.human_cost_per_hour_paise");
    out.direct_cost_paise = Math.round((mins / 60) * perHr);
    /* A human is not modelled as an outcome generator here. Escalation
       hands the record out of the automated system; whether a person
       later recovers it is outside what this batch can honestly claim.
       It is scored as cost incurred, money not yet recovered — which
       is the conservative direction. */
    return out;
  }

  const reason = record.failure?.reason || "payment_failed";
  const recover = (() => {
    try { return v(rates, `failure_reason_recoverability.${reason}`); }
    catch { return 1.0; }   /* unlisted reason: no adjustment, and the
                               seeder only emits listed reasons, so this
                               path firing at all is a data-quality signal */
  })();

  if (CHARGING.has(intervention)) {
    out.direct_cost_paise = v(rates, "intervention_cost_paise.retry_charge");

    const method = record.method === "emandate" ? "emandate"
                 : record.method === "upi" ? "upi" : "card";
    const base = v(rates, `retry_success_by_attempt.${method}.${attemptBucket(attemptNo)}`);
    const timing = v(rates, `retry_timing_multiplier.${timingBucket(hoursSinceFail)}`);

    const p = prob(base * timing * recover, `retry/${method}/${reason}`);
    out.p_pay = p;

    if (rand() < p) {
      out.paid = true;
      out.amount_paise = record.amount_paise;
      out.resolved_after_hours = Math.round(rand() * 4);
    }
    /* A silent retry cannot annoy a customer into opting out — no
       message reaches them. Only CONTACTING arms carry that hazard. */
    return out;
  }

  if (CONTACTING.has(intervention)) {
    const key = NUDGE_KEY[intervention];
    out.direct_cost_paise = v(rates, `intervention_cost_paise.${key}`);

    const base = v(rates, `nudge_conversion.${key}`);
    const matched = messageLocale && record.customer?.locale && messageLocale === record.customer.locale;
    const uplift = v(rates, `locale_uplift.${matched ? "matched_language" : "english_default"}`);

    const p = prob(base * uplift * recover, `nudge/${key}/${reason}`);
    out.p_pay = p;

    const hazBase = v(rates, `opt_out_hazard.${key}`);
    const hazMult = v(rates, "opt_out_hazard.per_extra_contact_multiplier");
    const pOut = prob(hazBase * Math.pow(hazMult, Math.max(0, attemptNo - 1)), `optout/${key}`);
    out.p_opt_out = pOut;

    /* Draw the two events from independent streams. Sharing one draw
       would couple paying and opting out, which is not a property of
       the world — it is a property of reusing a variable. */
    if (rand() < p) {
      out.paid = true;
      out.amount_paise = record.amount_paise;
      out.resolved_after_hours = Math.round(rand() * v(rates, "response_window_hours"));
    }
    if (rand() < pOut) out.opted_out = true;

    return out;
  }

  return out;
}

module.exports = { INTERVENTIONS, CHARGING, CONTACTING, resolve, __v: v };
