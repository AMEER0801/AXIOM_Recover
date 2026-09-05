# The Operator Console

A single-origin web console that runs the **real engine live** — not fixture
data, not a mock. Every number on screen was computed by the same
`recover2.js` / `gates.js` / `recon.js` / `audit.js` a reviewer can run from the
CLI, seconds before the first request arrives. And the Live AI tab wires the
**two real providers** — Groq and Razorpay Test Mode — into the same console.

```bash
# one-time setup
cd ui && npm install && npm run build && cd ..

# every demo
cd server && cp .env.example .env   # then fill your keys (see below)
npm run console                     # → http://localhost:3000
```

Optional but recommended once (the Evidence tab's sweep, ~2 min):

```bash
cd server && npm run eval:console   # 20-seed paired bootstrap sweep
```

One URL serves everything: the API and the built console, zero extra
processes. The sidebar states plainly what you are looking at — `live run`
(data from the running engine), `cited` (every base rate carries a source),
`SIMULATION` (frozen response model, dry-run execution, no live money), the
audit chain's head fingerprint, and the live/off dots for both providers.

## Real keys (the Live AI tab)

Two free keys turn the Live AI tab from a rehearsal into the real thing.
Both are read server-side only; neither ever reaches the browser.

```bash
# server/.env
RAZORPAY_KEY_ID=rzp_test_...        # dashboard.razorpay.com → Settings → API Keys (Test Mode)
RAZORPAY_KEY_SECRET=...
RAZORPAY_LIVE=true                  # the switch that lets requests actually leave this machine
GROQ_API_KEY=gsk_...                # console.groq.com/keys — free, no card
```

- **Groq** powers the third judge: an independent, advisory second opinion
  on one at-risk record, constrained to the same closed intervention
  vocabulary, paced for the free tier. Missing key → the judge renders as
  "off" with the exact line to fix. It never fails silently.
- **Razorpay Test Mode** (with `RAZORPAY_LIVE=true`) makes `Create payment
  link` produce a **real payment link object on your account** — visible in
  Dashboard → Payment Links (Test Mode). `Create again (replay)` re-sends
  the same (entity, action, attempt) and the persisted idempotency store
  returns the ORIGINAL link instead of creating a second one — the exact
  protection the engine's executions rehearse in dry-run.
- `Ping API` is a real `GET /v1/payments?count=1` — one honest round-trip
  proving the credentials and network before anything else happens.

## The seven screens

| Tab | What a reviewer sees | Engine surface |
|---|---|---|
| **Ledger** | 81 settled payments, explain-before-flag verdicts, triaged exception queue, computed precision/recall | `recon.js` |
| **Recovery** | One track per at-risk record, one cell per round; click any record for the full **11-gate trace** behind every decision — including the gates that passed | `recover2.js` + audit `decision` entries |
| **Gates** | The money firewall, hands-on. Presets engineered to trip exactly one gate; every probe is evaluated by the **real `gates.js`** on the server (the browser mirror only runs when offline, and says so) | `gates.js` |
| **Evidence** | Value-recovery deltas (the Track 3 bar metric), 20-seed paired bootstrap CIs, the DP-computed oracle ceiling, full provenance — seeds, warm-up split, regenerate command | `console-eval.js` |
| **Chaos Lab** | Attack the safeguards yourself: a **webhook flood** (20 concurrent deliveries → 1 executes, 19 get 409, 1 replayed from cache, with the scenario's audit chain as proof), a **bank flap** (4 route failures → circuit OPEN, retries suppressed, reroute advisory, penalty fees avoided), and the **NRV calculator** (margin math with the veto, live). All three run over the REAL `lib/` code the live path uses — no browser re-enactment, no fixture fallback | `lib/idempotency.js` + `lib/circuitBreaker.js` + `lib/nrv.js` + `audit.js` |
| **Live AI** | One case → three judges: the deterministic policy (authoritative), the eleven gates (what may actually run), and **Groq live** (advisory, agrees/disagrees). Plus a **real Razorpay Test Mode** payment link with an on-screen idempotency replay. Diagnosing with a route the Chaos Lab tripped shows the breaker's suppression here too — one shared truth | `recover.js` policy + `gates.js` + `llm-policy.js` + `lib/rzp.js` + `lib/circuitBreaker.js` |
| **Audit** | The hash chain, verified on every request; decision-before-execution invariant checked in the browser; **325 gate vetoes counted from the payloads** (what the system refused to do); **Export audit seal** → a bundle with the merkle root that `node server/verify-proof.js <file>.json` verifies standalone, zero dependencies | `audit.js` + `lib/merkle.js` + `verify-proof.js` |

## The resilience demos (Chaos Lab)

The three attacks and what each proves:

- **Inject N concurrent webhooks.** Fires N simultaneous deliveries of the
  same payment through the real in-flight locks. Exactly one executes and
  records a decision in an isolated audit chain; the rest get
  `409 IN_FLIGHT_LOCK_ACTIVE`; a late duplicate gets the original outcome
  replayed from the result cache. The invariant — and its audit proof — is
  in the response, so the console never counts on its own.
- **Simulate a bank 504 flap.** Injects route failures into the shared
  breaker: watch the circuit go CLOSED → OPEN, retries suppressed for the
  cooldown, and the reroute advisory (payment link on a healthy rail) with
  the penalty fees avoided. Then diagnose the same route in the Live AI
  tab — the suppression appears there too, because the lab and the live
  path share one breaker instance.
- **Price a recovery (NRV).** Sliders for amount, channel, P(success),
  fatigue and LTV; the server computes yield − cost − churn risk and
  vetoes margin-negative actions with the arithmetic printed. Sub-₹100 on
  a paid channel trips the small-ticket invariant regardless of
  probability.

## What is deliberately on the screen

- **Value, not count.** Recovery is reported as money over at-risk money.
  The count metric is shown too — the gap between them is exactly how the
  approval-ceiling bug (93% of value condemned while counts looked healthy)
  stayed invisible.
- **Intervals, not points.** The hero number is a delta with a paired 95%
  bootstrap CI, across 20 independent populations. Single-seed numbers are
  labelled as anecdotes.
- **The ceiling.** An omniscient policy provably recovers ~71.5% on these
  exact rules. The shipped policy captures ~82% of it while blind to the
  answer key. The console says so, because a number without an anchor is
  just a number.
- **Mode honesty.** The engine surfaces are simulated against the
  hash-frozen response model with dry-run execution, and the badge never
  comes off. The Live AI tab is where real calls happen, and each result is
  labelled `LIVE · test mode`, `DRY-RUN`, or `REPLAYED` — never mixed.
- **AI judgment, visibly bounded.** The LLM may disagree with the policy —
  and when it does, the badge says so and a human decides. The model
  cannot pick an action outside the closed vocabulary; anything invalid is
  coerced to NO_ACTION and shown for what it was.

## Dev mode

```bash
cd ui && npm run dev        # Vite on :5173, proxies /api → :3000
cd server && npm run console
```

The API client degrades to labelled fixtures when the backend is down, so
`npm run dev` alone still shows a working console — with a banner that says
so. Silently showing fixture numbers as live is the one failure this
project's citation discipline exists to prevent.

## Reproducibility

The boot run is seeded (seed 42, 200 records, 20 rounds, 8 held-out warm-up
populations), the RNG discipline holds, and the audit clock is the run's
simulated time — so two reviewers hitting refresh see byte-identical JSON,
and the same seed produces the same audit head. `npm run eval:console`
regenerates the Evidence sweep deterministically; only its `generatedAt`
label moves. The idempotency store under `server/data/` is the one file
that persists between runs on purpose — replaying a link is supposed to
find the original in it.
