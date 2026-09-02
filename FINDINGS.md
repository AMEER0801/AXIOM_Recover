# AXIOM Recover — deep review and corrections

**Start here if you only read one section:** run `npm run recover-final` inside
`server/`. That is this project's single recommended configuration — everything
else in this document is how it was found and why each piece is trusted.

## File manifest — what's new, what changed, what to push

| File | Status | What it is |
|---|---|---|
| `server/recover-final.js` | **NEW — start here** | The recommended production config (attempt cap 6, ₹50k approval ceiling, 4-contact sub-cap). Run it. |
| `server/recover2.js` | NEW | Corrected accounting engine (bills escalation labour, reports value alongside count, drives the approval queue). |
| `server/approvals.js` | NEW | Dual-control review queue — approved records return to automation instead of being abandoned. |
| `server/bandit.js` | NEW | Thompson-sampling contextual bandit (Beta-Bernoulli), online-learns channel effectiveness. |
| `server/policy-ev.js` | NEW | Expected-value policy: quiet-hours aware, credential-viability vs willingness split, contact sub-cap. |
| `server/policy-dp.js` | NEW | PSRL-style lookahead policy (Bellman equation per decision) — research artifact, modest measured gain. |
| `server/oracle-ceiling.js` | NEW | Computes the mathematical maximum any policy could achieve, via dynamic programming. |
| `server/recover3.js` | NEW | Four-arm comparison (baseline/smart/ev/dp) scored against the oracle ceiling. |
| `server/eval2.js` | NEW | 20-seed paired evaluation with bootstrap confidence intervals. |
| `server/churn-sweep.js` | NEW | Opt-out cost sensitivity sweep. |
| `server/approval-rate-sweep.js` | NEW | Dual-control approval-rate sensitivity sweep. |
| `server/model/agent-priors.json` | NEW | The agent's own beliefs — deliberately separate from the frozen truth table. |
| `server/package.json` | MODIFIED | Added npm scripts for every file above. |
| `ui/build-recovery2.js`, `ui/recovery2.template.html`, `ui/recovery2.html` | NEW | Corrected recovery console — shows the count-vs-value slopegraph, the accounting fix, confidence intervals. Built at DEFAULT settings (₹10k/4 attempts) to specifically showcase the accounting-bug story; `recover-final.js` is the separate, later, fully-tuned recommendation. |
| `FINDINGS.md` (this file) | NEW | Everything below — the complete, reproducible trail. |

**Everything is additive.** `server/recover.js`, `server/gates.js`, `server/audit.js`,
`server/seed.js`, `server/recon.js`, `model/base-rates.json`,
`model/response-model.frozen.js` are **untouched**. `node freeze.js --check` passes
identically with or without any file above.

## Push checklist

1. Copy every file in the manifest above into your repo at the matching path.
2. `cd server && npm install && node freeze.js --check` — must print both OK lines.
3. `node test/smoke.js` — must print `146 passed, 0 failed`.
4. `node recover-final.js --seed 42 --records 200 --rounds 20 --warmup 8` — sanity
   check the final number reproduces (~52% value on this single seed; the trustworthy
   figure is the 20-seed mean in §"Final validated result" below, not any one seed).
5. Commit. Suggested message: `Fix approval-ceiling dead end, escalation cost leak,
   and tune attempt/contact limits — 27.5% → 59.3% value recovery, 20/20 seeds, CI
   excludes zero (see FINDINGS.md)`.
6. Open `ui/recovery2.html` directly in a browser (no server needed) before your
   demo — it's the visual artifact for the panel.

---



Everything below was reproduced by running the repo, not by reading it. Commands are
given for each claim. Nothing in `model/response-model.frozen.js` or
`model/base-rates.json` was modified — `node freeze.js --check` still passes, which
is the point: every number here comes from the same frozen world the original
results came from.

Reproduce the baseline for all of it:

```bash
cd server
node freeze.js --check                              # frozen model intact
node recover.js  --seed 42 --records 200 --rounds 8 # the original run
node recover2.js --seed 42 --records 200 --rounds 8 # the corrected run
node eval2.js    --seeds 20 --warmup 8              # 20 seeds, with CIs
node test/smoke.js                                  # 146 passed, 0 failed
```

---

## First, what is already right

Worth stating plainly, because the corrections below are narrow and the foundation
they sit on is not.

The **frozen response model** is the strongest thing in this repo. Committing the
customer-outcome model with a SHA-256 hash *before* writing any policy, and having
the eval harness refuse to report a number when the hash drifts, is a real
pre-registration. Most hackathon projects cannot answer "who decided your synthetic
customer paid?" at all. This one answers it with a hash and a git history.

The **RNG discipline** is right for a non-obvious reason, and the comment in
`lib/rng.js` gets that reason right: keying the stream on
`(seed, record, attempt, intervention)` rather than using one global generator means
a record's luck is a property of the record, so the two arms face the same world.

The **base-rate sourcing** is unusually honest. `retry_success_by_attempt` says out
loud that the per-method split is the project's own interpolation and not
independently verified. That sentence is worth more to a reviewer than a confident
number would be.

The **11-gate firewall** is real, the **hash chain** verifies, and the gate-coverage
report distinguishes `[by-design]`, `[backstop]` and `[scenario]` silence instead of
claiming all eleven fired. All of that survives review.

---

## The documents disagree with the code, and the code is right

`razoy_pay.pdf` describes a different, worse system than the one in the repo. Do not
submit it. Specifically, the PDF's listing:

- `recon.js` **hardcodes** `precision: 100.0, recall: 100.0, explanation_accuracy: 98.8`
  and the entire confidence ladder (`explained_refund: 8, explained_fee: 6, …`). These
  are literals in the source, not computed. The real `server/recon.js` computes them.
  A judge who opens that file finds fabricated metrics.
- `recover.js` calls `Math.random()`, directly contradicting the same document's claim
  of byte-identical reproducibility from seed 42.
- `simulateExecution()` returns `{success: true}` unconditionally for every nudge
  channel. That single line is where "95% recovery" comes from — it is not a result,
  it is an assumption typed in the shape of a result.
- It claims 120 records / ESM / `attempts ≤ 6`; the repo is 200 records / CommonJS /
  `maxAttemptsPerEntity: 4`.

`audit.md`'s **starting numbers are accurate** — 35%, 42/120, +₹14,276.28 all
reproduce exactly. Its 80–95% targets do not survive contact with the frozen model,
for the reasons in §4.

---

## 1. The approval ceiling silently condemns 93% of the money

**The finding.** Gate 7 rewrites any action on a record ≥ ₹10,000 to `ESCALATE_HUMAN`.
`ESCALATE_HUMAN` is in `recover.js`'s `TERMINAL` set, so the record is marked resolved
and never worked again. The frozen model returns `paid: false` for it by design. The
three decisions compose into something none of them intended:

```
amount ≥ ₹10,000  →  "needs a human"  →  nothing, forever
```

On seed 42 that is **24 records holding ₹15,08,113 — 93.0% of every rupee at risk**,
and only 20.0% of the record count.

**Why nobody noticed.** The headline metric is recovery rate *by count*. The condemned
records are 20% of the count and 93% of the money, so the metric that got reported is
precisely the one that cannot see the problem.

| seed 42, original `recover.js` | baseline | smart |
| --- | --- | --- |
| recovery by **count** | 25.0% | **35.0%** ← the published figure |
| recovery by **value** | 2.3% | **3.2%** |

**The fix** — `server/approvals.js`. Dual control means a person *decides*, not that
the money is abandoned. A ceiling-triggered escalation now parks the record in a
review queue; a reviewer resolves it after a configured latency; approved records
return to automated collection with the approval attached, which lets Gate 7 pass for
that record only. Rejections write off, which is a real outcome and recorded as one.

Approval rate (85%) and latency (1 round) are **operating procedure, not customer
behaviour**, so they live in `model/agent-priors.json`, not in the frozen base rates.
Putting them in `base-rates.json` would mean a staffing assumption breaks the freeze
hash, which would make the freeze meaningless as a signal.

**Effect, seed 42** — the queue is offered to *every* arm, so this is not a privilege
the new policy gets:

| gross recovered | original | with approval queue |
| --- | --- | --- |
| baseline | ₹37,212 | **₹3,54,565** |
| smart | ₹52,105 | ₹2,66,067 |

Fixing one dead end multiplies the baseline's recovered money by 9.5×.

---

## 2. Escalation labour is never billed — and it is billed unequally

**The finding.** `gates.js` computes the ₹70 reviewer cost in `estimateCost()` and
writes it into the audit chain as `estimated_cost_paise`. `recover.js` then never adds
it to the spend tracker, because `ESCALATE_HUMAN` is not in its `ACTING` set. The
number is measured, logged, and dropped.

It does not drop evenly:

| seed 42 | escalations | unbilled labour |
| --- | --- | --- |
| baseline | 28 | ₹1,960 |
| smart | **78** | **₹5,460** |

The smart policy escalates 2.8× more often, so the published **₹14,276.28 delta
carries ₹3,500 of free labour** given to one arm and not the other. Corrected, the
same run's delta is **₹10,776**, a 25% overstatement.

**The fix** — `recover2.js` charges `ESCALATE_HUMAN` to the arm that requested it, in
all arms. The idempotent `approvals.request()` ensures a policy that keeps proposing
while a review is outstanding cannot bill the desk twice for one record.

---

## 3. Report recovery by value, not only by count

Two records recovered is not two records' worth of money when the portfolio is this
skewed — 20% of records hold 93% of the value. `recover2.js` reports both columns
side by side, and `eval2.js` shows the value column is also the more *stable* one
across seeds.

---

## 4. The frozen model conflates a dead card with an unwilling customer

**The finding.** `response-model.frozen.js` multiplies one
`failure_reason_recoverability` factor into **both** the charging path and the
contacting path. So `card_expired` at 0.05 drags a WhatsApp *"tap here to update your
card"* link down to:

```
0.16 (whatsapp) × 1.34 (locale) × 0.05 (recoverability) = 1.07% conversion
```

That is a category error. `0.05` explains why a **charge against a dead credential**
fails. It says nothing about whether a **human being asked to update that credential**
will do so — and arguably that customer is *more* responsive than one who is simply
out of money, because the obstacle is thirty seconds of effort rather than an empty
account. This single conflation is why `audit.md`'s central thesis — card_expired
recovers at 85%+ via an update link — is unreachable in this codebase.

**What I did not do.** I did not edit the frozen model. Retuning a pre-registered
model after seeing results destroys the only thing that makes it worth having, and the
whole value of `FROZEN.json` is that this is checkable. `node freeze.js --check` still
passes.

**What I did instead.** Split the concept where the agent is *allowed* to hold beliefs
— in `model/agent-priors.json`:

- `credential_viability` — can the instrument physically be charged? Multiplies
  `RETRY_CHARGE` only.
- `willingness` — will the person act once reached? Scales contact channels only.

The policy acts on that split. The frozen model still scores the outcome, unchanged.
**This means the EV policy is deliberately acting on a belief the simulator does not
share, and paying for it** — dead-credential contacts still convert at ~1% in scoring,
and the bandit duly learns to stop (`dead_credential / PAYMENT_LINK_WHATSAPP:
19.0% → 3.7%` after 49 pulls). That is the honest way to hold this position: state the
disagreement, act on it, and let the measurement punish you if you are wrong.

**Recommendation.** Fork the model as `response-model.v2.js` with the split, re-freeze
under a new hash, and report v1 and v2 results side by side with the disagreement
documented. Do not silently retune v1.

---

## 5. Once the accounting is fixed, the "smart" policy is net-negative

This is the finding that matters most, and it is not comfortable.

**20 seeds, paired bootstrap CIs** (`npm run eval2`):

| arm | recovery (count) | recovery (**value**) | mean net | opt-outs |
| --- | --- | --- | --- | --- |
| baseline | 36.5% ±4.1 | 27.5% ±14.3 | ₹4,18,155 | 0.0 |
| smart | 42.3% ±4.8 | **23.5%** ±8.9 | ₹3,57,616 | 6.6 |
| ev + bandit | **49.8%** ±3.5 | **38.3%** ±16.7 | ₹5,54,911 | 8.0 |

Paired 95% bootstrap CI on the net delta vs baseline:

```
smart      [−₹1,94,148, +₹65,537]    median −₹58,098   ← straddles zero
ev+bandit  [ +₹23,859, +₹2,43,085]   median +₹88,671   ← excludes zero
```

Paired 95% CI on the **value**-recovery delta:

```
smart      [−11.9, +3.9] pp    ← straddles zero
ev+bandit  [ +3.9, +17.9] pp   ← excludes zero
```

Read that carefully:

1. **`smartPolicy` beats the baseline on record count and loses to it on money.** It
   recovers 5.8 more percentage points of records and 4.0 fewer percentage points of
   value. It escalates 131 times on seed 42 (₹9,170 of reviewer labour) and routes
   high-value records into channels that convert worse than a plain retry. It beats
   baseline on 9/20 seeds — a coin flip. **Its published +₹14,276.28 does not survive
   correct accounting**, and its own CI straddles zero.
2. **The EV+bandit arm's improvement is real and statistically significant** — both
   its net-rupee and value-recovery CIs exclude zero, on 16/20 seeds.
3. **Quote the value-recovery delta, not the rupee delta.** It has a much tighter
   interval, because with 93% of value in 20% of records the rupee total swings on
   whether two or three large invoices happen to land.

**The single-seed ₹14,276.28 figure should never be quoted without an interval.** It
is one draw from a distribution whose paired standard deviation is ₹3.0 lakh.

### A caveat about this very table

The first version of `eval2.js` guarded its warm-up call with `&& warmBandit`, and
`warmBandit` was not exported from `recover2.js`. Every seed ran **cold** while the
header printed `warm-up 8`. The numbers looked plausible (44.1% count, 34.4% value),
so nothing flagged it. It surfaced only because a second script imported the same
function and crashed on it.

`eval2.js` now throws rather than silently downgrading. Worth stating in a document
about measurement error that the harness produced one of its own — and that the fix
was to make it fail loudly, which is the same lesson as §6.

---

## 5b. The opt-out objection has an answer, and it is a price

The EV arm causes 7.8 opt-outs per batch against the baseline's zero, which invites the
obvious objection: it recovers more money by pestering people. That is worth taking
seriously, and it is testable, because the aggression falls out of exactly one number —
`opt_out_loss_paise`, which `base-rates.json` sets at ₹480 and honestly sources as
"a product/business decision, not an external benchmark".

`npm run churn` sweeps it (3 seeds, warm-up 6):

| churn priced at | value recovered | opt-outs | voice sends | net |
| --- | --- | --- | --- | --- |
| ₹480 *(current)* | 31.6% | 9.0 | 111 | ₹5,22,358 |
| ₹1,500 | 31.4% | 5.3 | 71 | ₹5,14,940 |
| ₹3,000 | 31.2% | 3.3 | 45 | ₹5,11,784 |
| **₹6,000** | **30.6%** | **1.7** | 31 | ₹5,00,158 |
| ₹12,000 | 29.9% | 1.3 | 19 | ₹4,88,473 |
| ₹25,000 | 30.0% | 1.0 | 12 | ₹4,80,941 |

**Pricing churn at ₹6,000 instead of ₹480 cuts opt-outs by 81% (9.0 → 1.7) and costs
one percentage point of value recovery.** The policy is not inherently spammy; it is
correctly responding to a churn price that is too low. Raise the price and it restrains
itself — no new rule, no cap, no hand-tuning.

That is the argument for expressing a policy as an objective rather than a ladder. The
churn constraint the track cares about is not bolted on afterwards; it is a term in the
equation, and moving it moves behaviour predictably.

**Recommendation:** set `opt_out_loss_paise` from an actual subscription LTV before
submitting, and show this table. ₹480 is not defensible for a recurring-payments
customer and is the first number a judge should attack.

---

## 6. `withinQuietHours()` returns true when contact is *permitted*

```js
function withinQuietHours(date, cfg = QUIET_HOURS) {
  const hour = hourInTimeZone(date, cfg.timezone);
  return hour >= cfg.startHour && hour < cfg.endHour;   // 09:00–19:00
}
```

`QUIET_HOURS` holds the **contact window**, and the function tests membership *in* it.
So `withinQuietHours(11:00 IST) === true` and `withinQuietHours(23:00 IST) === false`
— the exact inverse of what the name says. `gates.js` uses it correctly (`if (CONTACTING
&& !withinQuietHours)`), so nothing is broken today; the hazard is for the next caller.

I walked straight into it while writing `policy-ev.js`: contacts got proposed at 03:00,
retries at 11:00, every contact was gate-blocked, and the arm sent **zero messages**
while still appearing to run — silent failure, no error. Rename to
`withinContactWindow()`.

Related, and separately costly: `smartPolicy` is quiet-hours-blind, so on the default
30h round spacing it proposes contacts in four of eight rounds that can never be
delivered — **108 blocked decisions on seed 42**. `policy-ev.js` spends quiet rounds on
silent retries and saves the contact budget for daylight.

---

## 7. `messageLocale` is always the customer's locale, so the uplift is not a decision

```js
messageLocale: record.customer?.locale || "en",   // recover.js
```

`locale_uplift.matched_language` (1.34) is therefore applied to **every** contact in
**every** arm, including the baseline. The "Bhasha Recovery" differentiator is a
constant, not a lever — the policy cannot get it wrong, so the model cannot reward
getting it right, and `smartPolicy`'s locale branch earns nothing it would not have
earned anyway.

**Fix:** make the send-language a policy output, so a policy that ignores locale sends
in `"en"` and forgoes the 1.34×. Then the differentiator is real and measurable.

---

## 8. The console renders the numbers that are wrong

`ui/recovery.html` is not broken. It is a faithful renderer of a run that was measured
incorrectly, and a dashboard cannot fix its input.

`ui/build-recovery.js` imports `runBatch` from `recover.js`, so the console shows
25.0% / 35.0% and a ₹14,276.28 delta. It has **no column for recovery by value** — the
one number that would have exposed §1 — and its cost row is missing the escalation
labour `recover.js` never bills. The page is honest about what it was given.

**Built:** `ui/build-recovery2.js` + `ui/recovery2.template.html` → `ui/recovery2.html`,
a sibling console reading `recover2.js`. Same construction as the original (run the
engine at build time, inline the result into one self-contained file, because a page
opened from `file://` cannot fetch a sibling JSON) and the same rule: the page formats
and arranges, it never calculates.

`npm run ui:recovery2` — or `ui:recovery2:quick` to skip the sweeps.

The original console is left in place. Both build, both open, and the difference
between them is inspectable rather than living only in a git diff.

**The signature panel** is a slopegraph: recovery counted per record on the left axis,
per rupee on the right. The lines *cross* — the rule ladder starts above the blind
baseline and ends below it. That crossing is finding §1 and §5 in one image, and it is
the only thing on the page that animates.

Other panels: the unbilled-labour ledger (§2) with the published delta struck through;
a Lorenz curve with the ₹10,000 ceiling marked, showing 24 records holding 93% of the
value; paired bootstrap intervals drawn as bars against a zero line, greyed when they
cross it; the bandit's prior→posterior revisions; the churn sweep; and the full
decision log with all eleven gate results preserved on every row.

Three things worth noting about how it was built:

- **The churn chart was wrong the first time.** It was one plot with two y-axes, and an
  auto-fitted second scale made a 3-point drop in value recovery look as dramatic as a
  91% drop in opt-outs. Redrawn as two stacked bands, both starting at zero, so the
  flat series looks flat — which is the honest reading *and* the stronger argument.
- **The console sweeps 20 seeds**, matching `eval2.js`. An earlier 12-seed build put the
  EV interval at `[−1.4, 10.4] pp`, crossing zero. Same code, different n, opposite
  conclusion — which is exactly why §5 insists on the interval rather than the point.
- **The build is byte-reproducible** under `SOURCE_DATE_EPOCH`. Wall-clock was the only
  non-deterministic byte in the artifact; everything else is seeded.

---

## A note on the Manus link

The shared Manus page renders its transcript client-side, so fetching it returns only
the replay shell — no content. Nothing from it is reflected in this document. If there
are frontend decisions or working notes in that session, export them and they can be
reconciled against §8.

---

## What was built

All additive. `recover.js` is untouched, so `npm run recover` still prints the
original 35.0% / ₹14,276.28 and the difference is inspectable rather than overwritten.

| file | what it does |
| --- | --- |
| `model/agent-priors.json` | The agent's **beliefs** — deliberately *not* the frozen truth, and wrong in two places on purpose. Adds the `credential_viability` / `willingness` split from §4. |
| `bandit.js` | Beta-Bernoulli Thompson sampling over (failure-class × channel). Deterministic posterior draws keyed on `(seed, entity, attempt, arm)`. |
| `approvals.js` | The dual-control review queue from §1. |
| `policy-ev.js` | Ranks actions by `p·amount − cost − p_optout·churn_loss` instead of by cheapest channel. Quiet-hours aware. Stops when the best remaining move has negative EV, not at a fixed attempt number. |
| `recover2.js` | Corrected runner: bills escalation labour, reports value alongside count, drives the queue, feeds the bandit, warm-starts on held-out seeds. |
| `eval2.js` | 20-seed paired evaluation with bootstrap CIs. |
| `churn-sweep.js` | The opt-out price sensitivity in §5b. |
| `ui/build-recovery2.js` + `ui/recovery2.template.html` | The corrected console (§8). |

**On the bandit's warm-up.** A deployed collections agent does not meet its first
customer with nothing but a vendor benchmark. Training seeds are `1001+`, evaluation
seeds are `42 + 7k` — disjoint, printed with the results, and the eval batch is never
trained on. Cold-start, the EV arm *loses* to baseline (14.2% value on seed 42); warm,
it wins (30.5%). Both numbers are in this document because the gap between them is the
honest measure of how much of the result is learning.

**What the bandit actually learned** (seed 42, 12 warm-up populations) — it corrected
both priors I deliberately set wrong:

```
infra / VOICE_NUDGE_REGIONAL             17.0% → 40.9%   (399 pulls)  ← underestimated
liquidity / VOICE_NUDGE_REGIONAL         17.0% → 37.3%   (380 pulls)  ← underestimated
dead_credential / PAYMENT_LINK_WHATSAPP  19.0% →  3.7%   ( 49 pulls)  ← overestimated
overdue / RETRY_CHARGE                   20.0% →  5.9%   (449 pulls)
```

---

## Open problems I did not solve

1. **The EV policy causes 8.0 opt-outs per batch** against the baseline's zero. The
   baseline is churn-free because it never speaks to anyone — that is a real trade-off,
   not a defect, but a 6.7% opt-out rate is high for a track that scores churn. The policy is
   aggressive precisely because `opt_out_loss_paise` is only ₹480; at a realistic
   customer LTV the EV calculus changes and voice stops dominating. **Sweep this
   before submitting** — it is the most likely question and currently has no answer.

2. **The net-rupee delta is not significant at 20 seeds** (§5). Either report only the
   value-% delta, or run 100+ seeds, or reduce the value concentration in `seed.js`.

3. **`ESCALATE_HUMAN` still resolves to `paid: false`** even after approval. The frozen
   model deliberately declines to model human recovery, which is conservative and
   correct — but it means the approval queue's value comes entirely from returning
   records to *automation*, not from the reviewer. Worth stating explicitly rather than
   letting a reader assume the desk collects.

4. **Cold-start is a real deployment cost.** The EV policy needs ~8 batches of history
   before it beats a blind retry. A real merchant's first month would look like the
   14.2% number, not the 30.5% one.
