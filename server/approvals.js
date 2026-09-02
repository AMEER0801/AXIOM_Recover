"use strict";
/* ══════════════════════════════════════════════════════════════
   APPROVAL QUEUE — dual control that finishes the sentence
   ──────────────────────────────────────────────────────────────
   gates.js Gate 7 does the right thing and then stops halfway.
   Any action on a record at or above the ₹10,000 ceiling is
   converted to ESCALATE_HUMAN — correct, that is what dual control
   means. But ESCALATE_HUMAN is in recover.js's TERMINAL set, so
   the record is marked resolved and never worked again, and the
   frozen response model explicitly declines to model a human as an
   outcome generator. The two decisions compose into something
   neither intended:

       amount >= ₹10,000  ->  human review  ->  nothing, forever

   On the seed-42 batch that silently condemns 24 records holding
   ₹15,08,113 — ninety-three percent of every rupee at risk. The
   headline recovery rate never shows it, because the rate is
   counted per record and those 24 records are only twenty percent
   of the count. See FINDINGS.md #1.

   ── What dual control actually means ──────────────────────────
   In a real collections desk, "this needs a human" is the start of
   a workflow, not the end of one. A reviewer looks at the record,
   approves or rejects it, and an approved record goes back into
   automated collection with the approval attached. The control is
   that a person decided — not that the money was abandoned.

   This module is that missing step. A ceiling-triggered escalation
   parks the record in a queue; a reviewer resolves it after a
   configured latency; approved records become eligible again with
   `approved_up_to_paise` set, which lets Gate 7 pass on subsequent
   rounds. Rejected records are written off, which is a real
   outcome and is recorded as one.

   ── Why the approval numbers live in agent-priors.json ────────
   Approval rate and reviewer latency are operating procedure. They
   describe how the merchant staffs a desk, not how a customer
   behaves. Putting them in base-rates.json would mean changing a
   staffing assumption invalidates the frozen customer model's
   hash, which is both wrong and would make the freeze useless as a
   signal. They are configuration; they are swept in sweep.js; and
   the sensitivity of the headline number to them is reported
   rather than buried.

   ── The cost is billed ────────────────────────────────────────
   Every review costs reviewer time and that time is charged to the
   arm that requested it. recover.js does not do this today: it
   computes the escalation cost in gates.js's estimateCost(), puts
   it in the audit chain, and then never adds it to the spend
   tracker, because ESCALATE_HUMAN is not in its ACTING set. On
   seed 42 that hands the smart arm ₹5,460 of free labour against
   the baseline's ₹1,960 — inflating the reported delta by ₹3,500.
   See FINDINGS.md #2.
   ══════════════════════════════════════════════════════════════ */

const { rngFor } = require("./lib/rng");

/**
 * @param {object} a
 * @param {object} a.priors   parsed model/agent-priors.json
 * @param {number} a.seed     batch seed; keys the approve/reject draw
 */
function createApprovalQueue({ priors, seed }) {
  const cfg = priors.approval_workflow;
  const approvalRate = cfg.approval_rate.value;
  const latency = cfg.approval_latency_rounds.value;
  const reviewCost = cfg.review_cost_paise.value;

  const pending = new Map();   // entityId -> {requestedRound, amount_paise, action}
  const decided = new Map();   // entityId -> {approved, round, amount_paise}
  let reviewsRequested = 0;
  let approvedCount = 0;
  let rejectedCount = 0;

  return {
    reviewCostPaise: reviewCost,

    /** Has this record already been through review? */
    isDecided(entityId) { return decided.has(entityId); },
    isPending(entityId) { return pending.has(entityId); },
    decision(entityId) { return decided.get(entityId) || null; },

    /**
     * Park a record for review. Idempotent: a record already queued
     * or already decided is not re-queued, so a policy that keeps
     * proposing while a review is outstanding cannot bill the desk
     * twice for the same record.
     * @returns {{queued:boolean, costPaise:number}}
     */
    request(entityId, { round, amountPaise, action }) {
      if (pending.has(entityId) || decided.has(entityId)) return { queued: false, costPaise: 0 };
      pending.set(entityId, { requestedRound: round, amount_paise: amountPaise, action });
      reviewsRequested += 1;
      return { queued: true, costPaise: reviewCost };
    },

    /**
     * Advance the desk to `round` and resolve anything whose latency
     * has elapsed. Called once per round by the runner.
     * @returns {Array<{entityId:string, approved:boolean, amount_paise:number}>}
     */
    tick(round) {
      const resolvedNow = [];
      for (const [entityId, req] of pending) {
        if (round - req.requestedRound < latency) continue;
        /* Keyed on the entity, not on call order — so the same record
           gets the same verdict regardless of which arm is running or
           what else is in the queue. */
        const rand = rngFor(seed, "approval", entityId);
        const approved = rand() < approvalRate;
        decided.set(entityId, { approved, round, amount_paise: req.amount_paise });
        pending.delete(entityId);
        if (approved) approvedCount += 1; else rejectedCount += 1;
        resolvedNow.push({ entityId, approved, amount_paise: req.amount_paise });
      }
      return resolvedNow;
    },

    /**
     * Anything still queued when the run ends. A record sitting in
     * an unresolved review is NOT a failed recovery and must not be
     * reported as one — it is work in progress, and the runner
     * surfaces it separately for exactly the same reason recover.js
     * surfaces `stillInProgress`.
     */
    outstanding() {
      return Array.from(pending.entries()).map(([entityId, r]) => ({ entityId, ...r }));
    },

    stats() {
      return {
        reviews_requested: reviewsRequested,
        approved: approvedCount,
        rejected: rejectedCount,
        still_pending: pending.size,
        review_cost_paise: reviewsRequested * reviewCost,
        approval_rate_config: approvalRate,
        latency_rounds_config: latency,
      };
    },
  };
}

module.exports = { createApprovalQueue };
