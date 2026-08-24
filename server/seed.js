"use strict";
/* ══════════════════════════════════════════════════════════════
   SYNTHETIC DATA GENERATOR
   ──────────────────────────────────────────────────────────────
   Produces two linked datasets from one seed:

     ledger.json      canonical records — the money at risk
                      (Track 3) plus the captured payments and
                      settlement lines they have to reconcile
                      against (Track 4)

     truth.json       the ground truth: for every payment, whether
                      it genuinely reconciles, and if not, exactly
                      which break it carries and why

   ── Why the truth file is the point ──────────────────────────
   A reconciler with no ground truth can only report how many
   things it matched, which is a statement about its own
   confidence. With ground truth it can report precision and
   recall — how many of its matches were real, and how many real
   matches it missed. Those are different numbers and the gap
   between them is where a reconciler is actually judged.

   This is also why reconciliation carries the measurement burden
   for the whole project: the recovery side depends on a simulated
   customer, but the reconciliation side has an answer key that
   was written before the matcher existed.

   ── Breaks are injected at a declared rate ───────────────────
   Not sprinkled by feel. Each break class has a target share,
   the generator hits it deterministically, and the summary prints
   the realised mix so the batch composition is a stated fact
   rather than something a reviewer has to infer.

   ── Nothing here is real ─────────────────────────────────────
   Names, contacts and ids are synthetic. Contact values are
   hashed on the way in and the raw values are discarded, so even
   the fake numbers never reach the ledger. That is the same code
   path real data would take, which is the point of doing it now.

   Usage:
     node seed.js --seed 42 --records 200 --out ./data
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const { rngFor, randInt, pick, weighted } = require("./lib/rng");
const { validateBatch, rupees } = require("./lib/schema");
const { contactHash } = require("./lib/verify");

/* ── batch composition ─────────────────────────────────────────
   Declared shares, not vibes. Sum to 1.0. */
const AT_RISK_MIX = {
  payment_failed: 0.42,
  checkout_abandoned: 0.20,
  subscription_halted: 0.18,
  invoice_overdue: 0.20,
};

/* Failure reasons, split by how recoverable they actually are.
   A batch made only of soft declines would flatter any retry
   agent; a batch made only of hard declines would make every
   agent look useless. Both are unrepresentative.

   mandate_revoked's original 0.05 is split three ways rather than
   left as one bucket, so that business-paused mandates — the case
   that can ONLY be fixed by an action this project doesn't have
   yet — actually appear in test batches instead of being averaged
   away inside a generic "mandate" reason. */
const REASON_MIX = {
  insufficient_funds: 0.26,
  gateway_error: 0.14,
  issuer_down: 0.08,
  payment_timeout: 0.12,
  authentication_failed: 0.16,
  card_expired: 0.10,
  card_blocked: 0.06,
  mandate_revoked: 0.02,
  mandate_paused_by_customer: 0.02,
  mandate_paused_by_business: 0.01,
  invalid_account: 0.03,
};

const METHOD_MIX = { upi: 0.44, card: 0.30, emandate: 0.14, netbanking: 0.08, wallet: 0.04 };

/* Locale mix approximating a pan-India merchant book. The point of
   carrying locale at all is that the recovery agent can choose to
   speak it — and that choosing wrong can be measured. */
const LOCALE_MIX = { en: 0.30, hi: 0.22, ta: 0.14, te: 0.10, kn: 0.08, ml: 0.06, mr: 0.05, bn: 0.03, gu: 0.02 };

/* Reconciliation break classes and their target share of the
   settled population. `clean` is the majority — a break rate of
   50% would not resemble any real settlement file. */
const BREAK_MIX = {
  clean: 0.72,
  fee_variance: 0.07,
  timing_split: 0.06,
  refund_netting: 0.05,
  missing_settlement: 0.04,
  amount_mismatch: 0.03,
  duplicate_payment: 0.02,
  unmatched_credit: 0.01,
};

const REASON_TO_FAILURE = {
  insufficient_funds:    { source: "customer", step: "payment_authorization",  code: "BAD_REQUEST_ERROR" },
  gateway_error:         { source: "gateway",  step: "payment_authorization",  code: "GATEWAY_ERROR" },
  issuer_down:           { source: "bank",     step: "payment_authorization",  code: "GATEWAY_ERROR" },
  payment_timeout:       { source: "gateway",  step: "payment_authentication", code: "GATEWAY_ERROR" },
  authentication_failed: { source: "customer", step: "payment_authentication", code: "BAD_REQUEST_ERROR" },
  card_expired:          { source: "customer", step: "payment_initiation",     code: "BAD_REQUEST_ERROR" },
  card_blocked:          { source: "bank",     step: "payment_authorization",  code: "BAD_REQUEST_ERROR" },
  mandate_revoked:       { source: "customer", step: "payment_initiation",     code: "BAD_REQUEST_ERROR" },
  /* source: "customer" / "business" here is not a stylistic choice —
     it is the field that determines who is capable of fixing the
     record, and it is why these two are separate reasons at all. */
  mandate_paused_by_customer: { source: "customer", step: "payment_initiation", code: "BAD_REQUEST_ERROR" },
  mandate_paused_by_business: { source: "business", step: "payment_initiation", code: "BAD_REQUEST_ERROR" },
  invalid_account:       { source: "customer", step: "payment_initiation",     code: "BAD_REQUEST_ERROR" },
};

/* Ticket sizes by kind, in paise. Log-ish spread: most small, a
   long tail of large ones. A batch of uniformly-sized tickets
   would hide the fact that recovery effort should scale with
   amount — which is one of the things the agent is judged on. */
const AMOUNT_BANDS = {
  payment_failed:      [[19900, 0.40], [99900, 0.35], [499900, 0.18], [2499900, 0.07]],
  checkout_abandoned:  [[49900, 0.45], [199900, 0.35], [899900, 0.20]],
  subscription_halted: [[29900, 0.50], [79900, 0.32], [299900, 0.18]],
  invoice_overdue:     [[1499900, 0.42], [4999900, 0.33], [14999900, 0.18], [49999900, 0.07]],
};

const MERCHANTS = ["acme_retail", "sundar_spares", "kovai_textiles", "nimbus_saas", "vaigai_traders"];

/* Contracted merchant-discount-rate, in basis points, per merchant.
   Real merchants negotiate different rates by volume and vertical
   — 200bps (2.00%) is Razorpay's commonly-cited standard card rate,
   used here as the default; two merchants have negotiated below it.
   This is the rate discrepancy.js checks actual charges against —
   deliberately a SEPARATE table from anything recon.js reads, so
   the two files can never quietly agree by construction. */
const CONTRACTED_MDR_BPS = Object.freeze({
  acme_retail: 200,
  sundar_spares: 200,
  kovai_textiles: 190,     // negotiated 10bps below standard
  nimbus_saas: 180,        // negotiated 20bps below standard — higher volume
  vaigai_traders: 200,
});
/* The standard rate a billing system would fall back to if a
   merchant's special pricing flag were not honoured — the specific,
   realistic failure mode this phenomenon simulates, not a random
   number. */
const STANDARD_MDR_BPS = 200;

/* Per-merchant, per-batch: does this merchant's account currently
   have its negotiated rate silently reverting to standard? Modelled
   as an account-level condition (affects every one of that
   merchant's transactions in the batch), not per-transaction noise
   — a real rate-configuration bug does not roll new dice per
   payment, it is wrong until someone notices and fixes it. Only
   merchants with a below-standard contracted rate can even exhibit
   this; a merchant already on the standard rate has nothing to
   revert to. */
function rollRateCreep(seed, merchant) {
  if (CONTRACTED_MDR_BPS[merchant] === STANDARD_MDR_BPS) return false;
  const r = rngFor(seed, "rate-creep", merchant);
  return r() < 0.4;   /* a product decision (how often this bug pattern occurs), not a citation */
}

/* ── guaranteeing the phenomenon actually appears ────────────────
   Measured, not assumed: with two eligible merchants at 40% each,
   roughly 36% of batches would show zero rate discrepancies at all
   — confirmed empirically at 12/30 sampled seeds. This is the same
   failure mode already fixed twice elsewhere in this file (rare
   settlement breaks, rare mandate reasons): a phenomenon worth
   building a whole detector for should not be left to a coin flip
   on whether the demo batch happens to contain one. If neither
   eligible merchant rolls true, one is forced, deterministically,
   and the forcing is disclosed rather than hidden. */
function resolveRateCreep(seed) {
  const eligible = Object.keys(CONTRACTED_MDR_BPS).filter((m) => CONTRACTED_MDR_BPS[m] !== STANDARD_MDR_BPS);
  const status = {};
  eligible.forEach((m) => { status[m] = rollRateCreep(seed, m); });

  let forced = null;
  if (eligible.length && !eligible.some((m) => status[m])) {
    const idx = Math.floor(rngFor(seed, "rate-creep-force")() * eligible.length);
    forced = eligible[idx];
    status[forced] = true;
  }
  return { status, forced };
}

function hex(rand, n) {
  const c = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < n; i++) s += c[Math.floor(rand() * 16)];
  return s;
}

function amountFor(rand, kind) {
  const bands = AMOUNT_BANDS[kind];
  const table = {};
  bands.forEach(([cap, w], i) => (table[i] = w));
  const i = Number(weighted(rand, table));
  const cap = bands[i][0];
  const lo = i === 0 ? 9900 : bands[i - 1][0];
  /* Round to the rupee. Sub-rupee ticket amounts do not occur in
     practice and would make every rounding break look real. */
  return Math.round(randInt(rand, lo, cap) / 100) * 100;
}

/* ── the anchor epoch ──────────────────────────────────────────
   Caught by the determinism test on the first run: seeding from
   Date.now() meant two runs one second apart produced different
   timestamps, so `--seed 42` was reproducible in every field
   except the one every ageing and timing rule reads.

   A reviewer who clones this repo next month has to get the batch
   in the README byte for byte, so the clock is not an input. This
   fixed anchor is. Pass `--now <iso>` to move it deliberately;
   the value used is recorded in truth.summary either way. */
const ANCHOR_EPOCH = Date.parse("2026-08-01T00:00:00.000Z");

function generate({ seed = 42, records = 200, days = 30, now = ANCHOR_EPOCH } = {}) {
  const rand = rngFor("seed", seed);
  const salt = process.env.CONTACT_SALT || "dev-only-salt-replace-me";

  const ledger = [];
  const truth = { payments: {}, summary: {} };
  const breakCounts = {};

  /* Resolved once, up front — every transaction for an affected
     merchant reads the same decision, and the disclosure (which
     merchant, whether forcing was needed) is available for the
     summary regardless of how many settled records this batch
     happens to contain. */
  const rateCreep = resolveRateCreep(seed);

  /* Split the batch: at-risk records carry the Track 3 workload,
     settled records carry the Track 4 workload. Roughly 60/40 so
     both loops get a population worth measuring. */
  const atRiskN = Math.round(records * 0.6);
  const settledN = records - atRiskN;

  /* ── at-risk population ─────────────────────────────────────── */
  for (let i = 0; i < atRiskN; i++) {
    const r = rngFor(seed, "atrisk", i);
    const kind = weighted(r, AT_RISK_MIX);
    const method = weighted(r, METHOD_MIX);
    const locale = weighted(r, LOCALE_MIX);
    const merchant = pick(r, MERCHANTS);
    const amount = amountFor(r, kind);

    const ageHours = randInt(r, 1, days * 24);
    const ts = new Date(now - ageHours * 3600e3).toISOString();

    const needsFailure = kind === "payment_failed" || kind === "subscription_halted";
    let reason = null, failure = null;
    if (needsFailure) {
      reason = weighted(r, REASON_MIX);
      /* An e-mandate cannot fail for card_expired, and a mandate
         event of any kind cannot describe a one-off card or UPI
         payment — mandates exist only on emandate. Emitting
         impossible pairs would let a detector "learn" an artefact
         of the generator instead of the domain. */
      const MANDATE_REASON = new Set(["mandate_revoked", "mandate_paused_by_customer", "mandate_paused_by_business"]);
      if (method === "emandate" && (reason === "card_expired" || reason === "card_blocked")) reason = "mandate_revoked";
      if (method !== "emandate" && MANDATE_REASON.has(reason)) reason = "insufficient_funds";
      if (method === "upi" && (reason === "card_expired" || reason === "card_blocked")) reason = "insufficient_funds";
      failure = { ...REASON_TO_FAILURE[reason], reason };
    }

    /* Prior attempts already made before this batch begins. Starting
       everything at attempt 0 would make the whole population look
       fresh and inflate every retry arm. */
    const attempt_no = kind === "subscription_halted" ? randInt(r, 1, 3) : randInt(r, 0, 1);
    const dnc = r() < 0.06;

    const rawContact = `9${randInt(r, 100000000, 999999999)}`;

    ledger.push({
      event_id: `evt_${hex(r, 14)}`,
      ts,
      kind,
      merchant_id: merchant,
      entity: {
        type: kind === "invoice_overdue" ? "invoice"
            : kind === "subscription_halted" ? "subscription"
            : kind === "checkout_abandoned" ? "order" : "payment",
        id: (kind === "invoice_overdue" ? "inv_"
          : kind === "subscription_halted" ? "sub_"
          : kind === "checkout_abandoned" ? "order_" : "pay_") + hex(r, 14),
      },
      customer: {
        id: `cust_${hex(r, 12)}`,
        contact_hash: contactHash(rawContact, salt),
        locale,
        dnc,
      },
      amount_paise: amount,
      currency: "INR",
      method,
      failure,
      attempt_no,
      hours_since_event: ageHours,
      due_in_days: kind === "invoice_overdue" ? -randInt(r, 1, 90) : null,
      raw: { simulated: true },
    });
  }

  /* ── guaranteeing the rare mandate-pause reasons actually appear ──
     Caught by testing at n=400, not by inspection: mandate_paused_by_business
     has a 1% share, and only shows up at all when the same record
     also happens to draw the emandate method (14% share) — a joint
     probability of roughly 0.14%. A 400-record run drew zero of them.
     Since the entire point of splitting this reason out was to make
     it visible and testable, leaving its appearance to chance would
     defeat the purpose of having added it.

     This is the same failure mode as the BREAK_MIX fix above,
     showing up in a different part of the generator. Rather than
     reworking kind, method and reason into one joint stratified draw
     — which would fight the declared shares of every other field —
     this scans the at-risk records already generated for emandate
     candidates that need a failure reason, and reassigns a seeded
     minimum of them so each mandate reason appears at least once. If
     no such candidate exists at all (only possible at very small n),
     one failing record is converted outright rather than shipping a
     batch that can never exercise this path. */
  function ensureMandateReasonCoverage(atRiskRecords) {
    const MANDATE_REASONS = ["mandate_revoked", "mandate_paused_by_customer", "mandate_paused_by_business"];
    const withIdx = atRiskRecords.map((rec, idx) => ({ rec, idx }));
    const candidates = withIdx.filter(({ rec }) => rec.method === "emandate" && rec.failure);
    const forced = [];

    MANDATE_REASONS.forEach((reason, n) => {
      if (candidates.some(({ rec }) => rec.failure.reason === reason)) return;   // already present by chance

      const rr = rngFor(seed, "mandate-coverage", n);
      let target;
      if (candidates.length) {
        target = candidates[Math.floor(rr() * candidates.length)];
      } else {
        const anyFailing = withIdx.find(({ rec }) => rec.failure);
        if (!anyFailing) return;             // n too small to contain any failure at all
        anyFailing.rec.method = "emandate";
        target = anyFailing;
        candidates.push(target);
      }
      target.rec.failure = { ...REASON_TO_FAILURE[reason], reason };
      forced.push(reason);
    });
    return forced;
  }
  const mandateReasonsForced = ensureMandateReasonCoverage(ledger);

  /* ── break assignment, stratified ───────────────────────────
     Measured on the first run: at n=200 the two rarest classes
     (duplicate_payment 2%, unmatched_credit 1%) drew ZERO. A
     reviewer would then be shown a reconciler that has never once
     been asked to catch a duplicate charge — which is the break
     that matters most, since it is the one that costs a customer
     real money.

     Raising n until they appear is the wrong fix: it makes the
     demo batch large enough to be slow and still leaves the
     appearance to chance. Instead each class is guaranteed one
     slot, the remainder is drawn from the declared mix, and the
     number of forced slots is reported. The batch composition
     stays a stated fact — including the fact that it was forced. */
  const breakClasses = Object.keys(BREAK_MIX);
  const assignments = [];
  let forced = 0;
  if (settledN >= breakClasses.length) {
    for (const c of breakClasses) { assignments.push(c); forced++; }
  }
  for (let i = assignments.length; i < settledN; i++) {
    assignments.push(weighted(rngFor(seed, "breakdraw", i), BREAK_MIX));
  }
  /* Deterministic Fisher-Yates, so the guaranteed slots are not all
     clustered at the front of the file where a demo would only ever
     scroll past the same eight rows. */
  for (let i = assignments.length - 1; i > 0; i--) {
    const j = Math.floor(rngFor(seed, "breakshuffle", i)() * (i + 1));
    [assignments[i], assignments[j]] = [assignments[j], assignments[i]];
  }

  /* ── settled population + reconciliation truth ──────────────── */
  for (let i = 0; i < settledN; i++) {
    const r = rngFor(seed, "settled", i);
    const method = weighted(r, METHOD_MIX);
    const locale = weighted(r, LOCALE_MIX);
    const merchant = pick(r, MERCHANTS);
    const amount = Math.round(randInt(r, 9900, 4999900) / 100) * 100;
    const ageHours = randInt(r, 24, days * 24);
    const capturedAt = now - ageHours * 3600e3;

    const payId = `pay_${hex(r, 14)}`;
    const brk = assignments[i];
    breakCounts[brk] = (breakCounts[brk] || 0) + 1;

    /* Two independent questions about this fee, deliberately kept
       independent:

         1. Does the SETTLEMENT match the RECORDED fee? — recon.js's
            job, exercised by the break classes above (fee_variance,
            amount_mismatch, ...). The reconciler never hard-codes a
            rate; it derives what's expected from the recorded fee
            itself and flags a mismatch against the settlement.

         2. Does the RECORDED fee match what was actually CONTRACTED
            with this merchant? — discrepancy.js's job. A settlement
            can tie out perfectly against the recorded fee (question
            1: clean) while the recorded fee itself silently used the
            wrong rate (question 2: wrong) — a systematic overcharge
            that reconciliation alone cannot see, because internal
            consistency and external correctness are different
            claims. `appliedBps` below is what actually gets charged
            and recorded; `CONTRACTED_MDR_BPS[merchant]` is the
            separate, independent figure discrepancy.js checks it
            against. */
    const rateCreepActive = rateCreep.status[merchant] || false;
    const appliedBps = rateCreepActive ? STANDARD_MDR_BPS : CONTRACTED_MDR_BPS[merchant];
    const fee = Math.round((amount * appliedBps) / 10000);
    const tax = Math.round(fee * 0.18);
    let net = amount - fee - tax;

    const payment = {
      event_id: `evt_${hex(r, 14)}`,
      ts: new Date(capturedAt).toISOString(),
      kind: "payment_captured",
      merchant_id: merchant,
      entity: { type: "payment", id: payId },
      customer: {
        id: `cust_${hex(r, 12)}`,
        contact_hash: contactHash(`9${randInt(r, 100000000, 999999999)}`, salt),
        locale, dnc: false,
      },
      amount_paise: amount,
      currency: "INR",
      method,
      failure: null,
      attempt_no: 0,
      fee_paise: fee,
      tax_paise: tax,
      raw: { simulated: true },
    };
    ledger.push(payment);

    const settleAt = capturedAt + randInt(r, 24, 72) * 3600e3;
    const setlId = `setl_${hex(r, 12)}`;
    const emit = (over = {}) => ledger.push({
      event_id: `evt_${hex(r, 14)}`,
      ts: new Date(settleAt).toISOString(),
      kind: "settlement_line",
      merchant_id: merchant,
      entity: { type: "settlement", id: setlId },
      customer: payment.customer,
      amount_paise: net,
      currency: "INR",
      method,
      failure: null,
      attempt_no: 0,
      settles_payment_id: payId,
      raw: { simulated: true },
      ...over,
    });

    const t = {
      payment_id: payId, gross_paise: amount, expected_net_paise: net, break: brk, reconciles: brk === "clean",
      /* Independent of everything above — this is the answer key
         for discrepancy.js, not recon.js. A payment can be
         `reconciles: true` here (settlement matches recorded fee)
         and STILL have `rate_matches_contract: false` (the recorded
         fee used the wrong bps) at the same time. That combination
         is the whole point of building this as a separate check. */
      contracted_fee_bps: CONTRACTED_MDR_BPS[merchant],
      applied_fee_bps: appliedBps,
      rate_matches_contract: appliedBps === CONTRACTED_MDR_BPS[merchant],
    };

    switch (brk) {
      case "clean":
        emit();
        break;

      case "fee_variance": {
        /* Settled slightly short: the fee applied was not the fee
           expected. Real, common, and almost always a pricing-plan
           mismatch rather than a loss. Must be surfaced, not
           silently absorbed into a tolerance. */
        const extra = Math.round(fee * (0.15 + r() * 0.35));
        net = net - extra;
        emit({ amount_paise: net });
        t.expected_net_paise = amount - fee - tax;
        t.actual_net_paise = net;
        t.delta_paise = -extra;
        break;
      }

      case "timing_split": {
        /* One payment lands across two settlement batches. A matcher
           that assumes one-to-one will report both halves as
           unmatched and score two false exceptions from one event. */
        const half = Math.floor(net / 2);
        emit({ amount_paise: half });
        emit({ amount_paise: net - half, entity: { type: "settlement", id: `setl_${hex(r, 12)}` }, ts: new Date(settleAt + 86400e3).toISOString() });
        t.reconciles = true;                 /* it DOES reconcile — as a pair */
        t.note = "one payment, two settlement lines";
        break;
      }

      case "refund_netting": {
        /* A refund issued after capture is netted out of the
           settlement. The shortfall looks identical to a loss unless
           the refund is joined in. */
        const refund = Math.round(amount * (0.2 + r() * 0.5) / 100) * 100;
        ledger.push({
          event_id: `evt_${hex(r, 14)}`,
          ts: new Date(capturedAt + 12 * 3600e3).toISOString(),
          kind: "refund_processed",
          merchant_id: merchant,
          entity: { type: "refund", id: `rfnd_${hex(r, 12)}` },
          customer: payment.customer,
          amount_paise: refund,
          currency: "INR",
          method, failure: null, attempt_no: 0,
          refunds_payment_id: payId,
          raw: { simulated: true },
        });
        net = net - refund;
        emit({ amount_paise: net });
        t.reconciles = true;                 /* reconciles once the refund is joined */
        t.refund_paise = refund;
        t.note = "shortfall explained by a refund";
        break;
      }

      case "missing_settlement":
        /* Captured, never settled inside the window. A true break. */
        t.note = "captured, no settlement line in window";
        break;

      case "amount_mismatch": {
        const off = randInt(r, 100, 5000);
        emit({ amount_paise: net + (r() < 0.5 ? off : -off) });
        t.delta_paise = off;
        t.note = "settled amount does not derive from gross minus fees";
        break;
      }

      case "duplicate_payment": {
        /* The customer paid twice for one order. Both settle. The
           merchant owes a refund; a reconciler that only checks
           payment->settlement will call both clean and miss it. */
        const dupId = `pay_${hex(r, 14)}`;
        ledger.push({ ...payment, event_id: `evt_${hex(r, 14)}`, entity: { type: "payment", id: dupId }, ts: new Date(capturedAt + 90e3).toISOString() });
        emit();
        emit({ settles_payment_id: dupId, entity: { type: "settlement", id: `setl_${hex(r, 12)}` } });
        t.duplicate_of = payId;
        t.duplicate_payment_id = dupId;
        t.note = "two captures seconds apart for one order";
        /* Caught by discrepancy.js's own scoring not adding up to
           the ledger's payment_captured count: the duplicate's
           record exists in the ledger with its own entity.id, but
           until this line, truth.payments had NO entry for that id
           at all — only for the original. Any scorer that iterates
           truth.payments (this file's own recon.js score(), and
           discrepancy.js's) would silently skip the duplicate
           entirely: not a true positive, not a false positive, not
           counted anywhere, while a detector that correctly flagged
           it got no credit and one that missed it got no penalty.
           Every payment_captured record gets a truth entry — no
           exceptions — and the duplicate inherits the same rate
           fields as the original since it's a spread copy charged
           under the same (possibly wrong) applied rate. */
        truth.payments[dupId] = {
          payment_id: dupId, gross_paise: amount, expected_net_paise: net,
          break: "duplicate_payment", reconciles: false,
          contracted_fee_bps: t.contracted_fee_bps, applied_fee_bps: t.applied_fee_bps, rate_matches_contract: t.rate_matches_contract,
          duplicate_of: payId, note: "the duplicate capture itself",
        };
        break;
      }

      case "unmatched_credit":
        /* Money arrived with no payment behind it. Rare, and always
           worth a human. */
        emit({ settles_payment_id: null, amount_paise: Math.round(randInt(r, 5000, 500000) / 100) * 100 });
        t.note = "settlement credit with no originating payment";
        break;
    }

    truth.payments[payId] = t;
  }

  const { clean, quarantined } = validateBatch(ledger);

  truth.summary = {
    seed, records,
    anchor_epoch: new Date(now).toISOString(),
    stratified_slots_forced: forced,
    mandate_reasons_forced: mandateReasonsForced,
    generated: ledger.length,
    valid: clean.length,
    quarantined: quarantined.length,
    at_risk: ledger.filter((r) => ["payment_failed", "checkout_abandoned", "subscription_halted", "invoice_overdue"].includes(r.kind)).length,
    at_risk_value_paise: ledger
      .filter((r) => ["payment_failed", "checkout_abandoned", "subscription_halted", "invoice_overdue"].includes(r.kind))
      .reduce((a, r) => a + r.amount_paise, 0),
    dnc_customers: ledger.filter((r) => r.customer?.dnc).length,
    break_mix_realised: breakCounts,
    true_exceptions: Object.values(truth.payments).filter((p) => !p.reconciles).length,
    rate_discrepancies: Object.values(truth.payments).filter((p) => p.rate_matches_contract === false).length,
    merchants_with_rate_creep: [...new Set(Object.entries(truth.payments).filter(([, p]) => p.rate_matches_contract === false).map(([id]) => {
      const rec = ledger.find((r) => r.kind === "payment_captured" && r.entity.id === id);
      return rec ? rec.merchant_id : null;
    }).filter(Boolean))],
    rate_creep_forced: rateCreep.forced,
  };

  return { ledger: clean, quarantined, truth };
}

/* ── CLI ──────────────────────────────────────────────────────── */
if (require.main === module) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
  };
  const seed = Number(arg("seed", 42));
  const records = Number(arg("records", 200));
  const outDir = path.resolve(arg("out", "./data"));
  const nowArg = arg("now", null);

  fs.mkdirSync(outDir, { recursive: true });
  const { ledger, quarantined, truth } = generate({ seed, records, now: nowArg ? Date.parse(nowArg) : undefined });

  fs.writeFileSync(path.join(outDir, "ledger.json"), JSON.stringify(ledger, null, 2));
  fs.writeFileSync(path.join(outDir, "truth.json"), JSON.stringify(truth, null, 2));
  if (quarantined.length) {
    fs.writeFileSync(path.join(outDir, "quarantined.json"), JSON.stringify(quarantined, null, 2));
  }

  const s = truth.summary;
  console.log(`\nseed ${seed} · ${s.generated} events written to ${outDir}`);
  console.log(`  valid ................ ${s.valid}`);
  console.log(`  quarantined .......... ${s.quarantined}`);
  console.log(`  at-risk records ...... ${s.at_risk}`);
  console.log(`  at-risk value ........ ${rupees(s.at_risk_value_paise)}`);
  console.log(`  do-not-contact ....... ${s.dnc_customers}`);
  console.log(`  true exceptions ...... ${s.true_exceptions} (answer key in truth.json)`);
  console.log(`  break mix ............ ${Object.entries(s.break_mix_realised).map(([k, v]) => `${k}:${v}`).join("  ")}`);
  if (s.rate_discrepancies > 0) {
    console.log(`  rate discrepancies ... ${s.rate_discrepancies} payments, merchant(s): ${s.merchants_with_rate_creep.join(", ")}${s.rate_creep_forced ? ` (forced: ${s.rate_creep_forced} — too rare to trust to chance at this n)` : ""}`);
  }
  if (s.mandate_reasons_forced.length) {
    console.log(`  mandate coverage ..... forced: ${s.mandate_reasons_forced.join(", ")} (too rare to trust to chance at this n)`);
  }
  console.log(`\n  re-run with the same --seed to reproduce this batch exactly.\n`);
}

module.exports = { generate, AT_RISK_MIX, BREAK_MIX, REASON_MIX, CONTRACTED_MDR_BPS, STANDARD_MDR_BPS };
