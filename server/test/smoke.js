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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
