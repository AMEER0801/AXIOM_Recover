"use strict";
/* ══════════════════════════════════════════════════════════════
   RAZORPAY CLIENT WRAPPER
   ──────────────────────────────────────────────────────────────
   Every call that can move money goes through here, and here alone.
   That single choke point is what makes the guarantees below
   auditable rather than aspirational.

   ── Dry-run is the default ───────────────────────────────────
   `live` must be passed explicitly. A missing flag, a typo'd env
   var, a forgotten CLI argument — all of them fail closed into
   simulation. The inverse default (live unless told otherwise) is
   how a demo run ends up firing real requests.

   ── Test mode is enforced, not assumed ───────────────────────
   Razorpay live keys begin `rzp_live_`. This wrapper refuses to
   construct with one unless ALLOW_LIVE_KEYS is explicitly set. The
   whole project is a buildathon artifact; a live key reaching it
   is a mistake, and the right time to catch a mistake is at boot.

   ── Idempotency is not optional ──────────────────────────────
   Every write carries a key derived deterministically from
   (entity, action, attempt). Retrying a request that already
   succeeded returns the original result instead of charging twice.
   Duplicate customer charges are the single worst outcome this
   system could produce, so the key is required by signature —
   a caller cannot forget to pass one.

   ── No SDK ───────────────────────────────────────────────────
   Plain fetch against the REST API. Node 22 has fetch built in.
   Keeps the dependency surface at zero for the part that touches
   money, so a reviewer can read every line between the decision
   and the request.
   ══════════════════════════════════════════════════════════════ */

const crypto = require("crypto");

const API_BASE = "https://api.razorpay.com/v1";

class RazorpayClient {
  /**
   * @param {object} o
   * @param {string} o.keyId
   * @param {string} o.keySecret
   * @param {boolean} o.live      false (default) = simulate, never send
   * @param {number} o.timeoutMs
   */
  constructor({ keyId, keySecret, live = false, timeoutMs = 12000 } = {}) {
    if (!keyId || !keySecret) throw new Error("RazorpayClient: keyId and keySecret are required");

    if (keyId.startsWith("rzp_live_") && process.env.ALLOW_LIVE_KEYS !== "yes-i-am-sure") {
      throw new Error(
        "RazorpayClient: a LIVE key was supplied. This project is built for test mode. " +
        "If this is deliberate, set ALLOW_LIVE_KEYS=yes-i-am-sure."
      );
    }
    if (!keyId.startsWith("rzp_test_")) {
      console.warn(`[rzp] key id "${keyId.slice(0, 12)}…" is not a rzp_test_ key — check RAZORPAY_KEY_ID`);
    }

    this.keyId = keyId;
    this.keySecret = keySecret;
    this.live = !!live;
    this.timeoutMs = timeoutMs;

    /* Replayed idempotency keys resolve from here. In production this
       is a shared store; in-process is correct for a single-node run
       and is stated as such rather than left to be discovered. */
    this._idem = new Map();

    /* Every attempted call, live or simulated, in order. The audit
       chain reads this. */
    this.calls = [];
  }

  /**
   * Deterministic idempotency key. Same (entity, action, attempt)
   * always yields the same key, on any machine, in any process —
   * so a crash-and-restart mid-batch cannot double-charge.
   */
  static idempotencyKey(entityId, action, attemptNo) {
    return "idem_" + crypto
      .createHash("sha256")
      .update(`${entityId}|${action}|${attemptNo}`)
      .digest("hex")
      .slice(0, 32);
  }

  _auth() {
    return "Basic " + Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64");
  }

  /**
   * @param {object} o
   * @param {"GET"|"POST"} o.method
   * @param {string} o.path         e.g. "/payment_links"
   * @param {object} [o.body]
   * @param {string} o.idempotencyKey  required for writes
   * @param {string} o.reason       human-readable why, for the audit log
   */
  async request({ method, path, body, idempotencyKey, reason }) {
    const isWrite = method !== "GET";
    if (isWrite && !idempotencyKey) {
      throw new Error(`rzp: refusing a ${method} to ${path} without an idempotency key`);
    }

    if (isWrite && this._idem.has(idempotencyKey)) {
      const prior = this._idem.get(idempotencyKey);
      this.calls.push({ ts: new Date().toISOString(), method, path, reason, idempotencyKey, outcome: "replayed" });
      return { ...prior, replayed: true };
    }

    const entry = {
      ts: new Date().toISOString(),
      method, path, reason, idempotencyKey,
      mode: this.live ? "live" : "dry-run",
      outcome: "pending",
    };

    if (!this.live) {
      /* Simulated responses are shaped like real ones and clearly
         marked. They are never presented as real: `simulated: true`
         travels with the object into the ledger and the audit log. */
      const res = { ok: true, simulated: true, entity: this._simulate(path, body) };
      entry.outcome = "simulated";
      this.calls.push(entry);
      if (isWrite) this._idem.set(idempotencyKey, res);
      return res;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers = { Authorization: this._auth(), "Content-Type": "application/json" };
      if (idempotencyKey) headers["X-Razorpay-Idempotency-Key"] = idempotencyKey;

      const r = await fetch(API_BASE + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const json = await r.json().catch(() => ({}));

      if (!r.ok) {
        entry.outcome = `http_${r.status}`;
        entry.error = json?.error?.description || json?.error?.code || "unknown";
        this.calls.push(entry);
        return { ok: false, status: r.status, error: json?.error || json };
      }

      entry.outcome = "ok";
      this.calls.push(entry);
      const res = { ok: true, simulated: false, entity: json };
      if (isWrite) this._idem.set(idempotencyKey, res);
      return res;
    } catch (e) {
      /* An aborted or network-failed WRITE is the dangerous case:
         the request may or may not have landed. It is deliberately
         NOT cached as an idempotency result, so a later retry with
         the same key reaches Razorpay, whose own idempotency handling
         resolves it. Caching a local failure here would hide a charge
         that actually went through. */
      entry.outcome = e.name === "AbortError" ? "timeout" : "network_error";
      entry.error = e.message;
      this.calls.push(entry);
      return { ok: false, error: { code: entry.outcome, description: e.message }, indeterminate: isWrite };
    } finally {
      clearTimeout(timer);
    }
  }

  _simulate(path, body) {
    const rid = (p) => p + crypto.randomBytes(7).toString("hex");
    if (path.startsWith("/payment_links")) {
      return { id: rid("plink_"), short_url: "https://rzp.io/i/SIMULATED", status: "created", amount: body?.amount, currency: body?.currency || "INR" };
    }
    if (path.startsWith("/orders")) {
      return { id: rid("order_"), status: "created", amount: body?.amount, currency: body?.currency || "INR" };
    }
    if (path.startsWith("/subscriptions")) {
      return { id: rid("sub_"), status: "active" };
    }
    if (path.startsWith("/invoices")) {
      return { id: rid("inv_"), status: "issued", amount: body?.amount };
    }
    return { id: rid("sim_"), status: "created" };
  }

  /* ── typed helpers ───────────────────────────────────────────
     Thin on purpose. Field names and endpoint paths should be
     checked against Razorpay's current API reference before the
     first live call — this wrapper is about the guarantees around
     the request, not about pinning a payload shape. */

  ping() {
    return this.request({ method: "GET", path: "/payments?count=1", reason: "connectivity probe" });
  }

  createPaymentLink({ amountPaise, description, customer, entityId, attemptNo, notes }) {
    return this.request({
      method: "POST",
      path: "/payment_links",
      idempotencyKey: RazorpayClient.idempotencyKey(entityId, "PAYMENT_LINK", attemptNo),
      reason: `recovery link for ${entityId} (attempt ${attemptNo})`,
      body: {
        amount: amountPaise,
        currency: "INR",
        description,
        customer,
        notify: { sms: false, email: false },   /* this system controls its own sending, so it can gate it */
        reminder_enable: false,                 /* provider-side reminders would bypass the gate layer */
        notes: { ...notes, source: "axiom-recover", entity_id: entityId, attempt: String(attemptNo) },
      },
    });
  }

  fetchPayment(paymentId) {
    return this.request({ method: "GET", path: `/payments/${paymentId}`, reason: "verify outcome" });
  }

  fetchSettlements({ from, to, count = 100 }) {
    const q = new URLSearchParams({ count: String(count) });
    if (from) q.set("from", String(from));
    if (to) q.set("to", String(to));
    return this.request({ method: "GET", path: `/settlements?${q}`, reason: "reconciliation pull" });
  }
}

module.exports = { RazorpayClient, API_BASE };
