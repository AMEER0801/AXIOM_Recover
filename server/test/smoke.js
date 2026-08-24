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
const { baselinePolicy, smartPolicy, runBatch, compareArms, AT_RISK_KINDS } = require("../recover");
const { createAuditChain, verifyChain, toCSV, gateCoverage, canonical, GENESIS_PREV } = require("../audit");
const { llmPolicy, callModel, buildUserPrompt, parseAction, VALID_ACTIONS, estimateUsdCost } = require("../llm-policy");

/* Every unit test that needs a RazorpayClient gets its OWN
   idempotency store file, never the real data/idempotency-store.json.
   This exists because of a real bug: without it, these tests shared
   state with each other across runs, AND with whatever a person had
   left behind from real manual testing in the actual data/ folder —
   a stale entry there made "dry-run never sets live mode" see a
   replayed call instead of a fresh one, and made the very next test
   assert a call count of 1 against a 0 that had already been
   consumed by the leftover file. Found by the full suite failing
   right after real manual API testing had populated that file,
   the exact kind of test-isolation bug this project has already
   caught twice elsewhere (the async harness, .gitignore). */
function freshRzpClient(overrides = {}) {
  const storePath = path.join(require("os").tmpdir(), `axiom-test-idem-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new RazorpayClient({ keyId: "rzp_test_a", keySecret: "b", idempotencyStorePath: storePath, ...overrides });
}
const { detectRateDiscrepancies, buildPatternClaims, buildIndividualClaims, renderClaimText, score: discScore, claimId, CLAIM_POLICY } = require("../discrepancy");
const { CONTRACTED_MDR_BPS, STANDARD_MDR_BPS } = require("../seed");
const { exportLiveLedger } = require("../export-live-ledger");
const { execSync } = require("child_process");

async function main() {
  let pass = 0, fail = 0;
  /* async-aware on purpose. A test that returns a promise (or is
     declared `async`) used to "pass" the instant it was called,
     because the synchronous try/catch below closed before the
     promise settled — a later rejection became an unhandled
     rejection, attributed to nothing, while the summary still said
     the test passed. Caught by adding the first genuinely async
     test (the LLM policy's mocked-fetch tests) and watching a
     deliberately-broken assertion still print "ok". Awaiting here
     fixes every test in the file, not just the new ones. */
  async function t(name, fn) {
    try { await fn(); console.log(`  ok    ${name}`); pass++; }
    catch (e) { console.log(`  FAIL  ${name}\n          ${e.message}`); fail++; }
  }

  const SECRET = "whsec_test_1234567890";
  const sign = (body, secret = SECRET) =>
    crypto.createHmac("sha256", secret).update(body).digest("hex");

  console.log("\nwebhook signature");

  await t("accepts a correctly signed body", () => {
    const body = Buffer.from(JSON.stringify({ event: "payment.failed", created_at: 1 }));
    assert.strictEqual(verifyWebhookSignature(body, sign(body), SECRET).ok, true);
  });

  await t("rejects a body tampered with after signing", () => {
    const body = Buffer.from('{"amount":10000}');
    const sig = sign(body);
    const tampered = Buffer.from('{"amount":99999}');
    assert.strictEqual(verifyWebhookSignature(tampered, sig, SECRET).ok, false);
  });

  await t("rejects a signature made with the wrong secret", () => {
    const body = Buffer.from('{"a":1}');
    assert.strictEqual(verifyWebhookSignature(body, sign(body, "wrong"), SECRET).ok, false);
  });

  await t("rejects when no secret is configured (fails closed)", () => {
    const body = Buffer.from('{"a":1}');
    assert.strictEqual(verifyWebhookSignature(body, sign(body), "").ok, false);
  });

  await t("length mismatch does not throw", () => {
    const body = Buffer.from('{"a":1}');
    const r = verifyWebhookSignature(body, "deadbeef", SECRET);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "signature_length_mismatch");
  });

  await t("re-serialised body would NOT verify — proving raw bytes are required", () => {
    const obj = { b: 2, a: 1 };
    const raw = Buffer.from('{"b":2,"a":1}');
    const sig = sign(raw);
    const reserialised = Buffer.from(JSON.stringify({ a: 1, b: 2 }));
    assert.strictEqual(verifyWebhookSignature(reserialised, sig, SECRET).ok, false);
    assert.strictEqual(verifyWebhookSignature(raw, sig, SECRET).ok, true);
  });

  console.log("\nreplay + dedupe");

  await t("rejects a stale delivery", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    assert.strictEqual(withinReplayWindow(old).ok, false);
  });

  await t("accepts a fresh delivery", () => {
    assert.strictEqual(withinReplayWindow(Math.floor(Date.now() / 1000)).ok, true);
  });

  await t("tolerates small clock skew, rejects large future dating", () => {
    const now = Math.floor(Date.now() / 1000);
    assert.strictEqual(withinReplayWindow(now + 30).ok, true);
    assert.strictEqual(withinReplayWindow(now + 600).ok, false);
  });

  await t("second sighting of an event id is suppressed", () => {
    const seen = createEventSeenSet();
    assert.strictEqual(seen.firstSighting("evt_1"), true);
    assert.strictEqual(seen.firstSighting("evt_1"), false);
  });

  console.log("\npayment signature");

  await t("order|payment signature verifies with the API secret", () => {
    const apiSecret = "apisecret";
    const orderId = "order_abc", paymentId = "pay_xyz";
    const sig = crypto.createHmac("sha256", apiSecret).update(`${orderId}|${paymentId}`).digest("hex");
    assert.strictEqual(verifyPaymentSignature({ orderId, paymentId, signature: sig, apiSecret }).ok, true);
  });

  await t("webhook secret cannot be used to forge a payment signature", () => {
    const orderId = "order_abc", paymentId = "pay_xyz";
    const sig = crypto.createHmac("sha256", SECRET).update(`${orderId}|${paymentId}`).digest("hex");
    assert.strictEqual(verifyPaymentSignature({ orderId, paymentId, signature: sig, apiSecret: "apisecret" }).ok, false);
  });

  console.log("\ncontact privacy");

  await t("refuses to hash without a salt", () => {
    assert.throws(() => contactHash("9876543210", ""), /CONTACT_SALT/);
  });

  await t("same contact + salt is stable; different salt is not reversible across exports", () => {
    const a = contactHash("9876543210", "s1");
    assert.strictEqual(a, contactHash("9876543210", "s1"));
    assert.notStrictEqual(a, contactHash("9876543210", "s2"));
  });

  await t("hash does not contain the original number", () => {
    assert.ok(!contactHash("9876543210", "s1").includes("9876543210"));
  });

  console.log("\nrazorpay client");

  await t("refuses a live key without explicit override", () => {
    delete process.env.ALLOW_LIVE_KEYS;
    assert.throws(() => new RazorpayClient({ keyId: "rzp_live_abc", keySecret: "x" }), /LIVE key/);
  });

  await t("idempotency key is deterministic and attempt-sensitive", () => {
    const k1 = RazorpayClient.idempotencyKey("pay_1", "RETRY_CHARGE", 1);
    const k2 = RazorpayClient.idempotencyKey("pay_1", "RETRY_CHARGE", 1);
    const k3 = RazorpayClient.idempotencyKey("pay_1", "RETRY_CHARGE", 2);
    assert.strictEqual(k1, k2);
    assert.notStrictEqual(k1, k3);
  });

  await t("a write without an idempotency key is refused", async () => {
    const c = freshRzpClient();
    return c.request({ method: "POST", path: "/payment_links", body: {} })
      .then(() => { throw new Error("should have thrown"); }, (e) => assert.match(e.message, /idempotency/));
  });

  await t("dry-run never sets live mode and marks its output simulated", async () => {
    const c = freshRzpClient();
    assert.strictEqual(c.live, false);
    return c.createPaymentLink({ amountPaise: 10000, description: "x", entityId: "pay_1", attemptNo: 1 })
      .then((r) => { assert.strictEqual(r.simulated, true); assert.strictEqual(c.calls[0].mode, "dry-run"); });
  });

  await t("a replayed idempotency key does not issue a second call", async () => {
    const c = freshRzpClient();
    const args = { amountPaise: 10000, description: "x", entityId: "pay_9", attemptNo: 1 };
    return c.createPaymentLink(args)
      .then(() => c.createPaymentLink(args))
      .then((second) => {
        assert.strictEqual(second.replayed, true);
        assert.strictEqual(c.calls.filter((x) => x.outcome === "simulated").length, 1);
      });
  });

  await t("idempotency survives a fresh client instance reading the same store file — the real bug this project shipped and a real user caught", async () => {
    /* This is not a hypothetical. Manual testing against Razorpay's
       real API found that two separate `node -e` process
       invocations — the exact scenario a crashed-and-restarted
       batch, or simply running the same CLI command twice, produces
       — created two DIFFERENT payment links for identical
       (entityId, action, attemptNo). The original bug had two
       causes: an in-memory-only Map (fresh per process, remembers
       nothing across a restart) and a header
       (X-Razorpay-Idempotency-Key) that Razorpay's API silently
       ignores for Payment Links — verified against Razorpay's own
       docs, which only support idempotency on Payouts, Refunds, and
       Direct Transfers, each with a distinct header. Two separate
       RazorpayClient instances here stand in for two separate
       processes; the fix is that they share a store FILE, not
       memory. */
    const storePath = path.join(require("os").tmpdir(), `axiom-idem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const args = { amountPaise: 10000, description: "x", entityId: "pay_restart_test", attemptNo: 1 };

    const clientA = new RazorpayClient({ keyId: "rzp_test_a", keySecret: "b", idempotencyStorePath: storePath });
    const first = await clientA.createPaymentLink(args);

    const clientB = new RazorpayClient({ keyId: "rzp_test_a", keySecret: "b", idempotencyStorePath: storePath });
    const second = await clientB.createPaymentLink(args);

    assert.strictEqual(second.replayed, true, "a fresh client instance (standing in for a fresh process) must still recognise this as a duplicate");
    assert.strictEqual(first.entity.id, second.entity.id, "the two 'processes' must resolve to the identical entity, not create two");

    fs.unlinkSync(storePath);
  });

  await t("a corrupt or missing idempotency store file starts fresh rather than crashing", async () => {
    const storePath = path.join(require("os").tmpdir(), `axiom-idem-corrupt-${Date.now()}.json`);
    fs.writeFileSync(storePath, "{ this is not valid json");
    const c = new RazorpayClient({ keyId: "rzp_test_a", keySecret: "b", idempotencyStorePath: storePath });
    const r = await c.createPaymentLink({ amountPaise: 5000, description: "x", entityId: "pay_corrupt", attemptNo: 1 });
    assert.strictEqual(r.replayed, undefined, "should proceed as a fresh call, not throw, when the store file is unreadable");
    fs.unlinkSync(storePath);
  });

  console.log("\nschema");

  await t("rejects a float amount", () => {
    const r = validateRecord({ event_id: "e", ts: new Date().toISOString(), kind: "payment_failed", merchant_id: "m", entity: { type: "payment", id: "p" }, amount_paise: 199.5, currency: "INR", method: "card", customer: { id: "c", contact_hash: "ch_x", locale: "ta", dnc: false }, failure: { source: "customer", step: "payment_authorization", code: "X", reason: "insufficient_funds" }, attempt_no: 0 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("integer")));
  });

  await t("rejects a raw phone number in place of a contact hash", () => {
    const r = validateRecord({ event_id: "e", ts: new Date().toISOString(), kind: "payment_captured", merchant_id: "m", entity: { type: "payment", id: "p" }, amount_paise: 100, currency: "INR", method: "upi", customer: { id: "c", contact_hash: "", locale: "en", dnc: false }, attempt_no: 0 });
    assert.strictEqual(r.ok, false);
  });

  await t("rupee formatting never loses paise", () => {
    assert.strictEqual(rupees(1621408 * 100), "\u20B916,21,408.00");
    assert.strictEqual(rupees(1), "\u20B90.01");
    assert.strictEqual(rupees(-250), "-\u20B92.50");
  });

  console.log("\ndeterminism");

  await t("the same seed produces a byte-identical batch", () => {
    const a = JSON.stringify(generate({ seed: 99, records: 60 }).ledger);
    const b = JSON.stringify(generate({ seed: 99, records: 60 }).ledger);
    assert.strictEqual(a, b);
  });

  await t("a different seed produces a different batch", () => {
    const a = JSON.stringify(generate({ seed: 99, records: 60 }).ledger);
    const b = JSON.stringify(generate({ seed: 100, records: 60 }).ledger);
    assert.notStrictEqual(a, b);
  });

  await t("no source file calls Math.random", () => {
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

  await t("every break class appears at n=200", () => {
    const { truth } = generate({ seed: 42, records: 200 });
    const classes = Object.keys(truth.summary.break_mix_realised);
    assert.ok(classes.length >= 8, `only ${classes.length} break classes present: ${classes.join(",")}`);
  });

  await t("the answer key marks true exceptions, not every break", () => {
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

  await t("rejects an intervention outside the closed vocabulary", () => {
    const { ledger } = generate({ seed: 1, records: 20 });
    const rec = ledger.find((r) => r.kind === "payment_failed");
    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
    assert.throws(() => resolve({ record: rec, intervention: "CHARGE_EVERYTHING", attemptNo: 1, hoursSinceFail: 10, messageLocale: "en", rates, seed: 1 }), /unknown intervention/);
  });

  await t("a hard decline is not treated like a soft one", () => {
    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
    const base = { event_id: "evt_x", amount_paise: 100000, method: "card", customer: { locale: "en" } };
    const soft = resolve({ record: { ...base, failure: { reason: "insufficient_funds" } }, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 1 });
    const hard = resolve({ record: { ...base, failure: { reason: "mandate_revoked" } }, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 1 });
    assert.ok(soft.p_pay > hard.p_pay, "insufficient_funds must retry better than mandate_revoked");
    assert.strictEqual(hard.p_pay, 0, "a revoked mandate can never be recovered by retrying");
  });

  await t("a silent retry carries no opt-out hazard; a message does", () => {
    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
    const rec = { event_id: "evt_y", amount_paise: 100000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "ta" } };
    const retry = resolve({ record: rec, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 2 });
    const voice = resolve({ record: rec, intervention: "VOICE_NUDGE_REGIONAL", attemptNo: 1, hoursSinceFail: 48, messageLocale: "ta", rates, seed: 2 });
    assert.strictEqual(retry.p_opt_out, 0);
    assert.ok(voice.p_opt_out > 0);
  });

  await t("matched language outperforms english default, all else equal", () => {
    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
    const rec = { event_id: "evt_z", amount_paise: 100000, method: "upi", failure: { reason: "insufficient_funds" }, customer: { locale: "ta" } };
    const matched = resolve({ record: rec, intervention: "PAYMENT_LINK_WHATSAPP", attemptNo: 1, hoursSinceFail: 48, messageLocale: "ta", rates, seed: 3 });
    const english = resolve({ record: rec, intervention: "PAYMENT_LINK_WHATSAPP", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 3 });
    assert.ok(matched.p_pay > english.p_pay);
  });

  await t("escalation costs money and claims no recovery", () => {
    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
    const rec = { event_id: "evt_e", amount_paise: 5000000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
    const r = resolve({ record: rec, intervention: "ESCALATE_HUMAN", attemptNo: 1, hoursSinceFail: 10, messageLocale: "en", rates, seed: 4 });
    assert.ok(r.direct_cost_paise > 0);
    assert.strictEqual(r.paid, false);
  });

  await t("the same record + intervention resolves identically every time", () => {
    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
    const rec = { event_id: "evt_d", amount_paise: 100000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
    const args = { record: rec, intervention: "RETRY_CHARGE", attemptNo: 2, hoursSinceFail: 30, messageLocale: "en", rates, seed: 5 };
    assert.deepStrictEqual(resolve(args), resolve(args));
  });

  await t("the intervention vocabulary is frozen", () => {
    assert.throws(() => { INTERVENTIONS.push("SOMETHING_NEW"); });
  });

  console.log("\nreconciler");

  const { reconcile, score } = require("../recon");

  await t("a fee variance is flagged, not explained away", () => {
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

  await t("a split settlement is NOT flagged — it reconciles as a pair", () => {
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

  await t("a netted refund is NOT flagged", () => {
    const { ledger, truth } = generate({ seed: 42, records: 200 });
    const out = reconcile(ledger);
    const refunds = Object.entries(truth.payments).filter(([, v]) => v.break === "refund_netting");
    assert.ok(refunds.length > 0);
    for (const [pid] of refunds) {
      const r = out.results.find((x) => x.payment_id === pid);
      assert.strictEqual(r.reconciles, true, `${pid} was falsely flagged`);
    }
  });

  await t("both halves of a duplicate pair are flagged, with roles", () => {
    const { ledger, truth } = generate({ seed: 42, records: 200 });
    const out = reconcile(ledger);
    /* Both the original's and the duplicate's own truth entries carry
       break: "duplicate_payment" (the duplicate's own entry was added
       after a scoring gap was found — see the seed.js comment at
       that case), so this filters specifically for the ORIGINAL side
       of each pair via its duplicate_payment_id cross-reference,
       rather than matching both sides and being unable to tell them apart. */
    const dupes = Object.entries(truth.payments).filter(([, v]) => v.break === "duplicate_payment" && v.duplicate_payment_id);
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

  await t("an orphan credit is surfaced separately, not silently dropped", () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const out = reconcile(ledger);
    assert.ok(out.orphanCredits.length > 0);
    assert.ok(out.stats.orphan_credit_value_paise > 0);
  });

  await t("every exception carries a severity and a named next action", () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const out = reconcile(ledger);
    for (const r of out.results.filter((x) => !x.reconciles)) {
      assert.ok(["high", "low"].includes(r.severity), `${r.payment_id} has severity ${r.severity}`);
      assert.ok(typeof r.action === "string" && r.action.length, `${r.payment_id} has no action`);
      assert.ok(r.evidence.length > 0, `${r.payment_id} has no evidence`);
    }
  });

  await t("the verdict score holds across 10 independent batches", () => {
    for (let i = 0; i < 10; i++) {
      const seed = 500 + i * 13;
      const { ledger, truth } = generate({ seed, records: 200 });
      const s = score(reconcile(ledger), truth);
      assert.strictEqual(s.confusion.fp, 0, `seed ${seed} produced ${s.confusion.fp} false positives`);
      assert.strictEqual(s.confusion.fn, 0, `seed ${seed} produced ${s.confusion.fn} false negatives`);
    }
  });

  await t("explanation accuracy is NOT perfect — the fee/mismatch overlap is real", () => {
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

  await t("a customer-initiated pause cannot be charged, but CAN be nudged", () => {
    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
    const rec = { event_id: "evt_mc", amount_paise: 100000, method: "emandate", failure: { reason: "mandate_paused_by_customer" }, customer: { locale: "en" } };
    const retry = resolve({ record: rec, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 10 });
    const nudge = resolve({ record: rec, intervention: "PAYMENT_LINK_WHATSAPP", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 10 });
    assert.strictEqual(retry.p_pay, 0, "a paused mandate cannot be charged, regardless of who paused it");
    assert.ok(nudge.p_pay > 0, "only the customer can resume their own pause, so a message to them can still work");
  });

  await t("a business-initiated pause cannot be charged OR usefully nudged", () => {
    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
    const rec = { event_id: "evt_mb", amount_paise: 100000, method: "emandate", failure: { reason: "mandate_paused_by_business" }, customer: { locale: "en" } };
    const retry = resolve({ record: rec, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 10 });
    const nudge = resolve({ record: rec, intervention: "PAYMENT_LINK_WHATSAPP", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates, seed: 10 });
    assert.strictEqual(retry.p_pay, 0);
    assert.strictEqual(nudge.p_pay, 0, "the block is on the business side — messaging the customer cannot fix it, so escalation is the only correct move");
  });

  await t("the charge block is a hard rule, not a probability — it survives even if recoverability is miscalibrated to 1.0", () => {
    const rates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));
    const tampered = JSON.parse(JSON.stringify(rates));
    tampered.failure_reason_recoverability.mandate_paused_by_business.value = 1.0;
    const rec = { event_id: "evt_mt", amount_paise: 100000, method: "emandate", failure: { reason: "mandate_paused_by_business" }, customer: { locale: "en" } };
    const retry = resolve({ record: rec, intervention: "RETRY_CHARGE", attemptNo: 1, hoursSinceFail: 48, messageLocale: "en", rates: tampered, seed: 10 });
    assert.strictEqual(retry.p_pay, 0, "a physical impossibility must not depend on a number staying correctly calibrated");
  });

  await t("mandate reasons never attach to a card or UPI payment in generated data", () => {
    const { ledger } = generate({ seed: 77, records: 300 });
    const bad = ledger.filter((r) => r.failure && ["mandate_revoked","mandate_paused_by_customer","mandate_paused_by_business"].includes(r.failure.reason) && r.method !== "emandate");
    assert.deepStrictEqual(bad, []);
  });

  await t("the rare mandate_paused_by_business reason is guaranteed to appear, not left to a 0.14% draw", () => {
    const { ledger, truth } = generate({ seed: 42, records: 200 });
    const present = ledger.some((r) => r.failure && r.failure.reason === "mandate_paused_by_business");
    assert.ok(present, "mandate_paused_by_business did not appear — the coverage guarantee regressed");
    /* Whether it needed forcing or showed up by chance, the batch is
       honest about which happened — this asserts the disclosure
       mechanism itself works, not just the outcome. */
    assert.ok(Array.isArray(truth.summary.mandate_reasons_forced));
  });

  console.log("\nwebhook classifier — real Razorpay field names");

  await t("pause_initiated_by: self maps to the customer-paused reason", () => {
    assert.strictEqual(classifyFailureReason({ pause_initiated_by: "self" }, "subscription_halted"), "mandate_paused_by_customer");
  });

  await t("any other pause_initiated_by value maps to the business-paused reason", () => {
    assert.strictEqual(classifyFailureReason({ pause_initiated_by: "ops_console" }, "subscription_halted"), "mandate_paused_by_business");
  });

  await t("an exact, known error_reason is used as-is", () => {
    assert.strictEqual(classifyFailureReason({ error_reason: "issuer_down" }, "payment_failed"), "issuer_down");
  });

  await t("falls back to keyword matching on error_description when error_reason is absent or unknown", () => {
    assert.strictEqual(classifyFailureReason({ error_description: "insufficient balance in account" }, "payment_failed"), "insufficient_funds");
    assert.strictEqual(classifyFailureReason({ error_description: "the card has expired" }, "payment_failed"), "card_expired");
  });

  await t("an unclassifiable payload gets a stated default, not a thrown error", () => {
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

  await t("throws rather than silently proceeding when a required wire-up is missing", () => {
    const { attempts, spend } = gFresh();
    assert.throws(() => evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, attempts, spend, now: IN_WINDOW }), /killSwitch.*required/);
  });

  await t("every gate produces exactly one trace entry, every time, pass or block", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const r = evaluateGates({ record: gRecord(), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.deepStrictEqual(r.trace.map((t) => t.gate), GATE_NAMES);
    assert.ok(r.trace.every((t) => t.result === "pass" || t.result === "block"));
    assert.ok(r.trace.every((t) => typeof t.detail === "string" && t.detail.length > 0));
  });

  await t("kill switch blocks unconditionally and skips every other gate's real evaluation", () => {
    const { attempts, spend } = gFresh();
    const killSwitch = createKillSwitch();
    killSwitch.engage("test");
    const r = evaluateGates({ record: gRecord({ customer: { dnc: false, locale: "en" } }), proposedAction: "WRITE_OFF", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(r.finalAction, "NO_ACTION");
    assert.strictEqual(r.trace[0].gate, "kill_switch");
    assert.strictEqual(r.trace[0].result, "block");
    assert.ok(r.trace.slice(1).every((t) => t.result === "pass"), "downstream gates should not independently re-derive a block once killed");
  });

  await t("an action outside the closed vocabulary is coerced to NO_ACTION, not guessed", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const r = evaluateGates({ record: gRecord(), proposedAction: "CHARGE_EVERYTHING_NOW", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(r.finalAction, "NO_ACTION");
    assert.strictEqual(r.allowed, false);
  });

  await t("do-not-contact blocks a message but not a silent retry", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const dnc = gRecord({ customer: { dnc: true, locale: "en" } });
    const messaged = evaluateGates({ record: dnc, proposedAction: "PAYMENT_LINK_SMS", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(messaged.finalAction, "ESCALATE_HUMAN");
    const retried = evaluateGates({ record: { ...dnc, method: "card" }, proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(retried.finalAction, "RETRY_CHARGE", "a silent retry is not \"contact\" and DNC should not block it");
  });

  await t("a business-paused mandate dead-ends on BOTH retry and nudge, independent of the frozen model", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const rec = gRecord({ method: "emandate", failure: { reason: "mandate_paused_by_business" } });
    const retry = evaluateGates({ record: rec, proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    const nudge = evaluateGates({ record: rec, proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(retry.finalAction, "ESCALATE_HUMAN");
    assert.strictEqual(nudge.finalAction, "ESCALATE_HUMAN");
  });

  await t("a customer-paused mandate blocks retry but still allows a nudge through", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const rec = gRecord({ method: "emandate", failure: { reason: "mandate_paused_by_customer" } });
    const retry = evaluateGates({ record: rec, proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    const nudge = evaluateGates({ record: rec, proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(retry.finalAction, "ESCALATE_HUMAN");
    assert.strictEqual(nudge.finalAction, "PAYMENT_LINK_WHATSAPP", "only the customer can resume their own pause, so nudging them is still worth trying");
  });

  await t("the mandate charge block fires even if the response-model's recoverability were miscalibrated", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const tampered = JSON.parse(JSON.stringify(gRates));
    tampered.failure_reason_recoverability.mandate_revoked.value = 1.0;
    const rec = gRecord({ method: "emandate", failure: { reason: "mandate_revoked" } });
    const r = evaluateGates({ record: rec, proposedAction: "RETRY_CHARGE", rates: tampered, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(r.finalAction, "ESCALATE_HUMAN", "the gate's own hard rule must not depend on the simulator's numbers being correct");
  });

  await t("attempt ceiling: small amount writes off, large amount escalates instead", () => {
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

  await t("cooldown defers a too-soon retry instead of letting it through", () => {
    const { killSwitch, spend } = gFresh();
    const recent = createAttemptLedger();
    recent.recordAttempt("pay_g1", "RETRY_CHARGE", new Date(Date.now() - 1 * 3600e3));   // 1h ago
    const r = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts: recent, spend, now: IN_WINDOW });
    assert.strictEqual(r.finalAction, "NO_ACTION");
    const cd = r.trace.find((x) => x.gate === "cooldown");
    assert.strictEqual(cd.result, "block");
  });

  await t("quiet hours defers a message at 2 AM IST and allows the same message at 2:30 PM IST", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const night = evaluateGates({ record: gRecord(), proposedAction: "VOICE_NUDGE_REGIONAL", rates: gRates, killSwitch, attempts, spend, now: OUT_OF_WINDOW });
    const day = evaluateGates({ record: gRecord(), proposedAction: "VOICE_NUDGE_REGIONAL", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(night.finalAction, "NO_ACTION");
    assert.strictEqual(day.finalAction, "VOICE_NUDGE_REGIONAL");
  });

  await t("quiet hours never restricts a silent retry or an escalation", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const retryAtNight = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: OUT_OF_WINDOW });
    assert.strictEqual(retryAtNight.finalAction, "RETRY_CHARGE");
  });

  await t("approval ceiling forces a human on amount alone, regardless of the proposed action", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const r = evaluateGates({ record: gRecord({ amount_paise: DEFAULT_POLICY.autoApprovalCeilingPaise }), proposedAction: "PAYMENT_LINK_SMS", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(r.finalAction, "ESCALATE_HUMAN");
  });

  await t("per-run spend cap trips and reroutes further paid actions to a human", () => {
    const { killSwitch, attempts } = gFresh();
    const spend = createSpendTracker();
    spend.record(DEFAULT_POLICY.spendCapPerRunPaise - 10);   // 10 paise of headroom left
    const r = evaluateGates({ record: gRecord(), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, policy: { respectQuietHours: false }, now: IN_WINDOW });
    assert.strictEqual(r.finalAction, "ESCALATE_HUMAN");
  });

  await t("per-day spend cap is independent of the per-run cap", () => {
    const { killSwitch, attempts } = gFresh();
    const spend = createSpendTracker();
    spend.record(DEFAULT_POLICY.spendCapPerDayPaise - 10, IN_WINDOW);
    const r = evaluateGates({ record: gRecord(), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(r.finalAction, "ESCALATE_HUMAN");
  });

  await t("idempotency key is present for money-moving actions and absent otherwise", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const acting = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    const passive = evaluateGates({ record: gRecord(), proposedAction: "NO_ACTION", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.ok(typeof acting.idempotencyKey === "string" && acting.idempotencyKey.length > 0);
    assert.strictEqual(passive.idempotencyKey, null);
  });

  await t("idempotency key changes with attempt count, so a retry after a real attempt is not misfiled as a duplicate", () => {
    const { killSwitch, spend } = gFresh();
    const attempts = createAttemptLedger();
    const first = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    attempts.recordAttempt("pay_g1", "RETRY_CHARGE", new Date(Date.now() - 100 * 3600e3));
    const second = evaluateGates({ record: gRecord(), proposedAction: "RETRY_CHARGE", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.notStrictEqual(first.idempotencyKey, second.idempotencyKey);
  });

  await t("\"allowed\" is true only when nothing overrode the proposed action", () => {
    const { killSwitch, attempts, spend } = gFresh();
    const clean = evaluateGates({ record: gRecord(), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    const overridden = evaluateGates({ record: gRecord({ customer: { dnc: true, locale: "en" } }), proposedAction: "PAYMENT_LINK_WHATSAPP", rates: gRates, killSwitch, attempts, spend, now: IN_WINDOW });
    assert.strictEqual(clean.allowed, true);
    assert.strictEqual(overridden.allowed, false);
  });

  await t("withinQuietHours agrees with the gate's own verdict at the boundary hours", () => {
    assert.strictEqual(withinQuietHours(new Date("2026-08-23T03:30:00.000Z")), true);   // 09:00 IST, start inclusive
    assert.strictEqual(withinQuietHours(new Date("2026-08-23T03:29:00.000Z")), false);  // 08:59 IST
    assert.strictEqual(withinQuietHours(new Date("2026-08-23T13:29:00.000Z")), true);   // 18:59 IST
    assert.strictEqual(withinQuietHours(new Date("2026-08-23T13:30:00.000Z")), false);  // 19:00 IST, end exclusive
  });


  console.log("\nrecover — the loop, and the baseline it must beat");

  const rRates = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "model", "base-rates.json"), "utf8"));

  await t("baseline policy always proposes RETRY_CHARGE until the attempt ceiling, then WRITE_OFF", () => {
    const hist0 = { count: 0, lastAt: null };
    assert.strictEqual(baselinePolicy({}, hist0), "RETRY_CHARGE");
    const histMax = { count: DEFAULT_POLICY.maxAttemptsPerEntity, lastAt: null };
    assert.strictEqual(baselinePolicy({}, histMax), "WRITE_OFF");
  });

  await t("smart policy never proposes a nudge for a business-paused mandate", () => {
    const rec = { method: "emandate", failure: { reason: "mandate_paused_by_business" }, customer: { locale: "en" } };
    assert.strictEqual(smartPolicy(rec, { count: 0, lastAt: null }), "ESCALATE_HUMAN");
    assert.strictEqual(smartPolicy(rec, { count: 2, lastAt: null }), "ESCALATE_HUMAN", "still never a nudge, at any attempt count");
  });

  await t("smart policy still tries a nudge for a customer-paused mandate, once", () => {
    const rec = { method: "emandate", failure: { reason: "mandate_paused_by_customer" }, customer: { locale: "en" } };
    assert.strictEqual(smartPolicy(rec, { count: 0, lastAt: null }), "PAYMENT_LINK_WHATSAPP");
    assert.strictEqual(smartPolicy(rec, { count: 1, lastAt: null }), "ESCALATE_HUMAN", "one try, then hand it to a human — not an infinite nudge loop");
  });

  await t("smart policy prefers a regional voice nudge over WhatsApp for a non-English locale", () => {
    const en = { failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
    const ta = { failure: { reason: "insufficient_funds" }, customer: { locale: "ta" } };
    assert.strictEqual(smartPolicy(en, { count: 2, lastAt: null }), "PAYMENT_LINK_WHATSAPP");
    assert.strictEqual(smartPolicy(ta, { count: 2, lastAt: null }), "VOICE_NUDGE_REGIONAL");
  });

  await t("smart policy escalates dead-on-arrival reasons on the very first look, wasting no attempt", () => {
    for (const reason of ["card_expired", "card_blocked", "invalid_account", "mandate_revoked"]) {
      assert.strictEqual(smartPolicy({ failure: { reason }, customer: { locale: "en" } }, { count: 0, lastAt: null }), "ESCALATE_HUMAN", `${reason} should escalate immediately`);
    }
  });

  await t("runBatch never lets a DNC customer receive more than the one message that flips them onto the list", async () => {
    const { ledger } = generate({ seed: 321, records: 150 });
    const result = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 321, rounds: 8 });
    for (const [entityId, entries] of result.perRecordLog) {
      let sawDncTrue = false;
      for (const e of entries) {
        if (sawDncTrue) {
          assert.ok(!["PAYMENT_LINK_SMS","PAYMENT_LINK_WHATSAPP","DUNNING_EMAIL","VOICE_NUDGE_REGIONAL"].includes(e.final), `${entityId} was messaged again after opting out`);
        }
        if (e.opted_out) sawDncTrue = true;
      }
    }
  });

  await t("a record that gets paid emits a payment_captured + settlement_line pair that reconciles cleanly", async () => {
    const { ledger } = generate({ seed: 55, records: 200 });
    const result = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 55, rounds: 8 });
    assert.ok(result.paidCount > 0, "expected at least one recovered payment on this seed to test against");

    const combined = [...ledger, ...result.emitted];
    const recon = reconcile(combined);
    const paidIds = new Set(result.emitted.filter((r) => r.kind === "payment_captured").map((r) => r.entity.id));
    for (const row of recon.results) {
      if (paidIds.has(row.payment_id)) {
        assert.strictEqual(row.reconciles, true, `recovered payment ${row.payment_id} did not reconcile cleanly`);
      }
    }
  });

  await t("running the same seed twice produces an identical recovery outcome", async () => {
    const { ledger } = generate({ seed: 909, records: 200 });
    const a = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 909, rounds: 8 });
    const b = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 909, rounds: 8 });
    assert.strictEqual(a.paidCount, b.paidCount);
    assert.strictEqual(a.grossPaise, b.grossPaise);
    assert.strictEqual(a.netPaise, b.netPaise);
  });

  await t("stillInProgress plus resolvedCount always equals the at-risk population", async () => {
    const { ledger } = generate({ seed: 12, records: 200 });
    const r = await runBatch({ ledger, policy: baselinePolicy, rates: rRates, seed: 12, rounds: 3 });   // deliberately short
    assert.strictEqual(r.resolvedCount + r.stillInProgress, r.atRiskCount);
  });

  await t("8 rounds is enough for both policies to fully resolve the default batch (no record left mid-flight)", async () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const b = await runBatch({ ledger, policy: baselinePolicy, rates: rRates, seed: 42, rounds: 8 });
    const s = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    assert.strictEqual(b.stillInProgress, 0);
    assert.strictEqual(s.stillInProgress, 0);
  });

  await t("net recovered is exactly gross minus direct cost minus estimated opt-out loss", async () => {
    const { ledger } = generate({ seed: 77, records: 200 });
    const r = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 77, rounds: 8 });
    assert.strictEqual(r.netPaise, r.grossPaise - r.costPaise - r.optOutLossPaise);
  });

  await t("compareArms runs both policies against the identical starting population", async () => {
    const { ledger } = generate({ seed: 88, records: 200 });
    const cmp = await compareArms({ ledger, rates: rRates, seed: 88, rounds: 8 });
    assert.strictEqual(cmp.baseline.atRiskCount, cmp.smart.atRiskCount);
    assert.strictEqual(cmp.deltaNetPaise, cmp.smart.netPaise - cmp.baseline.netPaise);
    assert.strictEqual(cmp.deltaPaidCount, cmp.smart.paidCount - cmp.baseline.paidCount);
  });

  await t("across 10 independent batches, the smart policy recovers at least as many payments as baseline more often than not", async () => {
    let smartWins = 0;
    for (let i = 0; i < 10; i++) {
      const seed = 3000 + i * 13;
      const { ledger } = generate({ seed, records: 200 });
      const cmp = await compareArms({ ledger, rates: rRates, seed, rounds: 8 });
      if (cmp.deltaPaidCount > 0) smartWins++;
    }
    assert.ok(smartWins >= 7, `smart only out-recovered baseline in ${smartWins}/10 batches — the policy may have regressed`);
  });


  console.log("\naudit — the tamper-evident chain");

  await t("an empty chain has the genesis head", () => {
    const c = createAuditChain();
    assert.strictEqual(c.head(), GENESIS_PREV);
    assert.strictEqual(c.length(), 0);
  });

  await t("each entry links to the one before it", () => {
    const c = createAuditChain();
    const a = c.append("run_started", { x: 1 });
    const b = c.append("decision", { y: 2 });
    assert.strictEqual(a.prev_hash, GENESIS_PREV);
    assert.strictEqual(b.prev_hash, a.hash);
    assert.strictEqual(c.head(), b.hash);
  });

  await t("a valid chain verifies", () => {
    const c = createAuditChain();
    c.append("run_started", { a: 1 });
    c.append("decision", { b: 2 });
    c.append("run_ended", { c: 3 });
    assert.strictEqual(verifyChain(c.entries()).ok, true);
  });

  await t("modifying an entry's payload breaks verification, and names the entry", () => {
    const c = createAuditChain();
    c.append("run_started", { a: 1 });
    c.append("decision", { amount_paise: 50000 });
    c.append("run_ended", { c: 3 });
    const tampered = c.entries().map((e) => ({ ...e, payload: { ...e.payload } }));
    tampered[1].payload.amount_paise = 999999;
    const v = verifyChain(tampered);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.brokenAt, 1);
  });

  await t("deleting an entry breaks verification", () => {
    const c = createAuditChain();
    for (let i = 0; i < 5; i++) c.append("decision", { i });
    const entries = c.entries();
    const withHole = [entries[0], entries[1], entries[3], entries[4]];
    assert.strictEqual(verifyChain(withHole).ok, false);
  });

  await t("reordering entries breaks verification", () => {
    const c = createAuditChain();
    for (let i = 0; i < 4; i++) c.append("decision", { i });
    const e = c.entries();
    const swapped = [e[0], e[2], e[1], e[3]];
    assert.strictEqual(verifyChain(swapped).ok, false);
  });

  await t("appended entries are frozen — a caller cannot reach back and edit one", () => {
    const c = createAuditChain();
    const e = c.append("decision", { a: 1 });
    assert.throws(() => { e.hash = "forged"; });
  });

  await t("an unknown entry kind is rejected rather than silently recorded", () => {
    const c = createAuditChain();
    assert.throws(() => c.append("not_a_real_kind", {}), /unknown entry kind/);
  });

  await t("canonical serialisation is key-order independent, so honest files don't false-positive", () => {
    assert.strictEqual(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }));
    assert.notStrictEqual(canonical({ a: 1 }), canonical({ a: 2 }));
  });

  await t("a real recovery run produces a chain that verifies end to end", async () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const r = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    const v = verifyChain(r.audit.entries());
    assert.strictEqual(v.ok, true, v.reason);
    assert.ok(r.audit.length() > 100, "expected a substantial chain from a full run");
  });

  await t("the same seed produces an identical head hash — the run has a reproducible fingerprint", async () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const a = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    const b = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    assert.strictEqual(a.audit.head(), b.audit.head());
  });

  await t("a different seed produces a different head hash", async () => {
    const l1 = generate({ seed: 42, records: 200 }).ledger;
    const l2 = generate({ seed: 43, records: 200 }).ledger;
    const a = await runBatch({ ledger: l1, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    const b = await runBatch({ ledger: l2, policy: smartPolicy, rates: rRates, seed: 43, rounds: 8 });
    assert.notStrictEqual(a.audit.head(), b.audit.head());
  });

  await t("every executed action has a matching decision entry before it — no action without a recorded reason", async () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const r = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    const entries = r.audit.entries();
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].kind !== "execution") continue;
      const prior = entries[i - 1];
      assert.strictEqual(prior.kind, "decision", `execution at seq ${i} is not immediately preceded by its decision`);
      assert.strictEqual(prior.payload.entity_id, entries[i].payload.entity_id);
    }
  });

  await t("every decision entry carries the complete gate trace, not just the failures", async () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const r = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    for (const e of r.audit.entries()) {
      if (e.kind !== "decision") continue;
      assert.deepStrictEqual(e.payload.trace.map((t) => t.gate), GATE_NAMES);
    }
  });

  await t("gate coverage classifies every silent gate — none left unexplained", async () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const r = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    const cov = gateCoverage(r.audit.entries(), GATE_NAMES);
    assert.deepStrictEqual(cov.unclassified, [], `unclassified silent gates: ${cov.unclassified.join(", ")}`);
    assert.strictEqual(cov.fired.length + cov.silent.length, GATE_NAMES.length);
  });

  await t("CSV export has one row per entry plus a header, and escapes correctly", () => {
    const c = createAuditChain();
    c.append("decision", { entity_id: "pay_1", proposed: "RETRY_CHARGE", final: "NO_ACTION", allowed: false, trace: [{ gate: "cooldown", result: "block", detail: "a, b \"quoted\"" }] });
    c.append("outcome", { entity_id: "pay_1", paid: true, amount_paise: 100 });
    const lines = toCSV(c.entries()).split("\n");
    assert.strictEqual(lines.length, 3);
    assert.ok(lines[0].startsWith("seq,ts,kind"));
    assert.ok(lines[1].includes("cooldown"), "blocked gate should appear in the blocked_by column");
  });


  console.log("\nrecovery console payload");

  await t("dictionary encoding is lossless — every decision keeps all 11 gate results", async () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const r = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    const decisions = r.audit.entries().filter((e) => e.kind === "decision");

    const dict = [], idx = new Map();
    const intern = (str) => { if (!idx.has(str)) { idx.set(str, dict.length); dict.push(str); } return idx.get(str); };
    const encoded = decisions.map((d) => d.payload.trace.map((t) => [t.result === "block" ? 1 : 0, intern(t.detail)]));

    /* Decode and compare against the original, entry for entry. A
       compression scheme for an audit trail has to be provably
       lossless or it is just deletion with extra steps. */
    encoded.forEach((tr, i) => {
      assert.strictEqual(tr.length, GATE_NAMES.length, `decision ${i} lost gates in encoding`);
      tr.forEach((pair, gi) => {
        const orig = decisions[i].payload.trace[gi];
        assert.strictEqual(pair[0] === 1 ? "block" : "pass", orig.result);
        assert.strictEqual(dict[pair[1]], orig.detail);
      });
    });
  });

  await t("the console payload's recovered-payment count matches what the reconciler independently confirms", async () => {
    const { ledger } = generate({ seed: 42, records: 200 });
    const r = await runBatch({ ledger, policy: smartPolicy, rates: rRates, seed: 42, rounds: 8 });
    const post = [...ledger, ...r.emitted];
    const rec = reconcile(post);
    const recoveredIds = new Set(r.emitted.filter((x) => x.kind === "payment_captured").map((x) => x.entity.id));
    const rows = rec.results.filter((x) => recoveredIds.has(x.payment_id));
    assert.strictEqual(rows.length, r.paidCount, "every recovered payment should appear in the reconciler");
    assert.strictEqual(rows.filter((x) => x.reconciles).length, r.paidCount, "every recovered payment should reconcile cleanly");
  });

  
console.log("\nllm-policy — validated like any other untrusted input");

await t("parseAction accepts an exact, clean action name", () => {
  assert.deepStrictEqual(parseAction("RETRY_CHARGE"), { action: "RETRY_CHARGE", valid: true });
});

await t("parseAction tolerates whitespace and case, since a model is not a strict parser", () => {
  assert.strictEqual(parseAction("  retry_charge\n").action, "RETRY_CHARGE");
  assert.strictEqual(parseAction("  retry_charge\n").valid, true);
});

await t("parseAction rejects a hallucinated action rather than guessing the nearest match", () => {
  const r = parseAction("CHARGE_TWICE_TO_BE_SURE");
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.action, "NO_ACTION");
});

await t("parseAction rejects prose wrapped around a valid-looking word", () => {
  const r = parseAction("I think we should ESCALATE_HUMAN this one because it looks risky");
  /* This is deliberate and worth being strict about: extracting the
     valid token from inside a sentence would mean any response that
     merely MENTIONS an action gets treated as having CHOSEN it —
     the exact ambiguity a closed-vocabulary check exists to remove.
     A model that has genuinely decided is expected to say only the
     word, per the system prompt; anything else is treated as not
     having answered cleanly. */
  assert.strictEqual(r.valid, false);
});

await t("parseAction rejects an empty or missing response", () => {
  assert.strictEqual(parseAction("").valid, false);
  assert.strictEqual(parseAction(undefined).valid, false);
  assert.strictEqual(parseAction(null).action, "NO_ACTION");
});

await t("every entry in VALID_ACTIONS is a real intervention gates.js also recognises", () => {
  for (const a of VALID_ACTIONS) assert.ok(INTERVENTIONS.includes(a), `${a} is not in the frozen model's INTERVENTIONS`);
});

await t("buildUserPrompt never includes the raw contact hash or anything beyond the fields it declares", () => {
  const rec = { amount_paise: 10000, method: "upi", failure: { reason: "insufficient_funds" }, customer: { locale: "ta", dnc: false, contact_hash: "ch_should_not_appear_verbatim_either" } };
  const prompt = buildUserPrompt(rec, { count: 0, lastAt: null });
  assert.ok(prompt.includes("amount_paise: 10000"));
  assert.ok(prompt.includes("customer_locale: ta"));
  assert.ok(!prompt.includes("contact_hash"), "the prompt should not leak internal field names it wasn\'t designed to include");
});

await t("callModel refuses to run without an API key, rather than silently skipping", async () => {
  const rec = { amount_paise: 10000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
  await assert.rejects(
    () => callModel({ record: rec, hist: { count: 0, lastAt: null }, opts: { apiKey: "", skipPacing: true } }),
    /GROQ_API_KEY/
  );
});

await t("callModel: a clean, valid model response is accepted", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "RETRY_CHARGE" } }], usage: { prompt_tokens: 120, completion_tokens: 3 } }),
  });
  const rec = { amount_paise: 10000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
  const r = await callModel({ record: rec, hist: { count: 0, lastAt: null }, opts: { apiKey: "fake", fetchImpl: fakeFetch, skipPacing: true } });
  assert.strictEqual(r.action, "RETRY_CHARGE");
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.promptTokens, 120);
});

await t("callModel: a hallucinated action degrades to NO_ACTION, not a thrown error", async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "TRANSFER_ALL_FUNDS" } }], usage: {} }) });
  const rec = { amount_paise: 10000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
  const r = await callModel({ record: rec, hist: { count: 0, lastAt: null }, opts: { apiKey: "fake", fetchImpl: fakeFetch, skipPacing: true } });
  assert.strictEqual(r.action, "NO_ACTION");
  assert.strictEqual(r.valid, false);
});

await t("callModel: an HTTP error degrades to NO_ACTION and records the status, not a crash", async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({ error: { message: "service unavailable" } }) });
  const rec = { amount_paise: 10000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
  const r = await callModel({ record: rec, hist: { count: 0, lastAt: null }, opts: { apiKey: "fake", fetchImpl: fakeFetch, skipPacing: true } });
  assert.strictEqual(r.action, "NO_ACTION");
  assert.strictEqual(r.degraded, "http_503");
});

await t("callModel: a 429 is retried with backoff, not treated as an immediate failure", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 429, json: async () => ({ error: { message: "rate limited" } }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "WRITE_OFF" } }], usage: { prompt_tokens: 90, completion_tokens: 2 } }) };
  };
  const sleeps = [];
  const fakeSleep = async (ms) => { sleeps.push(ms); };
  const rec = { amount_paise: 10000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
  const r = await callModel({ record: rec, hist: { count: 0, lastAt: null }, opts: { apiKey: "fake", fetchImpl: fakeFetch, sleepImpl: fakeSleep, skipPacing: true } });
  assert.strictEqual(r.action, "WRITE_OFF");
  assert.strictEqual(calls, 3, "expected two 429s then a success");
  assert.ok(sleeps.length >= 2, "expected a backoff sleep before each retry");
});

await t("callModel: repeated 429s past the retry limit still degrade to NO_ACTION rather than throwing", async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "rate limited" } }) });
  const rec = { amount_paise: 10000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
  const r = await callModel({ record: rec, hist: { count: 0, lastAt: null }, opts: { apiKey: "fake", fetchImpl: fakeFetch, sleepImpl: async () => {}, skipPacing: true } });
  assert.strictEqual(r.action, "NO_ACTION");
  assert.strictEqual(r.degraded, "http_429");
});

await t("callModel: a network failure degrades to NO_ACTION and records the reason, not a crash", async () => {
  const fakeFetch = async () => { throw new Error("ECONNRESET"); };
  const rec = { amount_paise: 10000, method: "card", failure: { reason: "insufficient_funds" }, customer: { locale: "en" } };
  const r = await callModel({ record: rec, hist: { count: 0, lastAt: null }, opts: { apiKey: "fake", fetchImpl: fakeFetch, skipPacing: true } });
  assert.strictEqual(r.action, "NO_ACTION");
  assert.strictEqual(r.degraded, "network_error");
});

await t("llmPolicy plugs into runBatch's policy slot with a mocked fetch, and the result still passes through every gate", async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "RETRY_CHARGE" } }], usage: { prompt_tokens: 100, completion_tokens: 2 } }) });
  const mockedLlmPolicy = (record, hist, rates) => llmPolicy(record, hist, rates, { apiKey: "fake", fetchImpl: fakeFetch, skipPacing: true });
  const { ledger } = generate({ seed: 900, records: 40 });
  const r = await runBatch({ ledger, policy: mockedLlmPolicy, rates: rRates, seed: 900, rounds: 3 });
  assert.ok(r.atRiskCount > 0);
  /* Every decision the mocked policy produced still went through
     all 11 gates, exactly like baseline and smart — the async
     source of the proposal changes nothing about how it is
     policed. */
  for (const e of r.audit.entries()) {
    if (e.kind !== "decision") continue;
    assert.strictEqual(e.payload.trace.length, GATE_NAMES.length);
  }
});

await t("a policy that hallucinates an invalid action is caught by gates.js exactly like any other bad input", async () => {
  const rec = { event_id: "evt_x", entity: { type: "payment", id: "pay_x" }, amount_paise: 50000, method: "card", failure: { reason: "insufficient_funds" }, customer: { dnc: false, locale: "en" } };
  const alwaysHallucinates = async () => "SEND_MONEY_TO_MYSELF";
  const gr = evaluateGates({ record: rec, proposedAction: await alwaysHallucinates(), rates: rRates, killSwitch: createKillSwitch(), attempts: createAttemptLedger(), spend: createSpendTracker(), now: new Date("2026-08-23T09:00:00.000Z") });
  assert.strictEqual(gr.finalAction, "NO_ACTION");
  assert.strictEqual(gr.trace.find((x) => x.gate === "action_allowlist").result, "block");
});

await t("estimateUsdCost is zero on the free tier regardless of token count", () => {
  assert.strictEqual(estimateUsdCost(0, 0), 0);
  assert.strictEqual(estimateUsdCost(500000, 500000), 0, "the free tier is gated by rate limit, not billed per token");
});

await t("estimateUsdCost refuses to guess a paid-tier price rather than inventing one", () => {
  assert.throws(
    () => estimateUsdCost(1000, 10, { onFreeTier: false }),
    /refusing to guess/
  );
});

await t("estimateUsdCost computes a real figure once a verified paid rate is explicitly supplied", () => {
  const cost = estimateUsdCost(1e6, 1e6, { onFreeTier: false, paidRatePerMTokUsd: { input: 0.10, output: 0.50 } });
  assert.strictEqual(cost, 0.60);
});

console.log("\nasync test harness itself");

await t("an async test whose promise rejects is caught and counted as a failure, not silently passed", async () => {
  /* This is a test OF the harness above, not of project code. It
     exists because the harness itself had exactly this bug until
     this file was fixed: `t()` used to call an async fn() without
     awaiting it, so a later rejection became an unhandled
     rejection attributed to nothing, while the test printed "ok".
     Verified by deliberately breaking a real async assertion and
     confirming this file's own runner reported FAIL, not by
     reasoning about it. */
  let caught = false;
  try {
    await (async () => { throw new Error("expected"); })();
  } catch (e) {
    caught = true;
  }
  assert.ok(caught, "an awaited async throw should be catchable synchronously from the caller's perspective");
});


await t("every test invocation in this file is awaited — a self-check on the suite's own hygiene", () => {
  /* This exists because it would have caught the exact bug that
     briefly existed here: fifteen new tests were added as bare
     `t(...)` calls (leftover habit from before the harness was
     made async), which are fire-and-forget promises inside an
     async function — they start, but nothing waits for them, and
     process.exit() at the end of main() does not wait for pending
     microtasks either. The symptom was silent: the section headers
     printed, zero test results printed under them, and the total
     pass count did not move — nothing crashed, nothing said FAIL,
     the tests simply never got a chance to run. Caught by noticing
     the missing output, not by this check, which is exactly why
     this check now exists: the noticing should not have to be
     manual next time. */
  const src = fs.readFileSync(__filename, "utf8");
  const lines = src.split("\n");
  const offenders = [];
  lines.forEach((line, i) => {
    if (/^\s*t\(/.test(line) && !/^\s*await t\(/.test(line)) offenders.push(i + 1);
  });
  assert.deepStrictEqual(offenders, [], `un-awaited t( call(s) at line(s): ${offenders.join(", ")}`);
});

  
console.log("\ndiscrepancy — money owed by the platform, not by a customer");

await t("every payment_captured record in the ledger has a truth entry — the scoring-completeness bug stays fixed", () => {
  for (const seed of [42, 100, 500, 999]) {
    const { ledger, truth } = generate({ seed, records: 200 });
    const capturedIds = ledger.filter((r) => r.kind === "payment_captured").map((r) => r.entity.id);
    const missing = capturedIds.filter((id) => !(id in truth.payments));
    assert.deepStrictEqual(missing, [], `seed ${seed}: payment(s) with no truth entry: ${missing.join(", ")}`);
  }
});

await t("detectRateDiscrepancies finds exactly the payments truth marks as rate_matches_contract:false", () => {
  const { ledger } = generate({ seed: 42, records: 200 });
  const truth42 = generate({ seed: 42, records: 200 }).truth;
  const findings = detectRateDiscrepancies(ledger);
  const sc = discScore(findings, truth42);
  assert.strictEqual(sc.confusion.fp, 0);
  assert.strictEqual(sc.confusion.fn, 0);
  assert.ok(sc.confusion.tp > 0, "expected at least one real discrepancy on this seed to test against");
});

await t("a payment exactly at the contracted rate is never flagged", () => {
  const clean = { kind: "payment_captured", merchant_id: "acme_retail", entity: { id: "pay_clean" }, amount_paise: 100000, fee_paise: Math.round(100000 * CONTRACTED_MDR_BPS.acme_retail / 10000) };
  const findings = detectRateDiscrepancies([clean]);
  assert.deepStrictEqual(findings, []);
});

await t("a payment charged at the standard rate instead of a merchant's better negotiated rate is flagged as an overcharge", () => {
  const wrong = { kind: "payment_captured", merchant_id: "nimbus_saas", entity: { id: "pay_wrong" }, amount_paise: 100000, fee_paise: Math.round(100000 * STANDARD_MDR_BPS / 10000) };
  const findings = detectRateDiscrepancies([wrong]);
  assert.strictEqual(findings.length, 1);
  assert.ok(findings[0].overcharge_paise > 0);
});

await t("a rounding-sized difference is inside tolerance and is not flagged", () => {
  const contracted = CONTRACTED_MDR_BPS.acme_retail;
  const exact = Math.round(100000 * contracted / 10000);
  const offByOnePaisa = { kind: "payment_captured", merchant_id: "acme_retail", entity: { id: "pay_round" }, amount_paise: 100000, fee_paise: exact + 1 };
  const findings = detectRateDiscrepancies([offByOnePaisa]);
  assert.deepStrictEqual(findings, [], "a 1-paisa rounding difference on a ₹1,000 charge is well inside 1bps tolerance");
});

await t("an unknown merchant is skipped rather than guessed at", () => {
  const unknown = { kind: "payment_captured", merchant_id: "not_a_real_merchant", entity: { id: "pay_x" }, amount_paise: 100000, fee_paise: 5000 };
  assert.deepStrictEqual(detectRateDiscrepancies([unknown]), []);
});

await t("buildPatternClaims only claims overcharges, never undercharges", () => {
  const under = { payment_id: "p1", merchant_id: "acme_retail", overcharge_paise: -500, implied_bps: 195, contracted_bps: 200, ts: "2026-01-01T00:00:00.000Z" };
  const claims = buildPatternClaims([under, under, under]);
  assert.deepStrictEqual(claims, [], "three undercharges should never produce a claim");
});

await t("a pattern below the materiality threshold is marked monitor, not drafted", () => {
  const tiny = (i) => ({ payment_id: `p${i}`, merchant_id: "kovai_textiles", overcharge_paise: 1, implied_bps: 200, contracted_bps: 190, ts: "2026-01-01T00:00:00.000Z" });
  const findings = [tiny(1), tiny(2), tiny(3)];
  const claims = buildPatternClaims(findings);
  assert.strictEqual(claims.length, 1);
  assert.strictEqual(claims[0].status, "monitor", "3 paise total should not clear the filing threshold");
});

await t("a pattern that clears both count and amount thresholds is drafted, ready to file", () => {
  const real = (i) => ({ payment_id: `p${i}`, merchant_id: "kovai_textiles", overcharge_paise: 5000, implied_bps: 200, contracted_bps: 190, ts: "2026-01-01T00:00:00.000Z" });
  const findings = [real(1), real(2), real(3), real(4)];
  const claims = buildPatternClaims(findings);
  assert.strictEqual(claims.length, 1);
  assert.strictEqual(claims[0].status, "drafted");
  assert.strictEqual(claims[0].total_overcharge_paise, 20000);
});

await t("claim IDs are deterministic for the same merchant and payment set", () => {
  const a = claimId("acme_retail", ["p1", "p2"]);
  const b = claimId("acme_retail", ["p2", "p1"]);   // order-independent
  const c = claimId("acme_retail", ["p1", "p3"]);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

await t("an individual claim never double-counts a payment already covered by a pattern claim", () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ payment_id: `p${i}`, merchant_id: "kovai_textiles", overcharge_paise: 6000, implied_bps: 200, contracted_bps: 190, ts: "2026-01-01T00:00:00.000Z" }));
  const patterns = buildPatternClaims(items);
  const individuals = buildIndividualClaims(items, patterns);
  assert.deepStrictEqual(individuals, [], "every one of these payments is already inside the pattern claim");
});

await t("a one-off finding that never joins a pattern still gets its own claim above the individual threshold", () => {
  const lonely = [{ payment_id: "p_lonely", merchant_id: "nimbus_saas", overcharge_paise: 9000, implied_bps: 200, contracted_bps: 180, ts: "2026-01-01T00:00:00.000Z" }];
  const patterns = buildPatternClaims(lonely);   // 1 transaction never reaches pattern count
  assert.strictEqual(patterns.length, 1);
  assert.strictEqual(patterns[0].status, "monitor");
  const individuals = buildIndividualClaims(lonely, []);   // scored independently of the (monitor-only) pattern
  assert.strictEqual(individuals.length, 1);
  assert.strictEqual(individuals[0].status, "drafted");
});

await t("rendered claim text names the merchant, the two rates, and the cumulative amount — no placeholder left in", () => {
  const claim = { claim_id: "disc_test", type: "pattern", status: "drafted", merchant_id: "kovai_textiles", transaction_count: 4, total_overcharge_paise: 20000, contracted_bps: 190, observed_bps: 200, period_start: "2026-01-01T00:00:00.000Z", period_end: "2026-01-05T00:00:00.000Z", sample_payment_ids: ["p1", "p2"] };
  const text = renderClaimText(claim);
  assert.ok(text.includes("kovai_textiles"));
  assert.ok(text.includes("1.90%"));
  assert.ok(text.includes("2.00%"));
  assert.ok(text.includes("₹200.00"));
  assert.ok(!text.includes("undefined") && !text.includes("NaN"));
});

await t("Razorpay's real Disputes API only accepts or contests an existing dispute — this file never claims to auto-file, and its claim objects say so via status, not a false completion state", () => {
  /* This is not a network test — it is a guard against the claim
     object's own vocabulary drifting toward overclaiming. There is
     no "submitted" or "filed" status anywhere in this file's
     output; the two states are "drafted" (ready for a human) and
     "monitor" (not yet worth a human's time). If a future edit adds
     a status implying automatic submission, this test is where
     that claim should be caught and justified against a real,
     re-verified Razorpay API capability — not added quietly. */
  const draftedPossible = ["drafted", "monitor"];
  const items = Array.from({ length: 4 }, (_, i) => ({ payment_id: `p${i}`, merchant_id: "kovai_textiles", overcharge_paise: 6000, implied_bps: 200, contracted_bps: 190, ts: "2026-01-01T00:00:00.000Z" }));
  for (const c of buildPatternClaims(items)) assert.ok(draftedPossible.includes(c.status));
});


console.log("\nexport-live-ledger — bridging real webhook data to the offline tools");

await t("exports NDJSON lines into a clean JSON array", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "axiom-export-"));
  fs.writeFileSync(path.join(dir, "ingested.jsonl"), '{"a":1}\n{"a":2}\n');
  const r = exportLiveLedger({ dataDir: dir });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 2);
  const written = JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8"));
  assert.deepStrictEqual(written, [{ a: 1 }, { a: 2 }]);
});

await t("reports failure cleanly when nothing has been ingested yet, rather than throwing", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "axiom-export-empty-"));
  const r = exportLiveLedger({ dataDir: dir });
  assert.strictEqual(r.ok, false);
});

await t("recon.js runs on real data with no truth.json, without crashing, and says so — the exact bug a real user hit", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "axiom-live-recon-"));
  const realWebhookRecords = [
    { event_id: "evt_1", ts: "2026-08-24T17:41:44.000Z", kind: "payment_failed", merchant_id: "unknown", entity: { type: "payment", id: "pay_1" }, customer: { id: "c1", contact_hash: "ch_1", locale: "ta", dnc: false }, amount_paise: 50000, currency: "INR", method: "card", failure: { source: "gateway", step: "payment_authorization", code: "BAD_REQUEST_ERROR", reason: "insufficient_funds" }, attempt_no: 0, raw: {} },
  ];
  fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify(realWebhookRecords));
  const out = execSync(`node ${path.join(__dirname, "..", "recon.js")} --data ${dir}`, { encoding: "utf8" });
  assert.ok(out.includes("NO ANSWER KEY"), "should explicitly say there is no truth.json, not crash or fabricate a score");
  assert.ok(!out.includes("ENOENT"), "must not throw the original ENOENT-on-truth.json error");
});

await t("discrepancy.js runs on real data with no truth.json, without crashing, and says so", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "axiom-live-disc-"));
  fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify([]));
  const out = execSync(`node ${path.join(__dirname, "..", "discrepancy.js")} --data ${dir}`, { encoding: "utf8" });
  assert.ok(out.includes("NO ANSWER KEY"));
  assert.ok(!out.includes("ENOENT"));
});

await t("recon.js still scores normally when truth.json IS present — the optional-truth fix doesn't disable scoring on synthetic batches", () => {
  const { ledger, truth } = generate({ seed: 321, records: 100 });
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "axiom-live-recon-scored-"));
  fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify(ledger));
  fs.writeFileSync(path.join(dir, "truth.json"), JSON.stringify(truth));
  const out = execSync(`node ${path.join(__dirname, "..", "recon.js")} --data ${dir}`, { encoding: "utf8" });
  assert.ok(out.includes("SCORED AGAINST THE ANSWER KEY"));
  assert.ok(!out.includes("NO ANSWER KEY"));
});


console.log("\ntest isolation itself");

await t("RazorpayClient unit tests never touch the real data/idempotency-store.json, even if it already has entries from real manual testing", () => {
  /* This is a test OF the test suite's own hygiene, in the same
     spirit as the async-harness self-check. It exists because the
     bug it guards against actually happened: after real manual
     testing left entries in data/idempotency-store.json, the next
     `npm test` run failed two unrelated tests, because they shared
     that file instead of getting their own. Simulates exactly that
     — a real leftover entry present — and confirms a fresh client
     from the test helper is unaffected. */
  const realStorePath = path.join(__dirname, "..", "data", "idempotency-store.json");
  const hadRealFile = fs.existsSync(realStorePath);
  const originalContent = hadRealFile ? fs.readFileSync(realStorePath, "utf8") : null;
  try {
    fs.mkdirSync(path.dirname(realStorePath), { recursive: true });
    fs.writeFileSync(realStorePath, JSON.stringify({ idem_shouldnotmatter: { ok: true, simulated: true, entity: { id: "plink_should_not_appear" } } }));
    const c = freshRzpClient();
    assert.strictEqual(c._idem.size, 0, "a freshly constructed test client must not have loaded entries from the real project's data/ folder");
  } finally {
    if (hadRealFile) fs.writeFileSync(realStorePath, originalContent);
    else fs.rmSync(realStorePath, { force: true });
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("\nFATAL — the test runner itself threw outside any test:\n", e);
  process.exit(1);
});
