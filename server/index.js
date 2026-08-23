"use strict";
/* ══════════════════════════════════════════════════════════════
   INGESTION SERVER
   ──────────────────────────────────────────────────────────────
   Receives Razorpay webhooks, verifies them, maps them into the
   canonical ledger shape, and appends. It makes no decisions and
   moves no money — that separation is deliberate. A webhook
   handler that also acts is a webhook handler that acts on
   whatever an unverified request tells it to.

   Node 22's built-in http module; no express, no dependencies.
   The raw request body has to be read anyway for signature
   verification, so a body-parser would only get in the way.

   ── Endpoints ────────────────────────────────────────────────
     GET  /health              liveness + posture
     POST /webhooks/razorpay   verified ingestion
     GET  /ledger              what has been ingested (dev only)
     GET  /egress              every host this process may contact
   ══════════════════════════════════════════════════════════════ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  verifyWebhookSignature, withinReplayWindow,
  createEventSeenSet, contactHash,
} = require("./lib/verify");
const { validateRecord } = require("./lib/schema");

const PORT = Number(process.env.PORT || 8787);
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";
const CONTACT_SALT = process.env.CONTACT_SALT || "";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const LEDGER_PATH = path.join(DATA_DIR, "ingested.jsonl");

const seen = createEventSeenSet();
const rejected = [];

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ── egress inventory ──────────────────────────────────────────
   Every host this process is capable of contacting, and the
   setting that enables it. Grepped from the source, not recalled.
   A reviewer can read one screen instead of trusting a sentence. */
const EGRESS = [
  { host: "api.razorpay.com", why: "payment links, payment lookup, settlements", enabled_by: "RAZORPAY_LIVE=true", default: "off (dry-run)" },
];

function json(res, code, body) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

function readRaw(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* ── canonical mapping ─────────────────────────────────────────
   Razorpay's payload shape is not this system's shape, and the
   translation lives in exactly one place so that a change to the
   provider's schema is a one-file change rather than a hunt.

   Field paths should be checked against Razorpay's current webhook
   documentation before the first live delivery — this mapping is
   written from the documented structure and the failure taxonomy
   the seeder mirrors, and the two must agree. */
function toCanonical(event) {
  const ent = event?.payload?.payment?.entity
           || event?.payload?.order?.entity
           || event?.payload?.subscription?.entity
           || event?.payload?.invoice?.entity
           || event?.payload?.settlement?.entity
           || {};

  const KIND = {
    "payment.failed": "payment_failed",
    "payment.captured": "payment_captured",
    "order.paid": "payment_captured",
    "subscription.halted": "subscription_halted",
    /* subscription.paused and subscription.halted are different
       events with different meanings — halted is Razorpay's own
       retry cycle running out (nobody paused anything), paused is
       an explicit pause with a pause_initiated_by field. Both are
       mapped to the same canonical kind for now, since this project
       does not yet have a separate "paused" workflow; the meaningful
       difference is captured in failure.reason instead, via
       classifyFailureReason() below. */
    "subscription.paused": "subscription_halted",
    "invoice.expired": "invoice_overdue",
    "refund.processed": "refund_processed",
    "settlement.processed": "settlement_line",
  };
  const kind = KIND[event?.event];
  if (!kind) return { skip: true, reason: `unmapped_event:${event?.event}` };

  const contact = ent.contact || ent.email || ent.customer_id || "unknown";

  return {
    record: {
      event_id: event.id || `evt_${Date.now()}`,
      ts: new Date((ent.created_at || event.created_at || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      kind,
      merchant_id: event.account_id || "unknown",
      entity: { type: ent.entity || "payment", id: ent.id || "unknown" },
      customer: {
        id: ent.customer_id || "cust_unknown",
        contact_hash: contactHash(contact, CONTACT_SALT),
        locale: (ent.notes && ent.notes.locale) || "en",
        dnc: !!(ent.notes && ent.notes.dnc === "true"),
      },
      amount_paise: Number(ent.amount ?? 0),
      currency: ent.currency || "INR",
      method: ent.method === "emandate" || ent.method === "upi" || ent.method === "card"
        || ent.method === "netbanking" || ent.method === "wallet" ? ent.method : "card",
      failure: kind === "payment_failed" || kind === "subscription_halted"
        ? {
            source: ent.error_source || (ent.pause_initiated_by === "self" ? "customer" : ent.pause_initiated_by ? "business" : "gateway"),
            step: ent.error_step || "payment_authorization",
            code: ent.error_code || "BAD_REQUEST_ERROR",
            reason: classifyFailureReason(ent, kind),
          }
        : null,
      attempt_no: Number((ent.notes && ent.notes.attempt) || 0),
      raw: { event: event.event, simulated: false },
    },
  };
}

/* ── failure reason classification ──────────────────────────────
   Razorpay does not send a `failure.reason` field in our vocabulary
   — it sends `error_reason`, `error_description`, and, for
   subscriptions, `pause_initiated_by`. This function is the one
   place that translates their fields into ours, so a change to
   either vocabulary is a one-function fix rather than a scattered
   hunt.

   Order of preference:
     1. pause_initiated_by, for a subscription pause — this is the
        one case where getting the mapping wrong doesn't just
        misfile a record, it points the recovery loop at the wrong
        party entirely (nudging a customer who isn't the blocker,
        or vice versa).
     2. error_reason, matched exactly against our known reasons —
        Razorpay's values sometimes coincide with ours.
     3. error_description, matched by keyword — the same pattern a
        human support engineer uses when the structured field is
        missing or unfamiliar. Ends in a stated default rather than
        a guess dressed up as one. */
function classifyFailureReason(ent, kind) {
  if (kind === "subscription_halted" && ent.pause_initiated_by) {
    /* Confirmed against Razorpay's subscription documentation: a
       business cannot force-resume a pause the customer initiated
       themselves. "self" is the customer; anything else recorded in
       this field is the business's own identifier. */
    return ent.pause_initiated_by === "self"
      ? "mandate_paused_by_customer"
      : "mandate_paused_by_business";
  }

  const KNOWN = new Set([
    "insufficient_funds", "gateway_error", "issuer_down", "payment_timeout",
    "authentication_failed", "card_expired", "card_blocked",
    "mandate_revoked", "mandate_paused_by_customer", "mandate_paused_by_business",
    "invalid_account",
  ]);
  if (ent.error_reason && KNOWN.has(ent.error_reason)) return ent.error_reason;

  const hay = `${ent.error_description || ""} ${ent.error_reason || ""}`.toLowerCase();
  if (/expired/.test(hay)) return "card_expired";
  if (/insufficient|balance/.test(hay)) return "insufficient_funds";
  if (/timed?\s*out|timeout|downtime|bank server|did not respond/.test(hay)) return "issuer_down";
  if (/authentication|otp|3d.?secure/.test(hay)) return "authentication_failed";
  if (/invalid.*(vpa|account)/.test(hay)) return "invalid_account";
  if (/block/.test(hay)) return "card_blocked";
  /* Stated default, not a silent one — a record that reaches here
     is counted as payment_timeout, and that choice is written down
     rather than left for someone to reverse-engineer later. */
  return "payment_timeout";
}

function reject(res, reason, code = 400) {
  rejected.push({ ts: new Date().toISOString(), reason });
  /* The caller learns only that it failed. The reason stays here,
     where the audit log can read it and a prober cannot. */
  json(res, code, { ok: false });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      posture: {
        webhook_secret_configured: !!WEBHOOK_SECRET,
        contact_salt_configured: !!CONTACT_SALT,
        razorpay_live: process.env.RAZORPAY_LIVE === "true",
        mode: process.env.RAZORPAY_LIVE === "true" ? "LIVE" : "dry-run",
      },
      ingested: fs.existsSync(LEDGER_PATH) ? fs.readFileSync(LEDGER_PATH, "utf8").split("\n").filter(Boolean).length : 0,
      rejected: rejected.length,
      dedupe_cache: seen.size(),
    });
  }

  if (req.method === "GET" && url.pathname === "/egress") {
    return json(res, 200, { hosts: EGRESS, note: "Grepped from source. Nothing else is contacted." });
  }

  if (req.method === "GET" && url.pathname === "/ledger") {
    if (!fs.existsSync(LEDGER_PATH)) return json(res, 200, { records: [] });
    const lines = fs.readFileSync(LEDGER_PATH, "utf8").split("\n").filter(Boolean);
    return json(res, 200, { count: lines.length, records: lines.slice(-50).map((l) => JSON.parse(l)) });
  }

  if (req.method === "POST" && url.pathname === "/webhooks/razorpay") {
    let raw;
    try { raw = await readRaw(req); }
    catch { return reject(res, "body_too_large", 413); }

    /* Verify BEFORE parsing. A malformed body from an unsigned
       source should never reach JSON.parse, let alone the mapper. */
    const sig = req.headers["x-razorpay-signature"];
    const v = verifyWebhookSignature(raw, sig, WEBHOOK_SECRET);
    if (!v.ok) return reject(res, v.reason, 401);

    let event;
    try { event = JSON.parse(raw.toString("utf8")); }
    catch { return reject(res, "unparseable_json"); }

    const w = withinReplayWindow(event.created_at);
    if (!w.ok) return reject(res, `replay:${w.reason}`, 400);

    const eventId = req.headers["x-razorpay-event-id"] || event.id;
    if (!seen.firstSighting(eventId)) {
      /* A duplicate delivery is not an error — Razorpay retries by
         design. Acknowledge it so it stops retrying, and do not
         ingest it twice. */
      return json(res, 200, { ok: true, duplicate: true });
    }

    const mapped = toCanonical(event);
    if (mapped.skip) return json(res, 200, { ok: true, ignored: mapped.reason });

    const valid = validateRecord(mapped.record);
    if (!valid.ok) {
      rejected.push({ ts: new Date().toISOString(), reason: "schema", errors: valid.errors });
      /* 200, not 4xx: the delivery was legitimate, our mapping was
         not. Returning an error would make Razorpay retry a payload
         that will fail identically every time. Quarantine and move
         on — the count is visible on /health. */
      return json(res, 200, { ok: true, quarantined: true });
    }

    fs.appendFileSync(LEDGER_PATH, JSON.stringify(mapped.record) + "\n");
    return json(res, 200, { ok: true, ingested: mapped.record.event_id });
  }

  json(res, 404, { ok: false });
});

if (require.main === module) {
  if (!WEBHOOK_SECRET) console.warn("[boot] RAZORPAY_WEBHOOK_SECRET is not set — every webhook will be rejected");
  if (!CONTACT_SALT) console.warn("[boot] CONTACT_SALT is not set — ingestion will throw rather than emit unsalted hashes");
  server.listen(PORT, () => {
    console.log(`\naxiom-recover ingestion on :${PORT}   mode=${process.env.RAZORPAY_LIVE === "true" ? "LIVE" : "dry-run"}`);
    console.log(`  POST /webhooks/razorpay   GET /health   GET /ledger   GET /egress\n`);
  });
}

module.exports = { server, toCanonical, classifyFailureReason, EGRESS };
