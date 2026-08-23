"use strict";
/* ══════════════════════════════════════════════════════════════
   CANONICAL LEDGER SCHEMA
   ──────────────────────────────────────────────────────────────
   One shape for everything that enters the system, whether it came
   from a Razorpay webhook, a test-mode API pull, or the synthetic
   seeder. Downstream — reconciler, detector, gates, audit — reads
   only this shape and never a raw provider payload.

   ── Money is integer paise. Always. ──────────────────────────
   Not rupees, not floats, not strings. 0.1 + 0.2 !== 0.3 in IEEE
   754, and a reconciler built on floats will produce off-by-one-
   paisa exceptions that look like real breaks and waste the one
   thing this project is short of. Razorpay's own amounts are in
   paise, so this also removes a conversion at the boundary — the
   place conversions go wrong.

   ── Validation refuses, it does not coerce. ──────────────────
   A record that does not validate is quarantined and counted, not
   patched into shape. Silently repaired data is how a match rate
   ends up describing the repair rather than the reconciliation.
   ══════════════════════════════════════════════════════════════ */

const KINDS = Object.freeze([
  "payment_failed",        /* a charge attempt that did not succeed        */
  "checkout_abandoned",    /* an order created, never paid                 */
  "subscription_halted",   /* recurring mandate stopped after failures     */
  "invoice_overdue",       /* B2B receivable past its due date             */
  "payment_captured",      /* the success side — needed to reconcile       */
  "refund_processed",
  "settlement_line",       /* what actually landed in the bank account     */
]);

const METHODS = Object.freeze(["card", "upi", "netbanking", "wallet", "emandate"]);

/* Razorpay's failure taxonomy is (source, step, code, reason). The
   values below are the ones the seeder emits. Verify the full
   current vocabulary against Razorpay's error documentation before
   wiring real webhooks — this list is the subset needed to model
   recoverability, not the whole surface. */
const FAILURE_SOURCES = Object.freeze(["customer", "business", "bank", "gateway", "nbfc"]);
const FAILURE_STEPS = Object.freeze([
  "payment_initiation",
  "payment_authentication",
  "payment_authorization",
  "payment_capture",
]);
const FAILURE_REASONS = Object.freeze([
  "insufficient_funds",
  "gateway_error",
  "issuer_down",
  "payment_timeout",
  "authentication_failed",
  "card_expired",
  "card_blocked",
  /* mandate_revoked was a single bucket until a review of Razorpay's
     subscription docs surfaced that "the mandate stopped working"
     is three different situations with three different remedies,
     not one:

       mandate_revoked           the customer cancelled consent at
                                  their bank/UPI app entirely — dead,
                                  no API call reverses this
       mandate_paused_by_customer the customer paused it through their
                                  own consent flow — Razorpay's API
                                  will not let the business force a
                                  resume; only the customer can
       mandate_paused_by_business the business paused it (a billing
                                  hold, a plan change) — the business
                                  CAN resume it via API

     Collapsing these into one "revoked" reason would tell an agent
     to give up on a record that a single API call could fix, and
     would tell it to keep nudging a customer who was never the one
     blocking it in the first place. */
  "mandate_revoked",
  "mandate_paused_by_customer",
  "mandate_paused_by_business",
  "invalid_account",
]);

/* Locales the recovery agent may compose in. Kept explicit so that
   "we support regional languages" is a list a reviewer can count,
   not an adjective. */
const LOCALES = Object.freeze(["en", "hi", "ta", "te", "kn", "ml", "mr", "bn", "gu"]);

const isInt = (n) => Number.isInteger(n);
const isStr = (s) => typeof s === "string" && s.length > 0;

/**
 * Validate one canonical record.
 * @returns {{ok:true}|{ok:false, errors:string[]}}
 */
function validateRecord(r) {
  const e = [];

  if (!isStr(r?.event_id)) e.push("event_id must be a non-empty string");
  if (!isStr(r?.ts) || Number.isNaN(Date.parse(r.ts))) e.push("ts must be an ISO-8601 timestamp");
  if (!KINDS.includes(r?.kind)) e.push(`kind must be one of ${KINDS.join("|")}`);
  if (!isStr(r?.merchant_id)) e.push("merchant_id must be a non-empty string");

  if (!isStr(r?.entity?.type)) e.push("entity.type required");
  if (!isStr(r?.entity?.id)) e.push("entity.id required");

  if (!isInt(r?.amount_paise)) e.push("amount_paise must be an integer (paise, never rupees or float)");
  else if (r.amount_paise < 0) e.push("amount_paise must be >= 0");
  if (r?.currency !== "INR") e.push('currency must be "INR" for this build');

  if (!METHODS.includes(r?.method)) e.push(`method must be one of ${METHODS.join("|")}`);

  if (!isStr(r?.customer?.id)) e.push("customer.id required");
  if (!isStr(r?.customer?.contact_hash)) e.push("customer.contact_hash required (never a raw phone or email)");
  if (!LOCALES.includes(r?.customer?.locale)) e.push(`customer.locale must be one of ${LOCALES.join("|")}`);
  if (typeof r?.customer?.dnc !== "boolean") e.push("customer.dnc must be boolean");

  const needsFailure = r?.kind === "payment_failed" || r?.kind === "subscription_halted";
  if (needsFailure) {
    if (!FAILURE_SOURCES.includes(r?.failure?.source)) e.push("failure.source invalid");
    if (!FAILURE_STEPS.includes(r?.failure?.step)) e.push("failure.step invalid");
    if (!FAILURE_REASONS.includes(r?.failure?.reason)) e.push("failure.reason invalid");
    if (!isStr(r?.failure?.code)) e.push("failure.code required");
  }

  if (!isInt(r?.attempt_no) || r.attempt_no < 0) e.push("attempt_no must be a non-negative integer");

  return e.length ? { ok: false, errors: e } : { ok: true };
}

/**
 * Validate a batch. Returns the clean records and a quarantine list,
 * so a caller can report "n ingested, k quarantined" honestly rather
 * than discovering the loss as a smaller denominator later.
 */
function validateBatch(records) {
  const clean = [], quarantined = [];
  for (const r of records) {
    const v = validateRecord(r);
    if (v.ok) clean.push(r);
    else quarantined.push({ record: r, errors: v.errors });
  }
  return { clean, quarantined };
}

/** Display helper. Never used for arithmetic. */
function rupees(paise) {
  const sign = paise < 0 ? "-" : "";
  const p = Math.abs(paise);
  return `${sign}\u20B9${Math.floor(p / 100).toLocaleString("en-IN")}.${String(p % 100).padStart(2, "0")}`;
}

module.exports = {
  KINDS, METHODS, LOCALES,
  FAILURE_SOURCES, FAILURE_STEPS, FAILURE_REASONS,
  validateRecord, validateBatch, rupees,
};
