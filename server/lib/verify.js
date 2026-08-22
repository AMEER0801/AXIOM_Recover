"use strict";
/* ══════════════════════════════════════════════════════════════
   WEBHOOK SIGNATURE VERIFICATION
   ──────────────────────────────────────────────────────────────
   Razorpay signs each webhook with HMAC-SHA256 over the request
   body using the webhook secret, and sends the hex digest in the
   `x-razorpay-signature` header.

   Three ways this is routinely got wrong, all three fixed here:

   1. Verifying the RE-SERIALISED body.
      `JSON.stringify(req.body)` is not the bytes that were signed.
      Key order, whitespace and unicode escaping all differ, so the
      HMAC will not match — and the usual "fix" is to disable
      verification. This module takes a Buffer of the raw body, and
      index.js captures it with express.json({ verify }).

   2. Comparing with `===`.
      String comparison short-circuits on the first differing byte,
      which leaks the position of that byte through timing. Use
      timingSafeEqual over equal-length buffers.

   3. No replay window.
      A valid signed request stays valid forever. Anyone who
      captures one can send it again. `x-razorpay-event-id` gives
      idempotency and the payload carries `created_at`; both are
      checked.

   ── Failure is loud and specific to us, vague to the caller ───
   The functions return a reason so the audit log can say WHY a
   webhook was rejected. The HTTP layer must not echo that reason
   back — an attacker probing the endpoint should learn only that
   it failed.
   ══════════════════════════════════════════════════════════════ */

const crypto = require("crypto");

const REPLAY_WINDOW_SECONDS = 300;

/**
 * @param {Buffer|string} rawBody exact bytes received
 * @param {string} signature      x-razorpay-signature header
 * @param {string} secret         webhook secret
 * @returns {{ok:boolean, reason?:string}}
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret) return { ok: false, reason: "no_webhook_secret_configured" };
  if (typeof signature !== "string" || !signature) return { ok: false, reason: "missing_signature_header" };
  if (rawBody == null) return { ok: false, reason: "missing_raw_body" };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim(), "utf8");
  /* timingSafeEqual throws on a length mismatch, which would itself
     be a timing signal and a crash. Check length first, then compare. */
  if (a.length !== b.length) return { ok: false, reason: "signature_length_mismatch" };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };

  return { ok: true };
}

/**
 * Reject webhooks older than the replay window.
 * @param {number} createdAt unix seconds from the webhook payload
 */
function withinReplayWindow(createdAt, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(createdAt)) return { ok: false, reason: "missing_created_at" };
  const age = nowSeconds - createdAt;
  if (age > REPLAY_WINDOW_SECONDS) return { ok: false, reason: `stale_${age}s` };
  /* A small negative age is ordinary clock skew between two hosts.
     A large one is not, and should not be quietly accepted. */
  if (age < -60) return { ok: false, reason: `future_dated_${-age}s` };
  return { ok: true };
}

/**
 * Seen-event tracker for webhook idempotency.
 *
 * In-memory with a bounded LRU. That is correct for a single-process
 * demo and WRONG for more than one instance — two processes would
 * each accept the same delivery once. The eviction cap also means a
 * replay older than `max` deliveries would be re-accepted. Both are
 * stated here rather than discovered by a reviewer: for production
 * this becomes a Redis SETNX or a unique index on event_id.
 */
function createEventSeenSet(max = 10000) {
  const seen = new Set();
  return {
    /** @returns {boolean} true if this is the first sighting */
    firstSighting(eventId) {
      if (!eventId) return true;           /* cannot dedupe without an id */
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      if (seen.size > max) seen.delete(seen.values().next().value);
      return true;
    },
    size: () => seen.size,
  };
}

/**
 * Verify a payment/order signature returned to the browser after
 * checkout. Different construction from webhooks: HMAC over
 * `${order_id}|${payment_id}` keyed with the API SECRET, not the
 * webhook secret. Mixing the two up is a common and silent bug.
 */
function verifyPaymentSignature({ orderId, paymentId, signature, apiSecret }) {
  if (!apiSecret) return { ok: false, reason: "no_api_secret_configured" };
  if (!orderId || !paymentId || !signature) return { ok: false, reason: "missing_field" };
  const expected = crypto
    .createHmac("sha256", apiSecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature).trim(), "utf8");
  if (a.length !== b.length) return { ok: false, reason: "signature_length_mismatch" };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

/**
 * One-way contact hash. Raw phone numbers and email addresses never
 * enter the ledger, the audit log or an export — only this digest.
 * Salted from the environment so a leaked export cannot be reversed
 * with a rainbow table over the ~10^10 Indian mobile number space,
 * which an unsalted SHA-256 absolutely would be.
 */
function contactHash(contact, salt) {
  if (!salt) throw new Error("contactHash: CONTACT_SALT is required — refusing to emit an unsalted hash");
  return "ch_" + crypto.createHmac("sha256", salt).update(String(contact).trim().toLowerCase()).digest("hex").slice(0, 24);
}

module.exports = {
  REPLAY_WINDOW_SECONDS,
  verifyWebhookSignature,
  withinReplayWindow,
  createEventSeenSet,
  verifyPaymentSignature,
  contactHash,
};
