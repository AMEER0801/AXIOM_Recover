"use strict";
/* ══════════════════════════════════════════════════════════════
   DP POLICY — closing the gap to the oracle ceiling
   ──────────────────────────────────────────────────────────────
   oracle-ceiling.js proved something specific: on seed 42, under
   the SAME 8-round/4-attempt/quiet-hours rules this project already
   enforces, the best any policy could do is 70.9% of value. The
   EV+bandit policy in policy-ev.js gets nowhere near that — and the
   gap is not a population problem, it is a POLICY problem, and a
   textbook one: policy-ev.js is a MYOPIC policy.

   ── The mistake, precisely ────────────────────────────────────
   policy-ev.js ranks actions by their own one-shot expected value
   and writes a record off once the best remaining action's EV goes
   negative. But a channel whose single-attempt EV looks marginal
   can still be worth trying, because nudge conversion in this model
   does NOT decay with attempt number the way retry conversion does
   — so four independent tries at a 20%-per-try channel succeed with
   probability 1-(1-0.20)^4 ≈ 59%, not 20%. A greedy one-step
   comparison structurally cannot see this: it only ever asks "is
   the NEXT action worth it," never "is the next FEW actions,
   taken together, worth it." That second question is what a
   Bellman equation answers and a greedy comparison cannot.

   ── The fix: Posterior Sampling for Reinforcement Learning ────
   This is not a bespoke trick — it is PSRL (Osband & Van Roy,
   "(More) Efficient Reinforcement Learning via Posterior Sampling",
   2013), applied per record as a small finite-horizon MDP:

     1. Draw ONE sample from each arm's current Beta posterior
        (bandit.sample — already built, already deterministic and
        seeded, already updated only from observed outcomes).
     2. Treat those samples as if they were the true probabilities
        and solve the FULL remaining-horizon Bellman equation by
        backward induction — same recursion as oracle-ceiling.js,
        just fed beliefs instead of the frozen model's ground truth.
     3. Act on the first step of that plan. Next round, re-sample
        and re-solve — a receding horizon, so every decision uses
        the freshest belief without ever having committed in advance
        to a rigid multi-round script.

   This is provably sound where a greedy policy is not: it explores
   in proportion to genuine uncertainty (an arm nobody has tried
   yet gets a wide, optimistic sample, so the plan tries it) and it
   correctly values a repeated-attempt sequence rather than judging
   each attempt in isolation.

   ── What this policy still does NOT get to see ────────────────
   Beliefs come from agent-priors.json and the bandit's own observed
   outcomes — never model/base-rates.json. The oracle ceiling is a
   bound computed with omniscience for comparison purposes only; this
   policy is scored the same way any other policy here is, blind to
   the answer key. Closing MOST of the gap to the oracle, while
   remaining blind, is the actual claim — not matching it exactly,
   which would require the omniscience this policy is built to do
   without.
   ══════════════════════════════════════════════════════════════ */

const { withinQuietHours } = require("./gates");

const CONTACT_CHANNELS = ["PAYMENT_LINK_WHATSAPP", "VOICE_NUDGE_REGIONAL", "PAYMENT_LINK_SMS", "DUNNING_EMAIL"];
const COST = { RETRY_CHARGE: 0, DUNNING_EMAIL: 2, PAYMENT_LINK_SMS: 25, PAYMENT_LINK_WHATSAPP: 20, VOICE_NUDGE_REGIONAL: 320 };

function leaf(node, fallback) { return node && typeof node.value === "number" ? node.value : fallback; }

/**
 * @param {object} a
 * @param {object} a.priors        parsed model/agent-priors.json
 * @param {object} a.bandit        from bandit.js — supplies posterior samples
 * @param {object} a.approvals     live handle with .decision(id)
 * @param {number} a.totalRounds   the run's total round count (closed over, not
 *                                 re-derived per call, since it's fixed for a run)
 * @param {number} [a.ceilingPaise]
 * @param {number} [a.optOutLossPaise]
 */
function createDpPolicy({ priors, bandit, approvals, totalRounds, ceilingPaise = 1000000, optOutLossPaise = 48000, maxAttempts = 4, hoursPerRound = 30 }) {
  function leafT(node, fb) { return node && typeof node.value === "number" ? node.value : fb; }
  /* Same belief, same sourcing as policy-ev.js's retryTimingBelief —
     see agent-priors.json. Duplicated rather than imported to keep
     these two policy modules independent of each other, matching
     how the rest of this project avoids cross-policy coupling. */
  function retryTimingBelief(record, absoluteRound) {
    const hours = (record.hours_since_event ?? 48) + absoluteRound * hoursPerRound;
    const t = priors.retry_timing_prior;
    if (hours < 24) return leafT(t.immediate_lt_24h, 0.75);
    if (hours >= 72 && hours <= 168) return leafT(t.sweet_spot_3_7d, 1.15);
    if (hours > 240) return leafT(t.late_gt_10d, 0.80);
    return leafT(t.default, 1.0);
  }
  /* Hardcoding this to match gates.js's DEFAULT_POLICY.maxAttemptsPerEntity
     silently breaks the moment someone tests a different cap — exactly
     what happened here: the attempt-ceiling sweep needed this to be a
     parameter, not a literal, so it's one now. */
  function viability(reason) { const t = priors.credential_viability; return leaf(t[reason] ?? t._default, 0.8); }
  function willingness(reason) { const t = priors.willingness; return leaf(t[reason] ?? t._default, 1.0); }
  function optOutRisk(channel, attemptNo) {
    const t = priors.opt_out_prior;
    const base = leaf(t[channel], 0.015);
    const fatigue = leaf(t.fatigue_multiplier, 1.7);
    return Math.min(1, base * Math.pow(fatigue, Math.max(0, attemptNo - 1)));
  }

  /**
   * One finite-horizon Bellman solve using THIS decision's sampled
   * beliefs — small enough (≤8 rounds × ≤4 attempts × 2 opt-out
   * states) to solve exactly, every call, with no approximation.
   * Returns the first action of the optimal plan.
   */
  function planFirstAction({ record, cls, canCharge, canContact, remainingRounds, attemptsUsed, optedOut, entityId, attemptNo0, currentRound }) {
    const amt = record.amount_paise;
    const reason = record.failure?.reason || "_default";
    const via = viability(reason), will = willingness(reason);

    /* Draw once per decision, one sample per arm, reused across every
       node of THIS solve. Retry's TIMING adjustment is deliberately
       NOT baked in here — it varies by which round-offset a node
       represents, so it's applied fresh inside solve() using each
       node's own absolute round, not frozen at decision time like
       the channel/viability factors are. */
    const pRetryBase = canCharge ? bandit.sample(cls, "RETRY_CHARGE", entityId, attemptNo0) * via : 0;
    const chanSamples = {};
    if (canContact) {
      for (const ch of CONTACT_CHANNELS) chanSamples[ch] = bandit.sample(cls, ch, entityId, attemptNo0) * will;
    }

    const memo = new Map();
    const key = (r, a, o) => r * 1000 + a * 10 + o;

    function solve(r, a, o) {
      if (r === 0) return { val: 0, action: "NO_ACTION" };
      const k = key(r, a, o);
      const hit = memo.get(k);
      if (hit) return hit;

      /* This node's real position in the calendar — remainingRounds-r
         rounds have elapsed since the decision that called planFirstAction. */
      const absoluteRound = currentRound + (remainingRounds - r);
      const pRetrySample = Math.min(1, pRetryBase * retryTimingBelief(record, absoluteRound));

      let best = { val: solve(r - 1, a, o).val, action: "NO_ACTION" };

      /* THE BUG, found by tracing a record that should obviously have
         acted and didn't: nudge conversion in this model carries no
         time-dependence — sending WhatsApp in round 1 has the exact
         same sampled probability as sending it in round 7, because
         the probability is drawn once per decision and held fixed
         across the whole plan (by design, for internal consistency —
         see the comment above). That means "act now" and "act on the
         very last possible round" are worth EXACTLY the same to many
         decimal places whenever nothing else forces urgency. A
         strict `>` comparison keeps whichever branch was evaluated
         FIRST on a tie, and NO_ACTION is evaluated first — so ties
         always resolved toward waiting, and since re-planning next
         round draws fresh samples and hits the exact same tie again,
         the policy could defer forever and never act at all. That is
         exactly the "NO_ACTION" storm the trace showed.

         The correct tie-break is the other way: delaying a contact
         only ever COSTS something in this model (opt-out hazard
         compounds with attempt count, and every deferred round is
         one fewer chance if something unexpected ends the record
         early) and buys nothing, since there is no timing upside to
         wait for. So an actionable branch that merely TIES with
         deferral should win, not lose — `>=` on the actionable
         branches, kept strict only where NO_ACTION competes against
         itself (never happens) so this is safe. */
      if (canCharge && pRetrySample > 0 && a < maxAttempts) {
        const cont = solve(r - 1, a + 1, o);
        const val = pRetrySample * amt + (1 - pRetrySample) * cont.val;
        if (val >= best.val) best = { val, action: "RETRY_CHARGE" };
      }

      if (canContact && o === 0 && a < maxAttempts) {
        for (const ch of CONTACT_CHANNELS) {
          const p = chanSamples[ch], po = optOutRisk(ch, a + 1), cost = COST[ch];
          const contStay = solve(r - 1, a + 1, 0), contOptOut = solve(r - 1, a + 1, 1);
          const val =
            p * (amt - cost) +
            (1 - p) * po * (-cost - optOutLossPaise + contOptOut.val) +
            (1 - p) * (1 - po) * (-cost + contStay.val);
          if (val >= best.val) best = { val, action: ch };
        }
      }

      memo.set(k, best);
      return best;
    }

    return solve(remainingRounds, attemptsUsed, optedOut ? 1 : 0).action;
  }

  return function dpPolicy(record, hist, _rates, ctx = {}) {
    const now = ctx.now || new Date();
    const round = ctx.round ?? 0;
    const attemptNo = hist.count + 1;
    const amount = record.amount_paise;
    const reason = record.failure?.reason || "_default";
    const cls = bandit.failureClass(record);

    /* Safety-critical special cases are unchanged from policy-ev.js —
       the DP replaces the CHANNEL-CHOICE reasoning, not the hard
       business rules a merchant actually needs (a merchant-side
       pause, dual control above the ceiling). Those aren't decisions
       to optimize, they're constraints to obey. */
    if (reason === "mandate_paused_by_business") return hist.count === 0 ? "ESCALATE_HUMAN" : "WRITE_OFF";

    const dec = approvals.decision(record.entity.id);
    const approved = dec?.approved === true;
    if (amount >= ceilingPaise && !approved) {
      if (dec && dec.approved === false) return "WRITE_OFF";
      return "ESCALATE_HUMAN";
    }

    const canContactNow = withinQuietHours(now);   // true = inside the allowed contact window (see FINDINGS.md #6)
    const via = viability(reason);
    const canCharge = via >= 0.5 && record.method !== "wallet";

    const remainingRounds = Math.max(0, totalRounds - round);
    const action = planFirstAction({
      record, cls, canCharge, canContact: canContactNow && !record.customer?.dnc,
      remainingRounds, attemptsUsed: hist.count, optedOut: !!record.customer?.dnc,
      entityId: record.entity.id, attemptNo0: attemptNo, currentRound: round,
    });

    /* The plan can legitimately choose NO_ACTION (waiting is
       sometimes optimal — e.g. saving a contact attempt for a later
       round with a better timing multiplier is real for retries,
       and preserving the attempt budget can be too). It never
       silently drops a chargeable quiet-hours round the way a naive
       ladder does: if the plan's answer is NO_ACTION specifically
       because contact is unavailable this round and charging was
       never on the table, fall back to a silent retry when one is
       legal, for the same reason policy-ev.js does. */
    if (action === "NO_ACTION" && !canContactNow && canCharge && hist.count < maxAttempts) return "RETRY_CHARGE";
    return action;
  };
}

module.exports = { createDpPolicy, CONTACT_CHANNELS };
