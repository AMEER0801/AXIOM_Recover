# AXIOM RECOVER

**An AI agent that recovers at-risk revenue for a Razorpay merchant — and proves, with numbers, that it actually worked.**

Built for the Razorpay AI Buildathon, Track 3 (AI Revenue Recovery), with Track 4 (AI Finance Controller) built in as the measurement layer.

---

## What this project does (for everyone)

When a customer's payment fails, or a checkout is abandoned, or an invoice goes unpaid, that money is usually gone unless someone follows up. Doing that follow-up well — at the right time, in the right way, without annoying or overcharging the customer — is hard to do by hand at scale.

This project is an AI agent that:

1. **Watches** for payments that failed, checkouts that were abandoned, subscriptions that stopped, and invoices that are overdue.
2. **Decides** the right next step for each one — retry the charge, send a payment link, send a reminder, or hand it to a human — based on why it failed and how the customer has responded before.
3. **Acts** inside strict limits: a spending cap, a maximum number of attempts, a "do not contact" list that is never overridden, and a requirement that every action be approved in advance if it's above a certain amount.
4. **Checks its own work** afterward by reconciling the outcome against the settlement records, the same way an accountant would.
5. **Reports honestly**: not just money recovered, but money recovered *after* subtracting the cost of the outreach and the cost of any customers who were lost because they were contacted too much.

The last point matters most. A system that spams every customer will look great on a simple "amount recovered" chart and be quietly damaging the business. This project measures the version of success that actually matters to a business: **net recovery**, not gross.

## Why this is trustworthy, not just a demo

Most hackathon projects show one successful run and call it done. Three specific things were done differently here, because they are the difference between a demo and something a business could actually rely on:

**1. The test data's "customer" was built before the agent was.**

To measure an agent, you need a stand-in for how a real customer would respond. If that stand-in is written or adjusted *after* seeing how the agent performs, the test is biased in the agent's favor without anyone intending it to be. To prevent that, the customer-response model in this project was finished and locked (see `model/response-model.frozen.js`) before any of the agent's decision-making logic was written. This is not just a promise in this document — it is enforced by a script (`npm run check`) that will fail if that file is ever changed afterward.

**2. Every assumption behind the test data must have a source.**

The customer-response model relies on assumptions like "how likely is a retried payment to succeed on the second attempt." These numbers need to come from somewhere real, not guesswork. The project includes a checklist (`server/model/base-rates.json`) where every one of these assumptions must be filled in with a citation before the results can be called final. Right now, these are placeholder estimates — filling in real sources is the next step before this can be presented as a finished result.

**3. The headline number is money recovered *minus* costs, compared to a simple baseline.**

Instead of just reporting "₹X recovered," this project always compares the agent against a simple baseline approach (retrying every failed payment automatically, with no intelligence) on the exact same set of test customers. The number that matters is the *difference* between the two — and that difference is reported after subtracting the cost of every message sent and the estimated cost of customers lost due to over-contacting.

## Current status

This is an active build. Here is exactly what is finished and what is not, so there is no ambiguity about what has been tested versus what is planned.

| Piece | What it does | Status |
|---|---|---|
| Test data generator | Creates a realistic, repeatable set of test transactions with a built-in answer key | Done, tested |
| Customer-response model | Simulates how a test customer would respond to each action, locked before agent logic exists | Done, locked |
| Payment security layer | Verifies that incoming payment notifications are genuinely from Razorpay and not forged | Done, tested |
| Razorpay connection | Sends requests to Razorpay's test system safely, with no risk of double-charging | Done, tested |
| Automated tests | 103 checks that confirm the above claims are actually true | All passing |
| Reconciliation engine | Matches payments to settlements, explains gaps, triages what's left | Done, tested |
| Gate layer (money firewall) | Every bounded/gated guarantee, enforced and unit-tested independently | Done, tested |
| Recovery loop | Proposes an action, gates it, executes (dry-run), simulates the outcome, hands it to the reconciler | Done, tested |
| Ledger console | A single-file screen showing every tie-out, its evidence, and the queue | Done |
| Audit trail | Hash-chained, tamper-evident record of every decision, exportable | Done, tested |
| Recovery console | Decision ribbon, full gate traces, gate coverage, verified recovery | Done |
| Sourced assumptions | Replacing placeholder estimates with cited real-world figures | In progress |

## Architecture

```mermaid
flowchart LR
  RZP["Razorpay Test Mode"] -->|"raw bytes + X-Razorpay-Signature"| WH["POST /webhooks/razorpay"]
  WH --> VER{"HMAC-SHA256 verified?"}
  VER -->|"no"| REJ["reject + audit reason\n(never echoed to caller)"]
  VER -->|"yes"| DEDUPE{"seen before?\nx-razorpay-event-id"}
  DEDUPE -->|"yes"| ACK["200 OK, ignored"]
  DEDUPE -->|"no"| MAP["toCanonical + classifyFailureReason\nreal Razorpay fields to our schema"]
  MAP --> VALID{"schema valid?"}
  VALID -->|"no"| QUAR["quarantined, counted"]
  VALID -->|"yes"| LEDGER[("canonical ledger\npaise, hashed contacts")]

  LEDGER --> SETTLED["captured + settlements + refunds"]
  LEDGER --> ATRISK["failed / abandoned / halted / overdue"]

  SETTLED --> RECON["recon.js\nexplain before flag"]
  RECON --> LADDER["confidence ladder"]
  LADDER --> UI["ui/ledger.html\ndelta gutter, gap decomposition"]

  ATRISK --> POLICY["recover.js\npropose an action"]
  POLICY --> GATES["gates.js\n11-gate money firewall"]
  GATES --> EXEC["execute\ndry-run by default"]
  EXEC --> SIM["frozen response model\nsimulates the outcome, test mode only"]
  SIM -->|"paid"| EMIT["emit payment_captured\n+ settlement_line"]
  EMIT --> RECON

  SEED["seed.js\ndeterministic batch + answer key"] -.-> LEDGER
```

Every arrow above is real, tested, and verified against a fresh clone — the loop that recovers a payment and the loop that reconciles it are no longer two separate halves of a diagram; `recover.js`'s output is literally read back into `recon.js`, and there is a test asserting every recovered payment reconciles cleanly when it is.

---

## A finding worth its own section: two mandates that look identical and aren't

While extending the failure-reason taxonomy, checking it against Razorpay's actual subscription behaviour surfaced something the first version of this model got wrong by collapsing it into one bucket.

**"The subscription's mandate stopped working" is not one situation — it's three, with three different remedies:**

| Reason | What happened | Who can fix it |
|---|---|---|
| `mandate_revoked` | Customer cancelled consent at their bank/UPI app entirely | Nobody — it's dead |
| `mandate_paused_by_customer` | Customer paused it themselves, through their own consent flow | Only the customer — Razorpay's API will not let a business force this |
| `mandate_paused_by_business` | The business paused it (a billing hold, a plan change) | The business — but only through an API call this project doesn't implement yet |

The first version of this project had one `mandate_revoked` bucket covering all three. That's a real defect, not a stylistic simplification: it would tell an automated agent to write off a subscription that a single API call could have fixed, and it would tell the agent to keep messaging a customer who was never the one blocking anything in the first place.

**How the model now handles each one:**

- Attempting to charge any of the three is hard-blocked at zero probability — not "unlikely," genuinely zero, enforced as a rule rather than a calibratable number, because there is no live authorisation for a retry to use against a suspended mandate.
- A customer-paused mandate can still be *nudged* — a message can prompt the customer to resume it themselves, since only they hold that switch.
- A business-paused mandate cannot be usefully nudged *or* charged. Messaging the customer accomplishes nothing, because the customer was never the blocker. The model reports zero recoverability through every intervention this project currently has — which is not a gap being hidden, it's the honest way of saying **this record's only correct action is escalation to a human who can make the API call**, and it will stay that way until a `RESUME_SUBSCRIPTION` action exists.

This last point is a deliberate design choice: rather than special-casing "if reason is business-paused, force escalate" somewhere in future agent logic, the numbers themselves already make escalation the only sensible choice. A future policy layer that tries every intervention on this record type will observe 0% success on all of them and shouldn't need a hardcoded rule to figure out what to do next.

**A third bug this surfaced, caught by testing rather than by inspection:** at 400 synthetic records, `mandate_paused_by_business` occurred zero times. Its declared share is 1% of failure reasons, and it only survives at all when the same record also draws the e-mandate payment method (a 14% share) — a joint probability of roughly 0.14%. This is the exact same failure mode as the settlement break-classes bug from Day 1 (`BREAK_MIX`), showing up again in a different part of the generator. The fix follows the same pattern: the rare reason is now guaranteed to appear at least once per batch, and the batch summary discloses when that guarantee had to fire (`mandate_reasons_forced` in `truth.json`) rather than silently forcing it without saying so.

---

## Results so far: the reconciliation engine

Reconciliation is the part of this project that can be measured honestly, because the test data ships with an answer key written before the matching logic existed. Recovery depends on a *simulated* customer and cannot make that claim — which is exactly why the reconciler carries the measurement burden for the whole project.

### What it does

For every captured payment, it compares what actually settled in the bank against what should have settled, and then does the thing that separates a useful reconciler from a noisy one: **before flagging a gap, it tries to explain it.**

Two of the eight problem types in the test data are not losses at all. A payment can settle across two different bank batches, and a refund can be deducted before settlement. Both look identical to a shortfall if you compare one payment to one line and stop there. Flagging them means a person spends an afternoon confirming that nothing was wrong.

So every payment lands on one of these rungs, and the rung is reported:

| Outcome | Meaning | Goes to a human? |
|---|---|---|
| `exact` | Settles to the paisa | No |
| `explained_split` | Two bank batches, sums correctly | No |
| `explained_refund` | Gap equals a refund already on file | No |
| `explained_fee` | Gap is a pricing-plan variance | Yes — low priority |
| `flagged_duplicate` | Customer charged twice, refund owed | Yes — high priority |
| `unexplained` | Genuine break | Yes — high priority |
| `orphan_credit` | Money arrived with no payment behind it | Yes — high priority |

### Measured across 25 independent test datasets

| Metric | Result |
|---|---|
| Precision (of what we flagged, how much was real) | 100.0% |
| Recall (of what was real, how much we caught) | 100.0% |
| Explanation accuracy (right verdict *and* right reason) | 98.2% ± 1.4% |
| False positives | 0 |
| False negatives | 0 |
| Exceptions raised per dataset | 19.8 ± 3.6 |

**The 100% figures deserve suspicion, and here is the honest reading of them.** They say the flag / don't-flag rule is sound *on the eight problem types this generator produces*. They say nothing about a ninth type nobody thought to enumerate, which is what real settlement files always contain. The 98.2% explanation accuracy is the more informative number, because it is the one that is not perfect — and the reason it isn't is documented below.

There is a test in the suite that **fails if explanation accuracy ever reaches 100% across every dataset**, on the grounds that a perfect score there would mean the threshold had been quietly fitted to the answer key rather than reasoned about.

### Two design bugs the first run exposed

**Bug 1 — "I can explain this" was being confused with "nobody needs to see this."** The first version scored 56% recall. Five of the seven misses were pricing-fee variances that the engine had explained away as normal. But an explainable shortfall is still money the merchant didn't receive — it needs someone to confirm the pricing plan, just not with the same urgency as a duplicate charge. The fix was to keep it as an exception and give it a severity, which is what makes the queue *triaged* rather than a flat pile someone has to re-sort by hand.

The alternative fix would have been to relabel fee variances as "fine" in the answer key. That would have moved recall to 93% and meant nothing, because the key would have been edited to match the result.

**Bug 2 — Only half of each duplicate pair was being reported.** When a customer is charged twice, the engine found the pair correctly but only reported the second charge. That scored as a miss, and more importantly it left an operator with the same puzzle they started with. Both rows are now reported, labelled `original` and `duplicate`, so the decision is on screen rather than one search away.

### The one threshold, and why it isn't tuned

The engine has exactly one adjustable number: how large a shortfall can be, relative to the transaction fee, before it stops counting as a pricing variance and starts counting as a real break. `npm run sweep:band` prints the full trade-off curve for that number rather than presenting a single figure that appeared from nowhere.

The curve flattens past 60%, and that flatness is an artefact of the test data generator, not a property of real settlement files — the generator draws fee variances in a fixed range, so a wide enough band captures all of them and widening it further changes nothing. Real variances have no such ceiling. **60% is shipped because it is the narrowest band that clears the generator's stated range, not because the curve has a peak there.**

### Known limitation

Roughly 1 in 80 payments has a small mismatch that could plausibly be either a fee variance or a genuine amount error. The two overlap in size and there is no rule that separates them cleanly. Inventing one tuned to this dataset would be fitting the answer key rather than reconciling. The overlap is left in place, counted, and reported in the explanation-accuracy figure.


---

## The ledger console

`npm run ui` builds `ui/ledger.html`. Open it by double-clicking — no server, no install, no network.

The interface is deliberately not a dashboard. A reconciliation is a *document*: two columns that either tie out or don't. So the screen is built as a ledger, and the central question is asked in the layout itself — what should have settled, on the left; what actually settled, on the right; and the difference between them in the channel down the middle.

**The delta gutter.** Every payment's difference is drawn to scale from a centre line: left is short, right is over, and a row that ties out draws nothing at all. Scanning that one column shows the shape of a batch before a single figure is read. Bar length is on a square-root scale, because a linear one lets a single large break flatten every small one into invisibility — and small breaks are exactly the ones a person would otherwise miss.

**Colour carries the verdict and nothing else.** Three states: tied out, explained but still owed, needs a person. Nothing on the page is coloured for decoration.

**The difference is decomposed, not just reported.** Under the tie-out, a bar splits the total gap across those three states, and the parts sum back to the whole. Rows that tied out contribute exactly ₹0.00 to it. A reconciler that reports a total it cannot break down is reporting a number rather than a result.

**The page does no arithmetic.** Every figure comes from `recon.js` and `sweep.js` — the same code the test suite exercises. The console formats and arranges; it does not calculate. A dashboard that does its own maths is a second implementation nobody tests.

The scorecard reports the 25-batch sweep rather than the single batch on screen, because one batch is an anecdote and should not be dressed as a measurement just because it happens to be the one being displayed. The header shows whether the run is reportable yet — the same citation gate the command line enforces, surfaced where a reviewer can see it.

---

## The gate layer: "bounded and gated," made concrete

`gates.js` is the one place in this project that is allowed to say whether a proposed action may actually run. Every guarantee below is enforced there, tested independently, and demonstrated in `npm run gates:demo` — seven scenarios, each engineered to trip exactly one gate, with the full trace printed.

| Gate | What it enforces |
|---|---|
| Kill switch | Everything stops, unconditionally, the moment it's engaged — no exceptions carved out |
| Action allowlist | A proposed action outside the closed vocabulary is coerced to doing nothing, never guessed into the nearest match |
| Do-not-contact | Absolute, no override path — blocks messaging, never blocks a silent retry |
| Mandate charge block | The same "cannot charge a suspended mandate" rule from the frozen model, enforced *again*, independently, at execution time |
| Business-paused routing | A business-paused mandate can't be fixed by messaging the customer, so it goes straight to a human instead of wasting a contact attempt |
| Attempt ceiling | Stops retrying after a configured maximum; small amounts write off, large amounts still go to a human |
| Cooldown | A minimum wait since the last attempt — pacing, not a probability judgement |
| Quiet hours | No customer-facing message outside 9 AM–7 PM IST |
| Approval ceiling | Amount alone can force human review, regardless of what else passed |
| Spend caps (run + day) | Further paid actions reroute to a human once either cap is reached |

### Why the trace matters more than the verdict

Every gate pushes exactly one entry to the trace, every time — pass or block — including the nine gates that had nothing to say about a particular action. A trace that only records failures invites the question "were the others actually checked?" This one is built so that question doesn't need asking: `npm test` includes a check that every trace contains all eleven gate names, in order, on every single call.

### Two independent copies of the same rule, on purpose

The rule "a suspended e-mandate cannot be charged" exists twice in this codebase — once in `model/response-model.frozen.js`, where it keeps the *scoring* honest, and again in `gates.js`, where it keeps *execution* honest. These are different files, checked by different tests, and one is proven not to depend on the other: a test tampers with the frozen model's recoverability number, sets it to a wrong, "should definitely work" value, and confirms the gate still blocks the charge anyway. A bug in either copy alone still can't produce a duplicate or impossible charge.

### The quiet-hours citation, and its honest limit

The 9 AM–7 PM window is the intersection of two regulatory sources, not a number picked for the demo:

- RBI's Fair Practices Code restricts loan-recovery-agent contact to 8 AM–7 PM.
- TRAI's Telecom Commercial Communications Customer Preference Regulations restrict promotional calls and messages to 9 AM–9 PM.

Neither one cleanly covers what this project actually does. RBI's code governs regulated lenders collecting *loans* — a merchant chasing a *failed e-commerce payment* isn't that, so it isn't strictly bound by it. TRAI's window applies to *promotional* communication, and a payment-recovery nudge is arguably *transactional* in TRAI's own taxonomy, which could exempt it entirely. Rather than picking whichever reading is more convenient, this project takes the **intersection** of both cited windows as the conservative default — 9 AM–7 PM — and says so, instead of quietly claiming a compliance guarantee it hasn't verified with a lawyer.

### What is deliberately outside this file

`gates.js` decides. It does not execute, and it does not remember anything between calls — recording that an attempt happened or that money was spent is the executor's job, done only *after* an action actually runs. Keeping the decision function free of side effects is what makes it possible to unit-test every gate in isolation, calling it hundreds of times with fabricated histories, without ever touching a real spend counter or a real webhook.

`recover.js` is that executor.

---

## The recovery loop, and the number the whole project rests on

`recover.js` is the file that turns everything above from infrastructure into an agent: **propose → gate → execute (dry-run) → simulate the outcome → hand it back to the reconciler for independent confirmation.**

### Two policies, not one

A single "the agent recovered ₹X" figure is unfalsifiable — there's nothing to compare it to. Every batch runs through **two** policies, against the identical seeded population and the identical gates:

- **`baselinePolicy`** — retry everything, blindly, no branching on reason or channel. This is what a merchant gets with zero intelligence layered on Razorpay.
- **`smartPolicy`** — a transparent, rule-based policy that reads the same failure-reason taxonomy a merchant already receives from Razorpay: escalate dead-on-arrival reasons immediately rather than wasting an attempt, route business-paused mandates straight to a human (nudging the customer cannot fix a block on the business side), and once retrying has stopped helping, escalate through channels — cheapest first, switching to a regional-language voice nudge for a non-English-locale customer rather than defaulting to English.

Both policies are **swappable behind the same interface**: `gates.js` validates whatever a policy proposes against the same closed vocabulary regardless of where the proposal came from. An LLM-based policy could sit behind this exact interface tomorrow without changing anything downstream of it.

### The claim is the delta, net of cost — and it had to earn that framing

Run at the default window (`npm run recover`):

| | baseline | smart |
|---|---:|---:|
| payments recovered | 30 / 120 | 42 / 120 |
| gross recovered | ₹37,212 | ₹52,105 |
| direct cost | ₹0 | ₹146 |
| opt-out loss (estimated) | ₹0 | ₹480 |
| **net recovered** | **₹37,212** | **₹51,479** |

**Delta: ₹14,267** — smart minus baseline, after cost and after the estimated cost of the one customer it annoyed into opting out. Baseline's cost is genuinely zero because a silent retry costs nothing; smart's advantage has to clear that bar before it counts as an improvement at all, which is why the number is reported net rather than as a raw "amount contacted."

### A measurement mistake this design caught before it reached the README

The first version of this comparison ran for 6 rounds. At that window, **the delta was negative** — the baseline appeared to outperform the smart policy. That wasn't a bug in the policy; it was a bug in stopping the clock too early. Smart's advantage is back-loaded (it comes from switching channels once retrying has failed, which takes a few rounds to play out) while its cost is front-loaded (escalating a dead-on-arrival record costs a little immediately, with no offsetting benefit for that specific record). A short window sees the cost before it sees the benefit, and would have shipped a **wrong conclusion with high confidence** if the comparison hadn't checked its own completeness.

The fix wasn't to pick a rounds count that produced a flattering number. It was to make `runBatch()` report **`stillInProgress`** explicitly — how many records had not yet reached a terminal state — and refuse to let a short window pass silently. `npm run recover -- --rounds 3` still runs, and still prints a loud warning that the comparison it just showed is against a moving target. 8 rounds was chosen because it's the empirically smallest window where **both** policies fully resolve on the default batch — verified by running 6/8/10/14/20 and confirming the paid counts stop changing at 8, not assumed.

### The delta is real, but only one version of it is stable — and that distinction matters more than the headline number

`npm run eval` runs the comparison across 20 independently seeded batches, and reports two different deltas that tell two different stories:

```
PAYMENTS RECOVERED, delta (smart − baseline), a count:
    mean     10.1   sd    5.6   cv 55.0%   range [0 … 18]
    smart recovered MORE payments than baseline in 19/20 batches, fewer in 0/20

NET ₹ RECOVERED, delta (smart − baseline):
    mean      ₹3,854.24   sd   ₹11,790.04   cv 305.9%
    range [-₹22,453.84 … ₹24,040.52]
    smart beat baseline on ₹ in 13/20 batches
```

The **count-based** delta is the reliable claim: smart recovers more payments than baseline in effectively every batch tried. The **rupee-based** delta is directionally right but genuinely noisy — its spread is dominated by whether one or two high-value `invoice_overdue` records happen to convert in a given random draw, not by the underlying policy being unreliable. Increasing the batch size doesn't fix this on its own, because a handful of large invoices can still swing a bigger total by a proportionally similar amount.

Reporting only the rupee figure would either overstate confidence on a lucky seed or make a policy that is, by the more stable measure, working consistently look shakier than it is. `eval.js` prints both, on purpose, with an explicit warning when the rupee spread exceeds its own mean — which it currently does. **The honest version of this project's headline claim is "recovers more payments, reliably" — not a specific rupee figure, yet.**

### The loop closes: recovered money is independently reconciled, not just claimed

Every payment the simulation marks as paid gets a matching `payment_captured` + `settlement_line` pair, computed the same way `seed.js` computes real settlements (Razorpay's fee and tax deducted). That pair is fed back into `recon.js`, and a test asserts every single recovered payment reconciles cleanly when it is. The file that tears apart a settlement report is the same file that has to agree the recovery actually happened — the agent doesn't get to grade its own homework.


---

## The audit trail

Razorpay's stated bar for this track is: *"Every money action explainable, bounded and gated. Show the audit trail and one failure handled gracefully."* `gates.js` covers bounded and gated, and produces a full explanation of every verdict — but until now that explanation lived only in memory, for the length of one process. `audit.js` makes it an artefact.

### Hash-chained, so a quiet edit doesn't stay quiet

Each entry stores the hash of the entry before it, and its own hash covers that link:

```
hash(n) = sha256( seq | ts | hash(n-1) | canonical(payload) )
```

Change one amount in entry 3 and entry 3's hash stops matching its own contents. Recompute entry 3's hash and entry 4's `prev_hash` stops matching. `verifyChain()` reports the exact sequence number where the break starts. There are tests for modification, deletion, and reordering — all three are caught.

**This is tamper-EVIDENT, not tamper-PROOF**, and the difference is worth stating rather than letting a reader assume the stronger claim. Anyone who can rewrite the whole file can recompute every hash from their edit onward and produce a chain that verifies perfectly. What this defends against is a casual or partial edit — one changed amount, one deleted inconvenient row, entries shuffled — not a determined attacker with write access. Real tamper-proofing needs an anchor *outside* the file: signing entries with a key the writer doesn't hold, or committing the head hash somewhere append-only. That's the documented upgrade path, not something already here.

### The decision is recorded before the action, not after

An audit log written after the fact records what a system decided it did. This one records what it decided *to* do, then separately what happened — so a crash between the two leaves evidence rather than a gap. A test asserts every `execution` entry is immediately preceded by its own `decision` entry for the same entity: **no action without a recorded reason.**

Every `decision` entry carries the complete eleven-gate trace, not just the gates that blocked — also asserted by test.

### The head hash is a run fingerprint

The audit clock is driven by the run's simulated time, not wall-clock. Two consequences: entries read in the order decisions actually happened, and **the same seed produces a byte-identical chain**, so the head hash can be quoted as a fingerprint of an entire run. Different seed, different hash. Both directions are tested.

### Gate coverage: which gates actually fired, and why the rest didn't

A run that reports "all gates passed" while eight of them never had anything to check is not telling you much. `npm run recover` prints the honest version:

```
── GATE COVERAGE · 3/11 gates fired across 388 decisions ──
  ✗ do_not_contact             blocked 2 times
  ✗ quiet_hours                blocked 108 times
  ✗ approval_ceiling           blocked 23 times

  silent this run — and why:
  · kill_switch            [by-design] only fires when a human engages it
  · action_allowlist       [by-design] both shipped policies emit valid actions only
  · mandate_charge_block   [backstop] a policy that checks the failure reason first never reaches it
  · business_paused_no_nudge [backstop] smartPolicy already refuses to propose this nudge
  · attempt_ceiling        [backstop] both policies self-terminate at or before the ceiling
  · cooldown               [scenario] fires for blind retry, not for channel escalation
  · spend_cap_run          [scenario] this run's spend never approaches the cap
  · spend_cap_day          [scenario] same
```

Three categories, and the distinction between them is the point. **by-design** gates should never fire in a healthy run. **backstop** gates exist to catch a policy that isn't careful — `smartPolicy` proactively refuses to propose a nudge for a business-paused mandate, so `business_paused_no_nudge` has nothing to catch; that's the policy being good, not the gate being useless. **scenario** gates simply weren't reached by this batch.

Notably, the two policies exercise *different* gates: `baselinePolicy` trips `cooldown` and `mandate_charge_block` (it retries blindly, so it walks into both), while `smartPolicy` trips `quiet_hours` and `do_not_contact` (it messages people, so it meets the rules about messaging people). Neither alone covers the surface.

Every gate has a direct unit test that forces it to fire. **"Silent this run" means this scenario didn't reach it — not that the code is unexercised**, and `gateCoverage()` fails loudly if any silent gate has no recorded explanation.

### A documentation bug this caught

The first version wrote the post-recovery ledger as `post-recovery-ledger.smart.json` and told the reader to run `recon.js` against the directory. Running that command crashed — `recon.js` reads `ledger.json` and `truth.json`. **An instruction that has never been executed is a guess, not documentation.** Fixed by writing the filenames `recon.js` actually expects, and adding `npm run recon:recovered` so the documented next step is a script that runs rather than a sentence that might.


---

## The recovery console

`npm run ui:recovery` builds `ui/recovery.html`. Like the ledger console, it opens by double-clicking — no server, no install, no network.

It is a sibling to `ledger.html`: same ledger-paper palette, same typography, same principle that colour carries meaning and nothing else. With one deliberate semantic difference — **in the ledger console red means "exception, something is wrong." Here a gate blocking an action is the system working correctly, not a fault**, so it gets its own colour (a deep indigo that reads as deliberate intervention) rather than the alarm red.

### The decision ribbon

One track per record, one cell per round. Colour tells you what happened in that round — recovered, a gate intervened, escalated to a person, written off, or deferred. Scanning down the ribbon shows the shape of an entire campaign before you read a single figure: where the gates held things back, where money actually came in, where records ended up with a human.

Select any track and it expands to the **full eleven-gate trace behind every decision on that record** — including the gates that passed.

### Compression that is provably lossless, not selective

The raw audit chain for one run is ~706KB, mostly because the same gate explanations repeat across hundreds of decisions. The obvious way to shrink that would be to keep only the gates that blocked and drop the passes.

That would be the wrong fix. `gates.js` emits an entry for every gate on every call *precisely so* nobody has to ask "were the others actually checked?" — and a console that quietly discarded the passes would reintroduce the exact doubt the design exists to remove.

So the detail strings are dictionary-encoded instead: 429 unique strings across 4,268 trace entries, with each trace becoming an array of `[blocked, stringIndex]` pairs. **706KB becomes 81KB with nothing discarded.** A test decodes the whole structure and compares it entry-for-entry against the original — a compression scheme for an audit trail has to be provably lossless, or it is deletion with extra steps.

### The headline number is not the agent's own claim

The console reports **42 payments recovered, 42 independently reconciled**. Every payment the agent recovered is fed back through the same reconciler that tears apart a settlement file, and only what reconciles is reported as verified. The agent does not get to grade its own homework, and the console does not let it.

---

## For technical reviewers

### Quick start

Requires **Node.js 22 or later**. No external dependencies to install.

```bash
cd server
cp .env.example .env
# Generate a random value for CONTACT_SALT and paste it into .env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm test             # runs all 103 automated checks
npm run seed         # generates a reproducible test dataset + answer key
npm run recon        # reconciles that dataset and scores itself against the answer key
npm run sweep        # repeats the above across 25 independent datasets
npm run ui           # builds the ledger console into ui/ledger.html
npm run ui:recovery  # builds the recovery console into ui/recovery.html
npm run gates:demo   # 7 scenarios, each tripping exactly one gate, full trace printed
npm run recover      # runs the recovery loop: baseline vs smart, one batch, full comparison
npm run eval         # repeats that comparison across 20 independent batches
npm run recon:recovered  # reconciles the money the recovery loop just recovered
npm run check        # verifies the locked model hasn't changed, and checks citations
npm start            # starts the server that receives Razorpay webhooks
```

Running `npm run seed` with the same seed number always produces the exact same test data, on any computer. This is verified by an automated test, not just claimed.

### Project structure

```
axiom-recover/
├── README.md                          this file
└── server/
    ├── .env.example                   template for required configuration
    ├── package.json                   scripts and project metadata
    ├── index.js                       receives and verifies Razorpay webhooks
    ├── seed.js                        generates the test dataset + answer key
    ├── freeze.js                      locks the test model, checks citations
    ├── lib/
    │   ├── rng.js                     reproducible random number generation
    │   ├── schema.js                  defines and validates the data format
    │   ├── verify.js                  Razorpay signature verification, contact privacy
    │   └── rzp.js                     safe wrapper around the Razorpay API
    ├── model/
    │   ├── response-model.frozen.js   the locked customer-response simulation
    │   ├── base-rates.json            assumptions behind that simulation (needs citations)
    │   └── FROZEN.json                proof that the model above hasn't been altered
    └── test/
        └── smoke.js                  103 automated checks
```

### Key engineering decisions

**All money is stored as whole paise (e.g. ₹100.00 is stored as `10000`), never as rupees or decimals.** Computers cannot represent decimal fractions like 0.1 exactly, which causes small but real rounding errors in financial software. Using whole numbers for the smallest currency unit avoids this entirely. There is an automated test confirming that a decimal amount is rejected outright.

**No real request to Razorpay is ever sent unless explicitly turned on.** By default, everything runs in a safe "simulation" mode. Going live requires an explicit setting (`RAZORPAY_LIVE=true`), and the system additionally refuses to run at all if it detects a live (production) API key was provided by mistake, unless that is separately and explicitly confirmed.

**Every payment action carries a unique, repeatable identifier that prevents duplicate charges.** If the same action is accidentally triggered twice — for example, due to a network retry — the system recognizes it as the same action and does not repeat it. This is one of the most important protections in any system that moves money automatically.

**Customer phone numbers and emails are never stored in readable form.** They are converted into a one-way scrambled value (a cryptographic hash) before being saved anywhere. This value cannot be reversed back into the original phone number or email.

**Incoming Razorpay notifications are cryptographically verified before being trusted.** This confirms that a notification claiming to be from Razorpay is genuinely from Razorpay, and has not been tampered with in transit.

### Two issues found and fixed during testing

Both are documented here rather than hidden, because a project that only shows its successes doesn't show how it actually works.

**Issue 1 — Test data wasn't as repeatable as claimed.** The very first version of the test-data generator used the computer's current time as part of its calculations. This meant running it twice, a second apart, produced slightly different results — which defeated the purpose of having "repeatable" test data. This was fixed by using a fixed reference date instead of the live clock.

**Issue 2 — Rare but important test cases were sometimes missing.** With a small test dataset, some of the rarer (but important) situations — like a customer being accidentally charged twice — would sometimes not appear at all, purely by chance. This was fixed by guaranteeing that every important scenario appears at least once in every test run, while keeping everything else random and realistic.

### What is not yet finished

- The current assumptions in `base-rates.json` are reasonable placeholder estimates, not yet backed by cited sources. This is flagged automatically by `npm run check`, which will not allow results to be called final until this is resolved.
- The rupee-value recovery delta is directionally positive but not yet statistically stable at this batch size (see "The recovery loop" section above) — the count-based recovery-rate delta is the claim currently worth relying on.
- The visual dashboard for the recovery side (as opposed to the reconciliation side, which `ui/ledger.html` already covers) is still being built.
- `recover.js` always runs in simulate mode — a real "live" mode, where outcomes arrive asynchronously through `index.js`'s webhook receiver instead of being resolved inline by the frozen model, is a documented extension of the same propose/gate/execute spine, not yet built.
- The mapping between Razorpay's real webhook format and this project's internal data format should be checked against Razorpay's current API documentation before connecting to live data, as APIs can change over time.
- Spend-cap and approval-ceiling figures in `gates.js` (₹5,000 per run, ₹20,000 per day, ₹10,000 auto-approval threshold) are placeholder business decisions, not citations — unlike the quiet-hours window, nothing regulatory pins these numbers, and they should be set deliberately before this runs against a real merchant's book.

---

## License

MIT — see `LICENSE`.
