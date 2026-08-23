"use strict";
/* ══════════════════════════════════════════════════════════════
   SMOKE TESTS
   ──────────────────────────────────────────────────────────────
   Every assertion here corresponds to a claim the README makes.
   The point is that a reviewer does not have to take any of them
   on trust: `npm test` either passes or the claim is withdrawn.

   No framework. `node test/smoke.js`.
   ══════════════════════════════════════════════════════════════ */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

process.env.CONTACT_SALT = process.env.CONTACT_SALT || "test-salt-not-for-production";

const {
  verifyWebhookSignature, withinReplayWindow,
  createEventSeenSet, verifyPaymentSignature, contactHash,
} = require("../lib/verify");
const { RazorpayClient } = require("../lib/rzp");
const { validateRecord, rupees } = require("../lib/schema");
const { rngFor } = require("../lib/rng");
const { generate } = require("../seed");
const { resolve, INTERVENTIONS } = require("../model/response-model.frozen");
const { classifyFailureReason } = require("../index.js");
const { evaluateGates, GATE_NAMES, createAttemptLedger, createSpendTracker, createKillSwitch, withinQuietHours, DEFAULT_POLICY } = require("../gates");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n          ${e.message}`); fail++; }
}

const SECRET = "whsec_test_1234567890";
const sign = (body, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

console.log("\nwebhook signature");

t("accepts a correctly signed body", () => {
  const body = Buffer.from(JSON.stringify({ event: "payment.failed", created_at: 1 }));
  assert.strictEqual(verifyWebhookSignature(body, sign(body), SECRET).ok, true);
});

t("rejects a body tampered with after signing", () => {
  const body = Buffer.from('{"amount":10000}');
  const sig = sign(body);
  const tampered = Buffer.from('{"amount":99999}');
  assert.strictEqual(verifyWebhookSignature(tampered, sig, SECRET).ok, false);
});

t("rejects a signature made with the wrong secret", () => {
  const body = Buffer.from('{"a":1}');
  assert.strictEqual(verifyWebhookSignature(body, sign(body, "wrong"), SECRET).ok, false);
});

t("rejects when no secret is configured (fails closed)", () => {
  const body = Buffer.from('{"a":1}');
  assert.strictEqual(verifyWebhookSignature(body, sign(body), "").ok, false);
});

t("length mismatch does not throw", () => {
  const body = Buffer.from('{"a":1}');
  const r = verifyWebhookSignature(body, "deadbeef", SECRET);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "signature_length_mismatch");
});

t("re-serialised body would NOT verify — proving raw bytes are required", () => {
  const obj = { b: 2, a: 1 };
  const raw = Buffer.from('{"b":2,"a":1}');
  const sig = sign(raw);
  const reserialised = Buffer.from(JSON.stringify({ a: 1, b: 2 }));
  assert.strictEqual(verifyWebhookSignature(reserialised, sig, SECRET).ok, false);
  assert.strictEqual(verifyWebhookSignature(raw, sig, SECRET).ok, true);
});

console.log("\nreplay + dedupe");

t("rejects a stale delivery", () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.strictEqual(withinReplayWindow(old).ok, false);
});

t("accepts a fresh delivery", () => {
  assert.strictEqual(withinReplayWindow(Math.floor(Date.now() / 1000)).ok, true);
});

t("tolerates small clock skew, rejects large future dating", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.strictEqual(withinReplayWindow(now + 30).ok, true);
  assert.strictEqual(withinReplayWindow(now + 600).ok, false);
});

t("second sighting of an event id is suppressed", () => {
  const seen = createEventSeenSet();
  assert.strictEqual(seen.firstSighting("evt_1"), true);
  assert.strictEqual(seen.firstSighting("evt_1"), false);
});

console.log("\npayment signature");

t("order|payment signature verifies with the API secret", () => {
  const apiSecret = "apisecret";
  const orderId = "order_abc", paymentId = "pay_xyz";
  const sig = crypto.createHmac("sha256", apiSecret).update(`${orderId}|${paymentId}`).digest("hex");
  assert.strictEqual(verifyPaymentSignature({ orderId, paymentId, signature: sig, apiSecret }).ok, true);
});

t("webhook secret cannot be used to forge a payment signature", () => {
  const orderId = "order_abc", paymentId = "pay_xyz";
  const sig = crypto.createHmac("sha256", SECRET).update(`${orderId}|${paymentId}`).digest("hex");
  assert.strictEqual(verifyPaymentSignature({ orderId, paymentId, signature: sig, apiSecret: "apisecret" }).ok, false);
});

console.log("\ncontact privacy");

t("refuses to hash without a salt", () => {
  assert.throws(() => contactHash("9876543210", ""), /CONTACT_SALT/);
});

t("same contact + salt is stable; different salt is not reversible across exports", () => {
  const a = contactHash("9876543210", "s1");
  assert.strictEqual(a, contactHash("9876543210", "s1"));
  assert.notStrictEqual(a, contactHash("9876543210", "s2"));
});

t("hash does not contain the original number", () => {
  assert.ok(!contactHash("9876543210", "s1").includes("9876543210"));
});

console.log("\nrazorpay client");

t("refuses a live key without explicit override", () => {
  delete process.env.ALLOW_LIVE_KEYS;
  assert.throws(() => new RazorpayClient({ keyId: "rzp_live_abc", keySecret: "x" }), /LIVE key/);
});

t("idempotency key is deterministic and attempt-sensitive", () => {
  const k1 = RazorpayClient.idempotencyKey("pay_1", "RETRY_CHARGE", 1);
  const k2 = RazorpayClient.idempotencyKey("pay_1", "RETRY_CHARGE", 1);
  const k3 = RazorpayClient.idempotencyKey("pay_1", "RETRY_CHARGE", 2);
  assert.strictEqual(k1, k2);
  assert.notStrictEqual(k1, k3);
});

t("a write without an idempotency key is refused", async () => {
  const c = new RazorpayClient({ keyId: "rzp_test_a", keySecret: "b" });
  return c.request({ method: "POST", path: "/payment_links", body: {} })
    .then(() => { throw new Error("should have thrown"); }, (e) => assert.match(e.message, /idempotency/));
});

t("dry-run never sets live mode and marks its output simulated", async () => {
  const c = new RazorpayClient({ keyId: "rzp_test_a", keySecret: "b" });
  assert.strictEqual(c.live, false);
  return c.createPaymentLink({ amountPaise: 10000, description: "x", entityId: "pay_1", attemptNo: 1 })
    .then((r) => { assert.strictEqual(r.simulated, true); assert.strictEqual(c.calls[0].mode, "dry-run"); });
});

t("a replayed idempotency key does not issue a second call", async () => {
  const c = new RazorpayClient({ keyId: "rzp_test_a", keySecret: "b" });
  const args = { amountPaise: 10000, description: "x", entityId: "pay_9", attemptNo: 1 };
  return c.createPaymentLink(args)
    .then(() => c.createPaymentLink(args))
    .then((second) => {
      assert.strictEqual(second.replayed, true);
      assert.strictEqual(c.calls.filter((x) => x.outcome === "simulated").length, 1);
    });
});

console.log("\nschema");

t("rejects a float amount", () => {
  const r = validateRecord({ event_id: "e", ts: new Date().toISOString(), kind: "payment_failed", merchant_id: "m", entity: { type: "payment", id: "p" }, amount_paise: 199.5, currency: "INR", method: "card", customer: { id: "c", contact_hash: "ch_x", locale: "ta", dnc: false }, failure: { source: "customer", step: "payment_authorization", code: "X", reason: "insufficient_funds" }, attempt_no: 0 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("integer")));
});

t("rejects a raw phone number in place of a contact hash", () => {
  const r = validateRecord({ event_id: "e", ts: new Date().toISOString(), kind: "payment_captured", merchant_id: "m", entity: { type: "payment", id: "p" }, amount_paise: 100, currency: "INR", method: "upi", customer: { id: "c", contact_hash: "", locale: "en", dnc: false }, attempt_no: 0 });
  assert.strictEqual(r.ok, false);
});

t("rupee formatting never loses paise", () => {
  assert.strictEqual(rupees(1621408 * 100), "\u20B916,21,408.00");
  assert.strictEqual(rupees(1), "\u20B90.01");
  assert.strictEqual(rupees(-250), "-\u20B92.50");
});

console.log("\ndeterminism");

t("the same seed produces a byte-identical batch", () => {
  const a = JSON.stringify(generate({ seed: 99, records: 60 }).ledger);
  const b = JSON.stringify(generate({ seed: 99, records: 60 }).ledger);
  assert.strictEqual(a, b);
});

t("a different seed produces a different batch", () => {
  const a = JSON.stringify(generate({ seed: 99, records: 60 }).ledger);
  const b = JSON.stringify(generate({ seed: 100, records: 60 }).ledger);
  assert.notStrictEqual(a, b);
});

t("no source file calls Math.random", () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    if (e.name === "node_modules" || e.name === "data" || e.name === "test") return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  });
  walk(path.join(__dirname, ".."));
  /* Strip comments before scanning. The first version of this test
     failed on rng.js and response-model.frozen.js — both of which
     mention Math.random only in the comment explaining why it is
     banned. A test that fails on its own documentation teaches
     people to delete the documentation. */
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const offenders = files.filter((f) => /Math\.random\s*\(/.test(stripComments(fs.readFileSync(f, "utf8"))));
  assert.deepStrictEqual(offenders, [], `Math.random found in: ${offenders.join(", ")}`);
});

t("every break class appears at n=200", () => {
  const { truth } = generate({ seed: 42, records: 200 });
  const classes = Object.keys(truth.summary.break_mix_realised);
  assert.ok(classes.length >= 8, `only ${classes.length} break classes present: ${classes.join(",")}`);
});

t("the answer key marks true exceptions, not every break", () => {
  const { truth } = generate({ seed: 42, records: 200 });
  const all = Object.values(truth.payments);
  const reconciling = all.filter((p) => p.reconciles);
  /* timing_split and refund_netting DO reconcile once joined
     correctly. If every break counted as an exception, a matcher
     could score perfectly by flagging everything. */
  assert.ok(reconciling.some((p) => p.break === "timing_split"));
  assert.ok(reconciling.some((p) => p.break === "refund_netting"));
});

console.log("\nfrozen response model");

t("rejects an intervention outside the closed vocabulary", () => {
  const { ledger } = generate({ seed: 1, records: 20 });
  const rec = ledger.find((r) => r.kind === "payment_failed");
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
  assert.throws(() => resolve({ record: rec, intervention: "CHARGE_EVERYTHING", attemptNo: 1, hoursSinceFail: 10, messageLocale: "en", rates, seed: 1 }), /unknown intervention/);
});

t("a hard decline is not treated like a soft one", () => {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
  const base = { event_id: "evt_x", amount_paise: 100000, method: "card", customer: { locale: "en" } };
  const soft = resolve({ record: { ...base, failure: { reason: "insufficient_funds" } }, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 1 });
  const hard = resolve({ record: { ...base, failure: { reason: "mandate_revoked" } }, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 1 });
  assert.ok(soft.p_pay > hard.p_pay, "insufficient_funds must retry better than mandate_revoked");
  assert.strictEqual(hard.p_pay, 0, "a revoked mandate can never be recovered by retrying");
});

t("a silent retry carries no opt-out hazard; a message does", () => {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
  const rec = { event_id: "evt_y", amount_paise: 100000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "ta" } };
  const retry = resolve({ record: rec, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 2 });
  const voice = resolve({ record: rec, intervention: "VOICE_NUDGE_REGIONAL", attemptNo: 1, hoursSinceFail: 48, messageLocale: "ta", rates, seed: 2 });
  assert.strictEqual(retry.p_opt_out, 0);
  assert.ok(voice.p_opt_out > 0);
});

t("matched language outperforms english default, all else equal", () => {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
  const rec = { event_id: "evt_z", amount_paise: 100000, method: "upi", failure: { reason: "insufficient_funds" }, customer: { locale: "ta" } };
  const matched = resolve({ record: rec, intervention: "PAYMENT_LINK_WHATSAPP", attemptNo: 1, hoursSinceFail: 48, messageLocale: "ta", rates, seed: 3 });
  const english = resolve({ record: rec, intervention: "PAYMENT_LINK_WHATSAPP", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 3 });
  assert.ok(matched.p_pay > english.p_pay);
});

t("escalation costs money and claims no recovery", () => {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
  const rec = { event_id: "evt_e", amount_paise: 5000000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
  const r = resolve({ record: rec, intervention: "ESCALATE_HUMAN", attemptNo: 1, hoursSinceFail: 10, messageLocale: "en", rates, seed: 4 });
  assert.ok(r.direct_cost_paise > 0);
  assert.strictEqual(r.paid, false);
});

t("the same record + intervention resolves identically every time", () => {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
  const rec = { event_id: "evt_d", amount_paise: 100000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
  const args = { record: rec, intervention: "RETRY_CHARGE", attemptNo: 2, hoursSinceFail: 30, messageLocale: "en", rates, seed: 5 };
  assert.deepStrictEqual(resolve(args), resolve(args));
});

t("the intervention vocabulary is frozen", () => {
  assert.throws(() => { INTERVENTIONS.push("SOMETHING_NEW"); });
});

console.log("\nreconciler");

const { reconcile, score } = require("../recon");

t("a fee variance is flagged, not explained away", () => {
  const { ledger, truth } = generate({ seed: 42, records: 200 });
  const out = reconcile(ledger);
  const feeCases = Object.entries(truth.payments).filter(([, v]) => v.break === "fee_variance");
  assert.ok(feeCases.length > 0, "batch contains no fee variance to test");
  for (const [pid] of feeCases) {
    const r = out.results.find((x) => x.payment_id === pid);
    assert.strictEqual(r.reconciles, false, `${pid} was explained away instead of queued`);
    assert.strictEqual(r.severity, "low", `${pid} should be low severity, not ${r.severity}`);
  }
});

t("a split settlement is NOT flagged — it reconciles as a pair", () => {
  const { ledger, truth } = generate({ seed: 42, records: 200 });
  const out = reconcile(ledger);
  const splits = Object.entries(truth.payments).filter(([, v]) => v.break === "timing_split");
  assert.ok(splits.length > 0);
  for (const [pid] of splits) {
    const r = out.results.find((x) => x.payment_id === pid);
    assert.strictEqual(r.reconciles, true, `${pid} was falsely flagged`);
    assert.strictEqual(r.tier, "explained_split");
  }
});

t("a netted refund is NOT flagged", () => {
  const { ledger, truth } = generate({ seed: 42, records: 200 });
  const out = reconcile(ledger);
  const refunds = Object.entries(truth.payments).filter(([, v]) => v.break === "refund_netting");
  assert.ok(refunds.length > 0);
  for (const [pid] of refunds) {
    const r = out.results.find((x) => x.payment_id === pid);
    assert.strictEqual(r.reconciles, true, `${pid} was falsely flagged`);
  }
});

t("both halves of a duplicate pair are flagged, with roles", () => {
  const { ledger, truth } = generate({ seed: 42, records: 200 });
  const out = reconcile(ledger);
  const dupes = Object.entries(truth.payments).filter(([, v]) => v.break === "duplicate_payment");
  assert.ok(dupes.length > 0);
  for (const [pid, tr] of dupes) {
    const orig = out.results.find((x) => x.payment_id === pid);
    const dup = out.results.find((x) => x.payment_id === tr.duplicate_payment_id);
    assert.strictEqual(orig.tier, "flagged_duplicate");
    assert.strictEqual(dup.tier, "flagged_duplicate");
    assert.ok(orig.evidence.some((e) => e.includes("original")));
    assert.ok(dup.evidence.some((e) => e.includes("duplicate")));
  }
});

t("an orphan credit is surfaced separately, not silently dropped", () => {
  const { ledger } = generate({ seed: 42, records: 200 });
  const out = reconcile(ledger);
  assert.ok(out.orphanCredits.length > 0);
  assert.ok(out.stats.orphan_credit_value_paise > 0);
});

t("every exception carries a severity and a named next action", () => {
  const { ledger } = generate({ seed: 42, records: 200 });
  const out = reconcile(ledger);
  for (const r of out.results.filter((x) => !x.reconciles)) {
    assert.ok(["high", "low"].includes(r.severity), `${r.payment_id} has severity ${r.severity}`);
    assert.ok(typeof r.action === "string" && r.action.length, `${r.payment_id} has no action`);
    assert.ok(r.evidence.length > 0, `${r.payment_id} has no evidence`);
  }
});

t("the verdict score holds across 10 independent batches", () => {
  for (let i = 0; i < 10; i++) {
    const seed = 500 + i * 13;
    const { ledger, truth } = generate({ seed, records: 200 });
    const s = score(reconcile(ledger), truth);
    assert.strictEqual(s.confusion.fp, 0, `seed ${seed} produced ${s.confusion.fp} false positives`);
    assert.strictEqual(s.confusion.fn, 0, `seed ${seed} produced ${s.confusion.fn} false negatives`);
  }
});

t("explanation accuracy is NOT perfect — the fee/mismatch overlap is real", () => {
  let anyImperfect = false;
  for (let i = 0; i < 10; i++) {
    const { ledger, truth } = generate({ seed: 500 + i * 13, records: 200 });
    const s = score(reconcile(ledger), truth);
    if (s.explanation_accuracy < 1) anyImperfect = true;
  }
  /* If this ever starts passing at 100% across every batch, the band
     has been tuned to the answer key and the metric has stopped
     measuring anything. */
  assert.ok(anyImperfect, "explanation accuracy is perfect everywhere — suspect the threshold was fitted");
});


console.log("\nmandate pause distinction (Razorpay subscription semantics)");

t("a customer-initiated pause cannot be charged, but CAN be nudged", () => {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
  const rec = { event_id: "evt_mc", amount_paise: 100000, method: "emandate", failure: { reason: "mandate_paused_by_customer" }, customer: { locale: "en" } };
  const retry = resolve({ record: rec, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 10 });
  const nudge = resolve({ record: rec, intervention: "PAYMENT_LINK_WHATSAPP", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 10 });
  assert.strictEqual(retry.p_pay, 0, "a paused mandate cannot be charged, regardless of who paused it");
  assert.ok(nudge.p_pay > 0, "only the customer can resume their own pause, so a message to them can still work");
});

t("a business-initiated pause cannot be charged OR usefully nudged", () => {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
  const rec = { event_id: "evt_mb", amount_paise: 100000, method: "emandate", failure: { reason: "mandate_paused_by_business" }, customer: { locale: "en" } };
  const retry = resolve({ record: rec, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 10 });
  const nudge = resolve({ record: rec, intervention: "PAYMENT_LINK_WHATSAPP", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 10 });
  assert.strictEqual(retry.p_pay, 0);
  assert.strictEqual(nudge.p_pay, 0, "the block is on the business side — messaging the customer cannot fix it, so escalation is the only correct move");
});

t("the charge block is a hard rule, not a probability — it survives even if recoverability is miscalibrated to 1.0", () => {
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
  const tampered = JSON.parse(JSON.stringify(rates));
  tampered.failure_reason_recoverability.mandate_paused_by_business.value = 1.0;
  const rec = { event_id: "evt_mt", amount_paise: 100000, method: "emandate", failure: { reason: "mandate_paused_by_business" }, customer: { locale: "en" } };
  const retry = resolve({ record: rec, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates: tampered, seed: 10 });
  assert.strictEqual(retry.p_pay, 0, "a physical impossibility must not depend on a number staying correctly calibrated");
});

t("mandate reasons never attach to a card or UPI payment in generated data", () => {
  const { ledger } = generate({ seed: 77, records: 300 });
  const bad = ledger.filter((r) => r.failure && ["mandate_revoked","mandate_paused_by_customer","mandate_paused_by_business"].includes(r.failure.reason) && r.method !== "emandate");
  assert.deepStrictEqual(bad, []);
});

t("the rare mandate_paused_by_business reason is guaranteed to appear, not left to a 0.14% draw", () => {
  const { ledger, truth } = generate({ seed: 42, records: 200 });
  const present = ledger.some((r) => r.failure && r.failure.reason === "mandate_paused_by_business");
  assert.ok(present, "mandate_paused_by_business did not appear — the coverage guarantee regressed");
  /* Whether it needed forcing or showed up by chance, the batch is
     honest about which happened — this asserts the disclosure
     mechanism itself works, not just the outcome. */
  assert.ok(Array.isArray(truth.summary.mandate_reasons_forced));
});

console.log("\nwebhook classifier — real Razorpay field names");

t("pause_initiated_by: self maps to the customer-paused reason", () => {
  assert.strictEqual(classifyFailureReason({ pause_initiated_by: "self" }, "subscription_halted"), "mandate_paused_by_customer");
});

t("any other pause_initiated_by value maps to the business-paused reason", () => {
  assert.strictEqual(classifyFailureReason({ pause_initiated_by: "ops_console" }, "subscription_halted"), "mandate_paused_by_business");
});

t("an exact, known error_reason is used as-is", () => {
  assert.strictEqual(classifyFailureReason({ error_reason: "issuer_down" }, "payment_failed"), "issuer_down");
});

t("falls back to keyword matching on error_description when error_reason is absent or unknown", () => {
  assert.strictEqual(classifyFailureReason({ error_description: "insufficient balance in account" }, "payment_failed"), "insufficient_funds");
  assert.strictEqual(classifyFailureReason({ error_description: "the card has expired" }, "payment_failed"), "card_expired");
});

t("an unclassifiable payload gets a stated default, not a thrown error", () => {
  assert.strictEqual(classifyFailureReason({}, "payment_failed"), "payment_timeout");
});


console.log("\ngates — the money firewall");

const gRates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
const gRecord = (over = {}) => ({
  event_id: "evt_g", entity: { type: "payment", id: "pay_g1" },
  amount_paise: 50000, method: "upi",
  customer: { dnc: false, locale: "en" },
  failure: { reason: "insufficient_funds" },
  ...over,
});
const gFresh = () => ({ killSwitch: createKillSwitch(), attempts: createAttemptLedger(), spend: createSpendTracker() });
const IN_WINDOW = new Date("2026-08-23T09:00:00.000Z");     // 14:30 IST
const OUT_OF_WINDOW = new Date("2026-08-22T20:30:00.000Z"); // 02:00 IST

t("throws rather than silently proceeding when a required wire-up is missing", () => {
  const { attempts, spend } = gFresh();
  assert.throws(() => evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, attempts, spend, now: IN_WINDOW }), /killSwitch.*required/);
});

t("every gate produces exactly one trace entry, every time, pass or block", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const r = evaluateGates({ record: gRecord(), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.deepStrictEqual(r.trace.map((t) => t.gate), GATE_NAMES);
  assert.ok(r.trace.every((t) => t.result === "pass" || t.result === "block"));
  assert.ok(r.trace.every((t) => typeof t.detail === "string" && t.detail.length > 0));
});

t("kill switch blocks unconditionally and skips every other gate's real evaluation", () => {
  const { attempts, spend } = gFresh();
  const killSwitch = createKillSwitch();
  killSwitch.engage("test");
  const r = evaluateGates({ record: gRecord({ customer: { dnc: false, locale: "en" } }), proposedAction: "WRITE_OFF", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(r.finalAction, "NO_ACTION");
  assert.strictEqual(r.trace[0].gate, "kill_switch");
  assert.strictEqual(r.trace[0].result, "block");
  assert.ok(r.trace.slice(1).every((t) => t.result === "pass"), "downstream gates should not independently re-derive a block once killed");
});

t("an action outside the closed vocabulary is coerced to NO_ACTION, not guessed", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const r = evaluateGates({ record: gRecord(), proposedAction: "CHARGE_EVERYTHING_NOW", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(r.finalAction, "NO_ACTION");
  assert.strictEqual(r.allowed, false);
});

t("do-not-contact blocks a message but not a silent retry", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const dnc = gRecord({ customer: { dnc: true, locale: "en" } });
  const messaged = evaluateGates({ record: dnc, proposedAction: "PAYMENT_LINK_SMS", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(messaged.finalAction, "ESCALATE_HUMAN");
  const retried = evaluateGates({ record: { ...dnc, method: "card" }, proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(retried.finalAction, "RETRY_CHARGE", "a silent retry is not \"contact\" and DNC should not block it");
});

t("a business-paused mandate dead-ends on BOTH retry and nudge, independent of the frozen model", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const rec = gRecord({ method: "emandate", failure: { reason: "mandate_paused_by_business" } });
  const retry = evaluateGates({ record: rec, proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  const nudge = evaluateGates({ record: rec, proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(retry.finalAction, "ESCALATE_HUMAN");
  assert.strictEqual(nudge.finalAction, "ESCALATE_HUMAN");
});

t("a customer-paused mandate blocks retry but still allows a nudge through", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const rec = gRecord({ method: "emandate", failure: { reason: "mandate_paused_by_customer" } });
  const retry = evaluateGates({ record: rec, proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  const nudge = evaluateGates({ record: rec, proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(retry.finalAction, "ESCALATE_HUMAN");
  assert.strictEqual(nudge.finalAction, "PAYMENT_LINK_WHATSAPP", "only the customer can resume their own pause, so nudging them is still worth trying");
});

t("the mandate charge block fires even if the response-model's recoverability were miscalibrated", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const tampered = JSON.parse(JSON.stringify(gRates));
  tampered.failure_reason_recoverability.mandate_revoked.value = 1.0;
  const rec = gRecord({ method: "emandate", failure: { reason: "mandate_revoked" } });
  const r = evaluateGates({ record: rec, proposedAction: "RETRY_CHARGE", rates: tampered, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(r.finalAction, "ESCALATE_HUMAN", "the gate's own hard rule must not depend on the simulator's numbers being correct");
});

t("attempt ceiling: small amount writes off, large amount escalates instead", () => {
  const { killSwitch, spend } = gFresh();
  const maxedOut = createAttemptLedger();
  for (let i = 0; i < DEFAULT_POLICY.maxAttemptsPerEntity; i++) {
    maxedOut.recordAttempt("pay_g1", "RETRY_CHARGE", new Date(Date.now() - (DEFAULT_POLICY.maxAttemptsPerEntity - i) * 200 * 3600e3));
  }
  const small = evaluateGates({ record: gRecord({ amount_paise: 15000 }), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts: maxedOut, spend, now: IN_WINDOW });
  assert.strictEqual(small.finalAction, "WRITE_OFF");
  const large = evaluateGates({ record: gRecord({ amount_paise: 1500000 }), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts: maxedOut, spend, now: IN_WINDOW });
  assert.strictEqual(large.finalAction, "ESCALATE_HUMAN");
});

t("cooldown defers a too-soon retry instead of letting it through", () => {
  const { killSwitch, spend } = gFresh();
  const recent = createAttemptLedger();
  recent.recordAttempt("pay_g1", "RETRY_CHARGE", new Date(Date.now() - 1 * 3600e3));   // 1h ago
  const r = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts: recent, spend, now: IN_WINDOW });
  assert.strictEqual(r.finalAction, "NO_ACTION");
  const cd = r.trace.find((x) => x.gate === "cooldown");
  assert.strictEqual(cd.result, "block");
});

t("quiet hours defers a message at 2 AM IST and allows the same message at 2:30 PM IST", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const night = evaluateGates({ record: gRecord(), proposedAction: "VOICE_NUDGE_REGIONAL", rates: gRates, killSwitch, attempts, spend, now: OUT_OF_WINDOW });
  const day = evaluateGates({ record: gRecord(), proposedAction: "VOICE_NUDGE_REGIONAL", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(night.finalAction, "NO_ACTION");
  assert.strictEqual(day.finalAction, "VOICE_NUDGE_REGIONAL");
});

t("quiet hours never restricts a silent retry or an escalation", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const retryAtNight = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: OUT_OF_WINDOW });
  assert.strictEqual(retryAtNight.finalAction, "RETRY_CHARGE");
});

t("approval ceiling forces a human on amount alone, regardless of the proposed action", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const r = evaluateGates({ record: gRecord({ amount_paise: DEFAULT_POLICY.autoApprovalCeilingPaise }), proposedAction: "PAYMENT_LINK_SMS", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(r.finalAction, "ESCALATE_HUMAN");
});

t("per-run spend cap trips and reroutes further paid actions to a human", () => {
  const { killSwitch, attempts } = gFresh();
  const spend = createSpendTracker();
  spend.record(DEFAULT_POLICY.spendCapPerRunPaise - 10);   // 10 paise of headroom left
  const r = evaluateGates({ record: gRecord(), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, policy: { respectQuietHours: false }, now: IN_WINDOW });
  assert.strictEqual(r.finalAction, "ESCALATE_HUMAN");
});

t("per-day spend cap is independent of the per-run cap", () => {
  const { killSwitch, attempts } = gFresh();
  const spend = createSpendTracker();
  spend.record(DEFAULT_POLICY.spendCapPerDayPaise - 10, IN_WINDOW);
  const r = evaluateGates({ record: gRecord(), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(r.finalAction, "ESCALATE_HUMAN");
});

t("idempotency key is present for money-moving actions and absent otherwise", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const acting = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  const passive = evaluateGates({ record: gRecord(), proposedAction: "NO_ACTION", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.ok(typeof acting.idempotencyKey === "string" && acting.idempotencyKey.length > 0);
  assert.strictEqual(passive.idempotencyKey, null);
});

t("idempotency key changes with attempt count, so a retry after a real attempt is not misfiled as a duplicate", () => {
  const { killSwitch, spend } = gFresh();
  const attempts = createAttemptLedger();
  const first = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  attempts.recordAttempt("pay_g1", "RETRY_CHARGE", new Date(Date.now() - 100 * 3600e3));
  const second = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.notStrictEqual(first.idempotencyKey, second.idempotencyKey);
});

t("\"allowed\" is true only when nothing overrode the proposed action", () => {
  const { killSwitch, attempts, spend } = gFresh();
  const clean = evaluateGates({ record: gRecord(), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  const overridden = evaluateGates({ record: gRecord({ customer: { dnc: true, locale: "en" } }), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
  assert.strictEqual(clean.allowed, true);
  assert.strictEqual(overridden.allowed, false);
});

t("withinQuietHours agrees with the gate's own verdict at the boundary hours", () => {
  assert.strictEqual(withinQuietHours(new Date("2026-08-23T03:30:00.000Z")), true);   // 09:00 IST, start inclusive
  assert.strictEqual(withinQuietHours(new Date("2026-08-23T03:29:00.000Z")), false);  // 08:59 IST
  assert.strictEqual(withinQuietHours(new Date("2026-08-23T13:29:00.000Z")), true);   // 18:59 IST
  assert.strictEqual(withinQuietHours(new Date("2026-08-23T13:30:00.000Z")), false);  // 19:00 IST, end exclusive
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
