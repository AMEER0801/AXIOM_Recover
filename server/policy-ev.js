"use strict";
/* ══════════════════════════════════════════════════════════════
   EV POLICY — rank by money, not by habit
   ──────────────────────────────────────────────────────────────
   smartPolicy in recover.js is a fixed ladder: DUNNING_EMAIL,
   PAYMENT_LINK_SMS, then WhatsApp or voice, then escalate. Cheapest
   channel first. That ordering optimises the wrong quantity.

   Email converts at 0.06 and costs 2 paise. WhatsApp converts at
   0.16 and costs 20 paise. On a ₹500 record the email is worth
   0.06 x 500 - 0.02 = ₹29.98 and the WhatsApp is worth
   0.16 x 500 - 0.20 = ₹79.80. The ladder opens with the option
   worth ₹50 less, to save eighteen paise. On the ₹61,000 invoice
   records in the seed-42 batch the same eighteen paise is being
   traded against thousands of rupees.

   This policy ranks by expected value instead:

       EV(a) = P(pay | a, context) x amount
             - cost(a)
             - P(opt_out | a, attempt) x opt_out_loss

   ── Four corrections, each measured in FINDINGS.md ────────────

   1. Quiet hours. Gates block contact between 19:00 and 09:00 IST.
      smartPolicy does not know that, so on the default 30h round
      spacing it proposes contacts in four of eight rounds that can
      never be delivered — 108 blocked decisions on seed 42. Here,
      a quiet round proposes RETRY_CHARGE instead, which is silent
      and legal at 03:00, and the contact budget is spent in
      daylight. Free recovery; no model change.

   2. Credential viability is not willingness. The frozen model
      multiplies one `failure_reason_recoverability` factor into
      both retries and nudges, so card_expired at 0.05 drags a
      WhatsApp "update your card" link down to a 1.07% conversion.
      That conflates two different facts: 0.05 explains why a
      CHARGE against a dead card fails, and says nothing about
      whether a human asked to update it will. This policy splits
      them — credential_viability gates RETRY_CHARGE, willingness
      scales contact channels — and the split lives in
      agent-priors.json where the agent is allowed to hold beliefs.
      It does NOT edit the frozen model. See FINDINGS.md #4.

   3. Escalation is not a recovery. The frozen model returns
      paid:false for ESCALATE_HUMAN, by design. So escalating a
      record costs ₹70 of reviewer time and recovers nothing. On a
      dead-credential record a 20-paise WhatsApp with even a 1%
      conversion has higher expected value than a ₹70 escalation
      with a 0% one. This policy escalates only where escalation
      does something: above the approval ceiling, where it unlocks
      further action through approvals.js, and on
      mandate_paused_by_business, where no customer action can
      clear a merchant-side block.

   4. The attempt budget goes unused. gates.js allows 4 attempts;
      smartPolicy terminates at 3 for most reasons. The last
      attempt is free optionality and is taken here whenever its EV
      is positive.

   ── What this policy is not allowed to know ───────────────────
   It never reads model/base-rates.json. Its beliefs come from
   model/agent-priors.json and from the bandit's posterior, which
   updates only on outcomes it actually observed. A policy that
   argmaxed against the simulator's own probability table would
   post an excellent number that means nothing.
   ══════════════════════════════════════════════════════════════ */

const { withinQuietHours } = require("./gates");

const CONTACT_CHANNELS = ["PAYMENT_LINK_WHATSAPP", "VOICE_NUDGE_REGIONAL", "PAYMENT_LINK_SMS", "DUNNING_EMAIL"];

function leaf(node, fallback) {
  return node && typeof node.value === "number" ? node.value : fallback;
}

/**
 * Build the EV policy. Returns a function with the same
 * (record, hist, rates, ctx) shape runBatch expects, so it drops
 * into the identical slot as baselinePolicy and smartPolicy and is
 * gated by the identical firewall.
 *
 * @param {object} a
 * @param {object} a.priors    parsed model/agent-priors.json
 * @param {object} a.bandit    from bandit.js
 * @param {object} a.approvals from approvals.js
 * @param {number} a.ceilingPaise  gates.js autoApprovalCeilingPaise
 * @param {number} a.optOutLossPaise  business estimate of a churned customer
 */
function createEvPolicy({ priors, bandit, approvals, ceilingPaise = 1000000, optOutLossPaise = 48000, hoursPerRound = 30, maxContactsPerCustomer = 4 }) {
  const costOf = {
    RETRY_CHARGE: 0,
    DUNNING_EMAIL: 2,
    PAYMENT_LINK_SMS: 25,
    PAYMENT_LINK_WHATSAPP: 20,
    VOICE_NUDGE_REGIONAL: 320,
  };

  function viability(reason) {
    const t = priors.credential_viability;
    return leaf(t[reason] ?? t._default, 0.8);
  }
  function willingness(reason) {
    const t = priors.willingness;
    return leaf(t[reason] ?? t._default, 1.0);
  }
  function optOutRisk(channel, attemptNo) {
    const t = priors.opt_out_prior;
    const base = leaf(t[channel], 0.015);
    const fatigue = leaf(t.fatigue_multiplier, 1.7);
    return Math.min(1, base * Math.pow(fatigue, Math.max(0, attemptNo - 1)));
  }
  /* Stripe Smart Retries, applied as a belief, not an oracle peek.
     See agent-priors.json's retry_timing_prior for the sourcing —
     this uses the agent's OWN independently-cited numbers, not
     model/base-rates.json's retry_timing_multiplier, even though
     both encode the same real phenomenon (retrying too soon after a
     decline underperforms; waiting roughly 3-7 days is the published
     sweet spot). Only RETRY_CHARGE is timing-sensitive in the real
     model; nudge channels are not, so this never touches them. */
  function retryTimingBelief(record, round) {
    const hours = (record.hours_since_event ?? 48) + round * hoursPerRound;
    const t = priors.retry_timing_prior;
    if (hours < 24) return leaf(t.immediate_lt_24h, 0.75);
    if (hours >= 72 && hours <= 168) return leaf(t.sweet_spot_3_7d, 1.15);
    if (hours > 240) return leaf(t.late_gt_10d, 0.80);
    return leaf(t.default, 1.0);
  }

  return function evPolicy(record, hist, _rates, ctx = {}) {
    const now = ctx.now || new Date();
    const attemptNo = hist.count + 1;
    const amount = record.amount_paise;
    const reason = record.failure?.reason || "_default";
    const cls = bandit.failureClass(record);

    /* ── Merchant-side block: no customer action clears it ──────
       Contacting is pure spend against a zero. Escalate once, then
       stop — this is the one place escalation is genuinely the
       right answer rather than an expensive way to give up. */
    if (reason === "mandate_paused_by_business") {
      return hist.count === 0 ? "ESCALATE_HUMAN" : "WRITE_OFF";
    }

    /* ── Above the ceiling: dual control, then keep working ─────
       Gate 7 will rewrite anything else to ESCALATE_HUMAN anyway,
       so proposing a contact here wastes a round. Ask for review
       explicitly; once approvals.js returns an approval the record
       comes back through this function with `approved` set and is
       worked normally. A rejection is a real decision and ends it. */
    const dec = approvals.decision(record.entity.id);
    const approved = dec?.approved === true;
    if (amount >= ceilingPaise && !approved) {
      if (dec && dec.approved === false) return "WRITE_OFF";
      return "ESCALATE_HUMAN";
    }

    /* ── Quiet hours: switch to the silent channel, do not idle ──
       A retry reaches no one and is legal at 03:00 IST. Spending a
       quiet round on it costs nothing and preserves the daylight
       rounds for contact, instead of proposing a WhatsApp that the
       gate will refuse and burning the round on a NO_ACTION.

       NOTE ON A TRAP: gates.js exports `withinQuietHours`, and it
       returns TRUE when contacting is PERMITTED — it tests the
       09:00-19:00 contact window, not the quiet period its name
       describes. Reading it the way it is named inverts the whole
       schedule: contacts get proposed at 03:00 and retries at
       11:00, the gate blocks every contact, and the arm silently
       sends zero messages while still looking like it ran. That
       happened once while building this file. See FINDINGS.md #6. */
    const canContactNow = withinQuietHours(now);

    /* ── Contact sub-cap: raising the OVERALL attempt ceiling (see
       FINDINGS.md's attempt-cap test) should not silently raise how
       many times a human being gets messaged. gates.js's ceiling is
       a single combined count across every action type — a record
       that spends its extra headroom entirely on silent retries is
       harmless, but the same headroom spent entirely on contact
       looks like exactly the harassment pattern Gate 8 exists to
       prevent. hist.history already carries the action of every
       past attempt (see gates.js's createAttemptLedger), so this
       needs no new state and no change to the safety gate itself —
       it is a policy choosing to be more conservative than the
       floor the gate enforces, which is always allowed. */
    const contactsSoFar = (hist.history || []).filter((h) => CONTACT_CHANNELS.includes(h.action)).length;
    const contactBudgetLeft = contactsSoFar < maxContactsPerCustomer;

    /* Threshold at 0.5, not "greater than zero". An expired card has
       viability 0.02 — technically non-zero because account-updater
       refreshes exist, but charging it is worth ~2% of nothing and
       burns one of four attempts. Charge only where the instrument
       is genuinely likely to be live. */
    const canCharge = viability(reason) >= 0.5 && record.method !== "wallet";
    if (!canContactNow && canCharge && hist.count < 3) return "RETRY_CHARGE";

    /* ── Rank every eligible action by expected value ───────────── */
    const options = [];

    if (canCharge) {
      /* Thompson draw for the charge arm, scaled by how physically
         usable the stored credential is. A retry sends nothing, so
         it carries no opt-out hazard. */
      const p = bandit.sample(cls, "RETRY_CHARGE", record.entity.id, attemptNo) * viability(reason) * retryTimingBelief(record, ctx.round ?? 0);
      options.push({ action: "RETRY_CHARGE", ev: p * amount - costOf.RETRY_CHARGE, p });
    }

    if (canContactNow && contactBudgetLeft && !record.customer?.dnc) {
      const w = willingness(reason);
      for (const ch of CONTACT_CHANNELS) {
        if (w <= 0) continue;
        const p = bandit.sample(cls, ch, record.entity.id, attemptNo) * w;
        const pOut = optOutRisk(ch, attemptNo);
        const ev = p * amount - costOf[ch] - pOut * optOutLossPaise;
        options.push({ action: ch, ev, p });
      }
    }

    /* Nothing legal to do this round (quiet hours, no chargeable
       instrument). Defer rather than terminate — the record keeps
       its remaining attempts for a round when contact is allowed. */
    if (!options.length) return "NO_ACTION";

    options.sort((a, b) => b.ev - a.ev);
    const best = options[0];

    /* ── Stop when the best remaining move loses money ───────────
       Not "stop at attempt N". A ₹90,000 invoice is worth a fourth
       WhatsApp; a ₹180 subscription is not worth a first voice
       call. Below the ceiling there is nothing a reviewer can
       unlock that the automation cannot, and the frozen model
       scores escalation as ₹70 spent for nothing — so the honest
       terminal state here is a write-off, not a costly shrug. */
    if (best.ev <= 0) return "WRITE_OFF";

    return best.action;
  };
}

module.exports = { createEvPolicy, CONTACT_CHANNELS };
