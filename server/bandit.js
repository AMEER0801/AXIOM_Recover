"use strict";
/* ══════════════════════════════════════════════════════════════
   CONTEXTUAL BANDIT — the part that learns during the run
   ──────────────────────────────────────────────────────────────
   The rule-based smartPolicy in recover.js is a fixed ladder:
   email, then SMS, then WhatsApp or voice, then escalate. It is
   transparent and reproducible, and it is also frozen in the
   author's opinion of which channel works. If that opinion is
   wrong, the ladder is wrong for all 120 records and nothing in
   the run ever finds out.

   This is the correction. Each (failure class x channel) pair is
   an arm with a Beta posterior. Before acting, the policy draws a
   sample from every eligible arm's posterior and ranks by expected
   value; after acting, it feeds the observed outcome back. Arms
   that pay update upward, arms that do not update downward, and
   the ranking changes mid-run.

   ── Why Thompson sampling and not epsilon-greedy ──────────────
   With 120 records and 4 attempts each there are only a few
   hundred decisions in a batch. Epsilon-greedy spends a fixed
   fraction of them on uniformly random arms, which at this sample
   size is a large and pointless tax. Thompson sampling explores in
   proportion to how uncertain an arm is, so a channel that is
   clearly bad stops being tried almost immediately while a channel
   that is merely untested keeps getting sampled. That is the right
   trade when every draw costs real money.

   ── Where the priors come from, and why it matters ────────────
   From model/agent-priors.json — the agent's beliefs — never from
   model/base-rates.json, which is the simulator's hidden truth. A
   policy that read the truth table and argmaxed against it would
   score beautifully and mean nothing: it would be an oracle
   grading its own exam. The priors here are deliberately wrong in
   two places (voice is underestimated, WhatsApp overestimated) so
   that "the bandit corrected a wrong belief" is an observable
   event in the audit chain rather than a claim in a slide.

   ── Determinism ───────────────────────────────────────────────
   Posterior sampling needs randomness, and Math.random() is banned
   project-wide for the reasons in lib/rng.js. Every draw here is
   keyed on (seed, entity, attempt, arm), so a re-run with the same
   seed makes the same exploration decisions and the audit chain's
   head hash still reproduces.
   ══════════════════════════════════════════════════════════════ */

/* ── the attempt-blindness bug, found by tracing a live run ────
   Every arm here was keyed on failureClass alone, for every
   channel including RETRY_CHARGE. That is the right call for a
   nudge — model/response-model.frozen.js applies no attempt-number
   decay to nudge_conversion, so WhatsApp's true conversion at
   attempt 1 and attempt 4 really is the same number, and bucketing
   by attempt there would only fragment scarce data for no
   informational gain.

   RETRY_CHARGE is a different animal. The frozen model buckets
   retry_success_by_attempt into 1 / 2 / 3 / 4+ and the true rate
   falls hard across them (card: 0.22 → 0.13 → 0.07 → 0.03). A
   bandit arm that pools all four attempt numbers into one belief
   necessarily learns something close to the AVERAGE across them —
   which overstates the true rate at attempt 3–4 and understates it
   at attempt 1. Traced on a live run: this is exactly what was
   happening. Approved high-value invoices would use their first
   attempt on a strong nudge channel, then — because the pooled
   retry arm still looked attractive on paper — spend their
   remaining 2–3 attempts on RETRY_CHARGE at a true success rate of
   7–9%, instead of trying a second high-value nudge at its true,
   undiminished ~20–45%. The fix is narrow: bucket the RETRY_CHARGE
   arm by the SAME 1/2/3/4+ buckets the frozen model itself uses,
   and leave every other channel exactly as it was. */
function attemptBucket(n) {
  return n >= 4 ? "4+" : String(Math.max(1, n));
}

/** The effective arm context for a given (base context, channel,
 *  attempt). Only RETRY_CHARGE gets the extra split. */
function armContext(baseCtx, channel, attemptNo) {
  return channel === "RETRY_CHARGE" ? `${baseCtx}|a${attemptBucket(attemptNo)}` : baseCtx;
}

const { rngFor } = require("./lib/rng");

/* ── Beta sampling without a stats dependency ──────────────────
   Beta(a,b) via two Gamma draws: X/(X+Y), X~Gamma(a), Y~Gamma(b).
   Marsaglia-Tsang for Gamma(shape>=1), with the standard boost for
   shape<1. Both a and b stay >= 1 here because priors start at
   `strength` pseudo-counts, but the boost path is kept so a caller
   that lowers prior_strength does not silently get garbage. */
function gammaSample(rand, shape) {
  if (shape < 1) {
    /* Johnk/boost: Gamma(a) = Gamma(a+1) * U^(1/a) */
    return gammaSample(rand, shape + 1) * Math.pow(rand() || 1e-12, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i++) {
    /* Box-Muller for a standard normal; two uniforms per attempt. */
    const u1 = rand() || 1e-12;
    const u2 = rand();
    const x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const vv = Math.pow(1 + c * x, 3);
    if (vv <= 0) continue;
    const u = rand() || 1e-12;
    if (Math.log(u) < 0.5 * x * x + d - d * vv + d * Math.log(vv)) return d * vv;
  }
  return d; /* fell through 64 rejections — vanishingly unlikely; return the mode */
}

function betaSample(rand, a, b) {
  const x = gammaSample(rand, a);
  const y = gammaSample(rand, b);
  const s = x + y;
  return s > 0 ? x / s : a / (a + b);
}

/* ── context bucketing ─────────────────────────────────────────
   The "contextual" half of contextual bandit. Too many buckets and
   every arm has one observation and the posterior never moves; too
   few and genuinely different situations get averaged together.
   Failure class x attempt-parity is the coarsest split that still
   separates the decisions that actually differ. Amount is
   deliberately NOT a bucket dimension — it enters through the
   expected-value multiplication in policy-ev.js instead, where it
   belongs, rather than fragmenting the learning. */
function failureClass(record) {
  const r = record.failure?.reason;
  if (!r) return record.kind === "checkout_abandoned" ? "abandoned" : "overdue";
  if (["card_expired", "card_blocked", "invalid_account"].includes(r)) return "dead_credential";
  if (["mandate_revoked", "mandate_paused_by_customer", "mandate_paused_by_business"].includes(r)) return "mandate";
  if (["gateway_error", "issuer_down", "payment_timeout"].includes(r)) return "infra";
  if (r === "insufficient_funds") return "liquidity";
  if (r === "authentication_failed") return "auth";
  return "other";
}

/**
 * @param {object} priors  parsed model/agent-priors.json
 * @param {number} seed    batch seed; keys every posterior draw
 * @param {boolean} [bucketRetryByAttempt] a tested hypothesis, OFF by
 *   default because it did not survive testing. The reasoning that
 *   motivated it was sound — retry conversion genuinely decays by
 *   attempt (0.22→0.13→0.07→0.03) while nudge conversion does not,
 *   so pooling all attempts into one arm should overvalue late
 *   retries. A controlled A/B on the SAME 20 seeds and SAME warm-up
 *   size the rest of this project reports (8 populations) found the
 *   opposite of an improvement: mean -4.37pp, 95% CI [-9.20,-0.48] —
 *   significantly WORSE, with two seeds dropping over 25 points.
 *   Splitting each arm into four attempt-buckets quarters the
 *   samples each one gets, and at this project's standard warm-up
 *   size that variance cost outweighs the bias it was meant to fix.
 *   At 40 warm-up populations the same A/B lands at -0.02pp, CI
 *   [-2.03, 1.60] — a dead heat, not a win. A hypothesis that needs
 *   5x the data this project standardizes on just to become
 *   harmless, and never becomes a clear improvement even then, does
 *   not earn a place as the default. It is left here, off, so the
 *   next person doesn't have to rediscover this — and doesn't have
 *   to take the rediscovery on faith either, since the A/B script
 *   that produced these numbers ships alongside it (see FINDINGS.md
 *   "attempt-bucketing: tested and reverted").
 */
function createBandit({ priors, seed, bucketRetryByAttempt = false }) {
  const strength = priors.prior_strength.value;
  const arms = new Map();      // "ctx|channel" -> {alpha, beta, pulls, pays}
  const log = [];              // belief revisions worth surfacing in the audit chain

  function key(ctx, channel) { return `${ctx}|${channel}`; }

  function arm(ctx, channel) {
    const k = key(ctx, channel);
    let a = arms.get(k);
    if (!a) {
      const p0 = priors.channel_conversion_prior[channel]?.value ?? 0.10;
      /* alpha+beta = strength, alpha/(alpha+beta) = p0. Both floored
         at 1 so the Gamma sampler stays on its fast path. */
      a = {
        alpha: Math.max(1, p0 * strength),
        beta: Math.max(1, (1 - p0) * strength),
        pulls: 0, pays: 0, prior: p0,
      };
      arms.set(k, a);
    }
    return a;
  }

  return {
    failureClass,

    /** Posterior mean — what the agent currently believes.
     *  attemptNo only matters for RETRY_CHARGE (see armContext);
     *  omit it for a channel where it's meaningless and this
     *  collapses to the old, class-only lookup. */
    believe(ctx, channel, attemptNo = 1) {
      const a = arm(bucketRetryByAttempt ? armContext(ctx, channel, attemptNo) : ctx, channel);
      return a.alpha / (a.alpha + a.beta);
    },

    /** One Thompson draw. Deterministic in (seed, entity, attempt, ctx, channel). */
    sample(ctx, channel, entityId, attemptNo) {
      const effCtx = bucketRetryByAttempt ? armContext(ctx, channel, attemptNo) : ctx;
      const a = arm(effCtx, channel);
      const rand = rngFor(seed, "bandit", entityId, attemptNo, effCtx, channel);
      return betaSample(rand, a.alpha, a.beta);
    },

    /** Feed back one observed outcome. attemptNo is now REQUIRED —
     *  every existing caller (recover2.js) already has it at hand
     *  (hist.count + 1, the same number it hands to resolve()), so
     *  this is a call-site addition, not new information to find. */
    update(ctx, channel, paid, attemptNo) {
      const effCtx = bucketRetryByAttempt ? armContext(ctx, channel, attemptNo) : ctx;
      const a = arm(effCtx, channel);
      const before = a.alpha / (a.alpha + a.beta);
      a.pulls += 1;
      if (paid) { a.alpha += 1; a.pays += 1; } else { a.beta += 1; }
      const after = a.alpha / (a.alpha + a.beta);
      if (a.pulls >= 5 && Math.abs(after - a.prior) > 0.05) {
        log.push({ ctx: effCtx, channel, pulls: a.pulls, prior: a.prior, belief: after, moved: after - a.prior });
      }
      return { before, after };
    },

    /** Everything the run learned, for the report and the audit chain. */
    snapshot() {
      const rows = [];
      for (const [k, a] of arms) {
        if (!a.pulls) continue;
        const [ctx, channel] = k.split("|");
        rows.push({
          ctx, channel, pulls: a.pulls, pays: a.pays,
          observed: a.pays / a.pulls,
          prior: a.prior,
          posterior: a.alpha / (a.alpha + a.beta),
        });
      }
      return rows.sort((x, y) => y.pulls - x.pulls);
    },

    /** Deduplicated belief revisions — the "it changed its mind" evidence. */
    revisions() {
      const last = new Map();
      for (const r of log) last.set(`${r.ctx}|${r.channel}`, r);
      return Array.from(last.values()).sort((a, b) => Math.abs(b.moved) - Math.abs(a.moved));
    },
  };
}

module.exports = { createBandit, failureClass, betaSample };
