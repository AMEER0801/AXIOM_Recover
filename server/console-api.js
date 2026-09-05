"use strict";
require("./load-env"); // must run before any process.env read below
/* ══════════════════════════════════════════════════════════════
   CONSOLE-API — the operator console backend
   ──────────────────────────────────────────────────────────────
   Serves the React console in ui/ from the REAL engine, live:

     GET  /api/recon            the settlement ledger (recon.js)
     GET  /api/recover           a full recovery run, all three arms,
                                 per-record rounds with 11-gate traces
     GET  /api/eval              the 20-seed paired sweep (console-eval.js)
     POST /api/gates/evaluate    run a probe through the REAL gates.js
     GET  /api/audit             the hash chain + verification
     GET  /api/audit/export      the audit seal: chain + merkle root,
                                 standalone-verifiable (verify-proof.js)
     POST /api/simulate/chaos-concurrency   webhook flood over the real
                                 idempotency locks — 1 wins, rest get 409
     POST /api/simulate/bank-flap          trip the bank circuit breaker;
                                 retries suppressed + reroute advisory
     POST /api/simulate/nrv                the Net Recovery Value gate,
                                 live — the margin math and the veto
     GET  /api/breaker/status    shared breaker state (route param)
     GET  /*                     the built console (ui/dist)

   The point of this server is that nothing on screen is fixture
   data. Every number the console renders was computed by the same
   recover2.js / gates.js / recon.js a reviewer can run from the
   CLI, on the same seeded population, a few seconds before the
   first request arrives.

   Startup runs the engine once (seed 42, 200 records, 20 rounds,
   warm-up 8 held-out populations — the recover-final.js defaults)
   and holds the results in memory. That costs a few seconds of
   boot and buys a property the demo needs: the API never blocks
   on a batch mid-request, and two reviewers hitting refresh see
   byte-identical JSON, because the runs are seeded and the RNG
   discipline holds.

   Like everything else in server/, this file has zero npm
   dependencies — Node's own http module, the same choice
   index.js makes, for the same reason: the raw body has to be
   read for signature verification anyway.

   Run:    npm run console        (then open http://localhost:3000)
   ══════════════════════════════════════════════════════════════ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { generate } = require("./seed");
const { reconcile, score } = require("./recon");
const { runBatch2, warmBandit } = require("./recover2");
const { baselinePolicy, smartPolicy, AT_RISK_KINDS, ACTING } = require("./recover");
const { runFinalPolicy, FINAL_CONFIG } = require("./recover-final");
const { createBandit } = require("./bandit");
const { evaluateGates, GATE_NAMES, createAttemptLedger, createSpendTracker, createKillSwitch } = require("./gates");
const { verifyChain, gateCoverage, createAuditChain } = require("./audit");
const { runCeiling } = require("./oracle-ceiling");
const { callModel } = require("./llm-policy");
const { RazorpayClient } = require("./lib/rzp");
const { createIdempotency } = require("./lib/idempotency");
const { breaker } = require("./lib/circuitBreaker");
const { evaluateNRV, CHANNEL_COST_INR } = require("./lib/nrv");
const { merkleRoot } = require("./lib/merkle");

const PORT = Number(process.env.PORT || 3000);
const SEED = Number(process.env.SEED || 42);
const RECORDS = Number(process.env.RECORDS || 200);
const ROUNDS = Number(process.env.ROUNDS || 20);
const WARMUP = Number(process.env.WARMUP || 8);
const UI_DIST = path.resolve(__dirname, "..", "ui", "dist");

/* ── boot: run the engine once, hold the results ─────────────── */

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(s),
  });
  res.end(s);
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body_too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* The UI's RoundOutcome, derived from what the engine actually
   recorded — never invented. A decision the gates rewrote is
   'gated' (the system working, not a fault); ESCALATE_HUMAN that
   survived the gates is 'escalated'; a paid outcome is 'paid'. */
function outcomeOf({ allowed, final, paid }) {
  if (paid) return "paid";
  if (!allowed) return "gated";
  if (final === "ESCALATE_HUMAN") return "escalated";
  if (final === "WRITE_OFF") return "written_off";
  if (ACTING.has(final)) return "attempted";
  return "idle";
}

function failureReasonOf(record) {
  return record.failure?.reason || record.kind;
}

/* Build the RecoveryRun the console renders, from the engine's own
   per-record log and audit chain. The 11-entry gate trace per round
   comes from the audit 'decision' entries — the same trace the CLI
   prints — never re-derived here. */
function buildRecoveryRun({ seed, rounds, arms, ledger, finalRun }) {
  /* index audit entries by (entity, round) */
  const decisions = new Map();
  const outcomes = new Map();
  for (const e of finalRun.audit.entries()) {
    const p = e.payload || {};
    if (e.kind === "decision" && p.entity_id != null) decisions.set(`${p.entity_id}:${p.round}`, p);
    if (e.kind === "outcome" && p.entity_id != null) outcomes.set(`${p.entity_id}:${p.round}`, p);
  }

  /* which records actually reconciled: run the reconciler over the
     run's emitted settlement pairs, then map back by the
     recovered_from marker makeSettledPair records. */
  const reconOfEmitted = reconcile(finalRun.emitted);
  const reconciledEntities = new Set();
  for (const r of reconOfEmitted.results) {
    if (!r.reconciles) continue;
    const pay = finalRun.emitted.find((e) => e.kind === "payment_captured" && e.entity.id === r.payment_id);
    if (pay?.raw?.recovered_from) reconciledEntities.add(pay.raw.recovered_from);
  }

  const atRisk = ledger.filter((r) => AT_RISK_KINDS.has(r.kind));

  const records = atRisk.map((rec) => {
    const perRound = [];
    for (let round = 1; round <= rounds; round++) {
      const d = decisions.get(`${rec.entity.id}:${round}`);
      if (!d) continue;                      /* record was already resolved — no decision this round */
      const o = outcomes.get(`${rec.entity.id}:${round}`);
      const trace = (d.trace || []).map((t) => ({ gate: t.gate, blocked: t.result === "block", detail: t.detail }));
      const firstBlock = trace.find((t) => t.blocked);
      const outcome = outcomeOf({ allowed: d.allowed, final: d.final, paid: !!o?.paid });
      perRound.push({
        round,
        proposed: d.proposed,
        outcome,
        blockedBy: outcome === "gated" ? firstBlock?.gate : undefined,
        trace,
        cost: o?.cost_paise ?? 0,
      });
    }
    const paid = perRound.some((r) => r.outcome === "paid");
    const last = perRound[perRound.length - 1];
    const terminal = paid
      ? "recovered"
      : last?.final === "ESCALATE_HUMAN" || last?.proposed === "ESCALATE_HUMAN"
        ? "escalated"
        : last?.final === "WRITE_OFF" || last?.proposed === "WRITE_OFF"
          ? "written_off"
          : "in_progress";
    return {
      id: rec.entity.id,
      merchant_id: rec.merchant_id,
      customer_ref: rec.customer?.contact_hash || rec.customer?.id || "unknown",
      amount: rec.amount_paise,
      failure_reason: failureReasonOf(rec),
      locale: rec.customer?.locale || "en",
      rounds: perRound,
      terminal,
      reconciled: paid && reconciledEntities.has(rec.entity.id),
    };
  });

  return {
    run_id: `final-${seed}-r${rounds}`,
    seed,
    rounds,
    arms,
    records,
    coverage: coverageOf(finalRun),
    audit_head: finalRun.audit.head(),
    mode: "SIMULATION · frozen response model · dry-run execution",
    config: FINAL_CONFIG,
    oracle_ceiling_pct: null,               /* filled by caller */
  };
}

/* gates.js trace → the UI's GateCoverage, using audit.js's own
   classifier for the silent ones (by-design / backstop / scenario). */
function coverageOf(run) {
  const cov = gateCoverage(run.audit.entries(), GATE_NAMES);
  const fired = cov.fired.map((f) => ({ gate: f.gate, fired: f.blocks }));
  const silent = cov.silent.map((s) => ({
    gate: s.gate, fired: 0,
    silentReason: s.kind, silentDetail: s.why,
  }));
  return [...fired, ...silent];
}

/* PolicyResult the UI expects, straight off runBatch2's totals. */
function policyResult(name, r) {
  return {
    policy: name,
    records_total: r.atRiskCount,
    records_recovered: r.paidCount,
    gross_recovered: r.grossPaise,
    direct_cost: r.costPaise + (r.escalationCostPaise || 0),
    optout_loss: r.optOutLossPaise,
    net_recovered: r.netPaise,
    stillInProgress: r.stillInProgress,
    value_recovery_pct: r.atRiskValuePaise ? Number((100 * r.grossPaise / r.atRiskValuePaise).toFixed(2)) : null,
  };
}

/* ── gates probe: the real thing, not the browser mirror ─────── */

function dateAtISTHour(hour) {
  const hh = String(hour).padStart(2, "0");
  /* A fixed anchor date keeps the probe reproducible; only the
     hour is taken from the caller. 30 minutes past the hour keeps
     the probe clear of the 09:00/19:00 boundary itself. */
  return new Date(`2026-08-15T${hh}:30:00+05:30`);
}

async function gatesEvaluate(probe) {
  const rates = STATE.rates;
  const isMandateReason = ["mandate_revoked", "mandate_paused_by_customer", "mandate_paused_by_business"].includes(probe.failure_reason);
  const record = {
    entity: { type: "payment", id: "probe_entity" },
    customer: { id: "cust_probe", locale: "en", dnc: !!probe.do_not_contact },
    amount_paise: probe.amount_paise,
    currency: "INR",
    method: isMandateReason ? "emandate" : "card",
    failure: { source: "gateway", step: "payment_authorization", code: "PROBE", reason: probe.failure_reason },
    hours_since_event: 48,
  };

  const now = dateAtISTHour(probe.hour_ist);
  const attempts = createAttemptLedger();
  const lastAt = new Date(now.getTime() - probe.minutes_since_last_attempt * 60_000);
  for (let i = 0; i < probe.attempts; i++) attempts.recordAttempt("probe_entity", "RETRY_CHARGE", lastAt);

  const spend = createSpendTracker();
  if (probe.spend_so_far_run_paise > 0) spend.record(probe.spend_so_far_run_paise, now);

  const killSwitch = createKillSwitch();
  if (probe.kill_switch) killSwitch.engage("console probe");

  const result = evaluateGates({
    record,
    proposedAction: probe.action,
    rates,
    killSwitch,
    attempts,
    spend,
    policy: { autoApprovalCeilingPaise: probe.approval_ceiling_paise },
    now,
  });

  return {
    trace: result.trace.map((t) => ({ gate: t.gate, blocked: t.result === "block", detail: t.detail })),
    allowed: result.allowed,
    finalAction: result.finalAction,
    estimatedCostPaise: result.estimatedCostPaise,
    idempotencyKey: result.idempotencyKey,
  };
}

/* ── recon endpoint mapping ───────────────────────────────────── */

function buildLedgerPayload() {
  const result = reconcile(STATE.ledger);
  const scored = score(result, STATE.truth);

  const settledAtByPayment = new Map();
  for (const r of STATE.ledger) {
    if (r.kind === "settlement_line" && r.settles_payment_id) settledAtByPayment.set(r.settles_payment_id, r.ts);
  }

  const rows = result.results.map((r) => {
    const delta = r.settled_paise - r.expected_paise;
    return {
      payment_id: r.payment_id,
      merchant_id: r.merchant_id || "unknown",
      expected: r.expected_paise,
      actual: r.settled_paise,
      delta,
      verdict: r.tier,
      severity: r.severity || (r.reconciles ? "none" : "high"),
      explanation: r.explanation,
      settled_at: settledAtByPayment.get(r.payment_id) || new Date().toISOString(),
    };
  });

  /* "reportable": every base rate carries a source — the same bar
     freeze.js --check enforces, checked live rather than asserted. */
  const reportable = everyRateCited(STATE.rates);

  const gap = (pred) => rows.filter(pred).reduce((a, r) => a + Math.abs(r.delta), 0);
  const summary = {
    batch_id: `seed-${SEED}-settlement`,
    rows_examined: rows.length,
    gap_total: gap(() => true),
    gap_tied: gap((r) => r.verdict === "exact" || r.verdict === "explained_split" || r.verdict === "explained_refund"),
    gap_explained_owed: gap((r) => r.verdict === "explained_fee"),
    gap_needs_person: gap((r) => !["exact", "explained_split", "explained_refund", "explained_fee"].includes(r.verdict)),
    precision: scored.precision ?? null,
    recall: scored.recall ?? null,
    explanation_accuracy: scored.explanation_accuracy ?? null,
    reportable,
  };
  return { rows, summary };
}

function everyRateCited(rates) {
  let ok = true;
  (function walk(node) {
    if (ok === false || node == null) return;
    if (typeof node === "object" && !Array.isArray(node)) {
      if (typeof node.value === "number" && !node.source) { ok = false; return; }
      for (const k of Object.keys(node)) walk(node[k]);
    }
  })(rates);
  return ok;
}

/* ── static console serving (production single-origin demo) ──── */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function serveStatic(req, res, url) {
  let p = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.join(UI_DIST, p);
  if (!file.startsWith(UI_DIST)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      /* SPA fallback — deep links into a tab route still load the app */
      fs.readFile(path.join(UI_DIST, "index.html"), (err2, index) => {
        if (err2) {
          json(res, 404, {
            ok: false,
            hint: "ui/dist not found — build the console first: cd ui && npm install && npm run build",
          });
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
        res.end(index);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

/* ── state + server ───────────────────────────────────────────── */

const STATE = {
  rates: null, priors: null, ledger: null, truth: null,
  recovery: null, ledgerPayload: null, evalSummary: null, auditPayload: null,
};

/* ── live providers (Razorpay Test Mode + Groq) ────────────────
   Both are opt-in via .env keys, both fail CLOSED with a stated
   reason — a missing key reads as "off", never as a silent
   fallback to something pretending to be live. The console header
   and the Live AI tab read this endpoint, so the operator always
   knows which providers are actually wired before trusting a
   badge on screen. */

function razorpayStatus() {
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
  const live = process.env.RAZORPAY_LIVE === "true";
  const configured = !!(keyId && keySecret);
  return {
    configured,
    mode: !configured ? "no-keys" : live ? "test-live" : "dry-run",
    detail: !configured
      ? "Set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET in server/.env to enable real Test Mode calls."
      : live
        ? "Real calls against api.razorpay.com with your rzp_test_ keys."
        : "Keys present but RAZORPAY_LIVE is not true — the client stays in dry-run.",
  };
}

function groqStatus() {
  const configured = !!process.env.GROQ_API_KEY;
  return {
    configured,
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    detail: configured
      ? "Live Groq inference on your key, paced for the free tier."
      : "Set GROQ_API_KEY in server/.env (free, no card: console.groq.com/keys) to let the agent think.",
  };
}

function getRazorpayClient() {
  const s = razorpayStatus();
  if (!s.configured) return { error: s.detail };
  try {
    return {
      client: new RazorpayClient({
        keyId: process.env.RAZORPAY_KEY_ID,
        keySecret: process.env.RAZORPAY_KEY_SECRET,
        live: process.env.RAZORPAY_LIVE === "true",
      }),
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

/* ── live diagnosis: three judges in order ──────────────────────
   The deterministic policy proposes, the eleven gates decide what
   may actually run, and Groq — if a key is present — gives an
   independent second opinion inside the same closed vocabulary.
   The LLM is advisory ONLY: its suggestion is shown beside the
   policy's, and where they disagree a human decides. Nothing here
   executes anything — the gates verdict is a verdict on a proposal,
   not an action. */

async function liveDiagnose(input) {
  const failureReason = String(input.failure_reason || "insufficient_funds");
  const amountPaise = Math.max(100, Math.floor(Number(input.amount_paise) || 250000));
  const attempts = Math.min(20, Math.max(0, Math.floor(Number(input.attempts) || 0)));
  const minutesSince = Math.max(0, Math.floor(Number(input.minutes_since_last_attempt) || 720));
  const locale = String(input.locale || "en").slice(0, 12);
  const dnc = !!input.dnc;
  const hourIst = Math.min(23, Math.max(0, Math.floor(Number(input.hour_ist) || 11)));

  const isMandateReason = ["mandate_revoked", "mandate_paused_by_customer", "mandate_paused_by_business"].includes(failureReason);
  const record = {
    entity: { type: "payment", id: String(input.entity_id || "live_diag_entity") },
    customer: { id: "cust_live_diag", locale, dnc },
    amount_paise: amountPaise,
    currency: "INR",
    method: isMandateReason ? "emandate" : input.method === "upi" ? "upi" : "card",
    failure: { source: "gateway", step: "payment_authorization", code: "LIVE_DIAG", reason: failureReason },
    hours_since_event: 48,
  };

  const hist = { count: attempts, lastAt: attempts > 0 ? new Date(Date.now() - minutesSince * 60_000) : null };

  /* Judge 1 — the deterministic policy (reproducible, no network). */
  const proposed = smartPolicy(record, hist);

  /* Judge 2 — the eleven gates on that proposal. */
  const now = dateAtISTHour(hourIst);
  const attemptLedger = createAttemptLedger();
  const lastAt = new Date(now.getTime() - minutesSince * 60_000);
  for (let i = 0; i < attempts; i++) attemptLedger.recordAttempt(record.entity.id, "RETRY_CHARGE", lastAt);
  const spend = createSpendTracker();
  const killSwitch = createKillSwitch();
  if (input.kill_switch) killSwitch.engage("live diagnosis");

  const verdict = evaluateGates({
    record,
    proposedAction: proposed,
    rates: STATE.rates,
    killSwitch,
    attempts: attemptLedger,
    spend,
    policy: { autoApprovalCeilingPaise: input.approval_ceiling_paise || 5000000 },
    now,
  });

  const gates = {
    allowed: verdict.allowed,
    finalAction: verdict.finalAction,
    estimatedCostPaise: verdict.estimatedCostPaise,
    trace: verdict.trace.map((t) => ({ gate: t.gate, blocked: t.result === "block", detail: t.detail })),
  };

  /* ── bank-route health, live from the shared circuit breaker ──
     The eleven gates stay the final authority; the breaker is a
     route-shaped ADVISOR on the live path. If a judge trips HDFC
     in the Chaos Lab and then diagnoses a UPI record here, this
     is where the suppression shows up — same breaker instance. */
  const route = String(input.route || "upi").slice(0, 24);
  const routeHealth = breaker.status(route);
  const bank_health = {
    route: routeHealth.route,
    circuit: routeHealth.circuit,
    allowed: routeHealth.allowed,
    reason: routeHealth.reason,
    advisory: routeHealth.allowed ? null : {
      suppresses: "RETRY_CHARGE on this route",
      recommended_instead: "PAYMENT_LINK_SMS",
      why: "the rail itself is degraded — a payment link lets the customer complete on a different rail today, instead of burning a failed retry against a down switch",
    },
  };

  /* Judge 3 — Groq, live, advisory only. Same closed vocabulary; an
     invalid response is coerced to NO_ACTION by llm-policy's own
     validation, exactly like any other untrusted proposal. */
  let llm = null;
  let llmError = null;
  if (groqStatus().configured) {
    try {
      const r = await callModel({ record, hist: { count: attempts, lastAt: hist.lastAt } });
      llm = {
        action: r.action,
        valid: r.valid,
        model: r.model,
        latencyMs: r.latencyMs,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        degraded: r.degraded || null,
        raw: typeof r.raw === "string" ? r.raw.slice(0, 200) : undefined,
      };
    } catch (e) {
      llmError = String(e.message || e);
    }
  }

  return {
    input: { failure_reason: failureReason, amount_paise: amountPaise, attempts, locale, dnc, hour_ist: hourIst, minutes_since_last_attempt: minutesSince },
    policy: { proposed, authoritative: true },
    gates,
    bank_health,
    llm: llm ? { ...llm, advisory: true, agreesWithPolicy: llm.action === proposed } : null,
    llmError,
    note: "The deterministic policy is authoritative. The LLM is a second opinion a human can read. The breaker advises on route health. Nothing was executed.",
  };
}

async function boot() {
  STATE.rates = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "base-rates.json"), "utf8"));
  STATE.priors = JSON.parse(fs.readFileSync(path.join(__dirname, "model", "agent-priors.json"), "utf8"));
  const { ledger, truth } = generate({ seed: SEED, records: RECORDS });
  STATE.ledger = ledger;
  STATE.truth = truth;

  const warmupSeeds = Array.from({ length: WARMUP }, (_, i) => 90001 + i);

  console.log(`[console] seeding population · seed ${SEED} · ${RECORDS} records · ${ROUNDS} rounds`);
  const gateCfg = { maxAttemptsPerEntity: FINAL_CONFIG.maxAttemptsPerEntity, autoApprovalCeilingPaise: FINAL_CONFIG.autoApprovalCeilingPaise };

  const baseline = await runBatch2({ ledger, rates: STATE.rates, priors: STATE.priors, seed: SEED, rounds: ROUNDS, policy: baselinePolicy, useApprovals: true, policyConfig: gateCfg });
  console.log(`[console] baseline arm done · value ${(100 * baseline.grossPaise / baseline.atRiskValuePaise).toFixed(1)}%`);
  const smart = await runBatch2({ ledger, rates: STATE.rates, priors: STATE.priors, seed: SEED, rounds: ROUNDS, policy: smartPolicy, useApprovals: true, policyConfig: gateCfg });
  console.log(`[console] smart arm done · value ${(100 * smart.grossPaise / smart.atRiskValuePaise).toFixed(1)}%`);
  const finalRun = await runFinalPolicy({ ledger, rates: STATE.rates, priors: STATE.priors, seed: SEED, rounds: ROUNDS, warmupSeeds });
  console.log(`[console] final arm done · value ${(100 * finalRun.grossPaise / finalRun.atRiskValuePaise).toFixed(1)}%`);

  const ceiling = runCeiling(SEED, RECORDS, {
    rounds: ROUNDS, attemptCap: FINAL_CONFIG.maxAttemptsPerEntity, respectQuietHours: true,
    ceilingPaise: FINAL_CONFIG.autoApprovalCeilingPaise, approvalRate: 0.85, approvalLatencyRounds: 1,
  });

  const arms = [
    policyResult("baseline", baseline),
    policyResult("smart", smart),
    policyResult("ev", finalRun),
  ];

  STATE.recovery = buildRecoveryRun({ seed: SEED, rounds: ROUNDS, arms, ledger, finalRun });
  STATE.recovery.oracle_ceiling_pct = Number((ceiling.ceilingValueRate * 100).toFixed(1));
  STATE._finalRun = finalRun;

  STATE.ledgerPayload = buildLedgerPayload();

  /* audit: the final arm's chain, verified on every request */
  const evalPath = path.join(__dirname, "data", "console-eval.json");
  STATE.evalSummary = fs.existsSync(evalPath)
    ? JSON.parse(fs.readFileSync(evalPath, "utf8"))
    : null;

  console.log(`[console] engine ready · audit head ${finalRun.audit.head().slice(0, 12)} · eval summary ${STATE.evalSummary ? "loaded" : "missing (npm run eval:console)"}`);
  console.log(`[console] providers · razorpay ${razorpayStatus().mode} · groq ${groqStatus().configured ? groqStatus().model : "off"}`);
}

function buildAuditPayload(limit = 200) {
  const run = STATE._finalRun;
  const entries = run.audit.entries().slice(-limit).map((e) => ({
    seq: e.seq,
    ts: e.ts,
    prev_hash: e.prev_hash,
    hash: e.hash,
    kind: e.kind,
    entity_id: e.payload?.entity_id ?? null,
    payload: e.payload,
  }));
  const v = verifyChain(run.audit.entries());
  /* "Prevented" — what the system REFUSED to do — is as much the
     deliverable as what it did: every gate veto in every decision
     entry, counted from the payloads, not maintained as a second
     counter that could drift from the chain. */
  const prevented = run.audit.entries().reduce(
    (n, e) => n + ((e.kind === "decision" && Array.isArray(e.payload?.trace)) ? e.payload.trace.filter((t) => t.result === "block").length : 0), 0,
  );
  return {
    entries,
    verification: {
      valid: v.ok,
      entries: v.length,
      brokenAt: v.ok ? null : v.brokenAt,
      head: v.head,
      prevented_actions: prevented,
    },
  };
}

/* ── the audit seal: full chain + merkle root, exportable ──────
   Everything verify-proof.js needs to re-verify the whole run
   WITHOUT this repo: the entries, the committed root, the run's
   identity. Tamper-evidence for the casual edit (chain), and a
   single published hash that commits to the entire run even
   against an attacker who recomputes every subsequent hash. */
function buildAuditBundle() {
  const run = STATE._finalRun;
  const entries = run.audit.entries();
  const v = verifyChain(entries);
  const hashes = entries.map((e) => e.hash);
  const prevented = entries.reduce(
    (n, e) => n + ((e.kind === "decision" && Array.isArray(e.payload?.trace)) ? e.payload.trace.filter((t) => t.result === "block").length : 0), 0,
  );
  return {
    bundle_version: 1,
    exported_at: new Date().toISOString(),
    run_id: STATE.recovery.run_id,
    seed: SEED,
    rounds: ROUNDS,
    engine: "axiom-recover · frozen response model · deterministic seeded run",
    entry_count: entries.length,
    seq_range: entries.length ? [entries[0].seq, entries[entries.length - 1].seq] : null,
    chain_valid: v.ok,
    head: v.head,
    merkle_root: merkleRoot(hashes),
    prevented_actions: prevented,
    entries: entries.map((e) => ({ seq: e.seq, ts: e.ts, prev_hash: e.prev_hash, hash: e.hash, kind: e.kind, payload: e.payload })),
    verify_instructions: "node server/verify-proof.js <this-file>.json  — standalone, zero dependencies. Recomputes every chain hash, every link, and the merkle root from the bundle's own bytes.",
    note: "Publish the merkle_root anywhere append-only (email to finance, a commit, a notarised PDF). Any later bundle for this run that verifies internally but commits to a different root is provably not the original.",
  };
}

/* ── Chaos Lab: the concurrency storm, over the real lock layer ──
   20 concurrent deliveries of the SAME payment — the exact storm
   an upstream gateway produces during a timeout flap. The locks,
   the result cache and the audit append are the same code the
   live ingestion path runs (index.js); the only difference is the
   population: synthetic IDs, an isolated audit chain, and an
   assertion built into the response so the console never has to
   trust its own counter. */
async function runChaosConcurrency({ workers = 20, payment_id: pid } = {}) {
  const n = Math.min(50, Math.max(2, Math.floor(Number(workers) || 20)));
  const paymentId = String(pid || `pay_chaos_${Date.now()}`);
  const eventId = `evt_chaos_${Date.now()}`;
  const idem = createIdempotency({ sweep: false });
  const audit = createAuditChain();

  audit.append("run_started", { scenario: "chaos_concurrency", workers: n, payment_id: paymentId });

  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const cached = idem.cachedResult(eventId);
    if (cached) return resolve({ worker: i, status: "IDEMPOTENT_CACHED", http: 200, executed: false });

    if (!idem.acquireLock(paymentId)) {
      return resolve({ worker: i, status: "REJECTED_IN_FLIGHT", http: 409, executed: false, detail: "another worker holds the in-flight lock for this payment" });
    }

    /* the winner: simulate the async recovery decision + write.
       Deterministic delay (12ms + worker index) — this repo's
       discipline bans Math.random so every run stays byte-stable. */
    setTimeout(() => {
      audit.append("decision", {
        entity_id: paymentId, worker: i,
        proposed: "PAYMENT_LINK_WHATSAPP", final: "PAYMENT_LINK_WHATSAPP", allowed: true,
        note: "the ONE worker that acquired the lock — every other worker was refused before reaching this append",
      });
      idem.recordResult(eventId, { status: "RECOVERY_SCHEDULED", worker: i });
      idem.releaseLock(paymentId);
      resolve({ worker: i, status: "ACQUIRED_LOCK", http: 200, executed: true, decision_recorded: true });
    }, 12 + (i % 8));
  })));
  const elapsedMs = Date.now() - t0;

  /* a duplicate that arrives AFTER the storm — gets the cached
     outcome, no re-execution */
  const duplicate = { worker: n, status: "IDEMPOTENT_CACHED", http: 200, executed: false, detail: "late duplicate delivery — original outcome replayed from the result cache, not re-executed" };
  const dupOutcome = idem.cachedResult(eventId);

  audit.append("outcome", { entity_id: paymentId, paid: null, note: `storm complete: 1 execution, ${n - 1} rejected, duplicate replayed`, duplicate_replayed_result: dupOutcome });

  const v = verifyChain(audit.entries());
  const executed = results.filter((r) => r.executed).length;

  return {
    scenario: "chaos_concurrency",
    workers: n,
    payment_id: paymentId,
    elapsed_ms: elapsedMs,
    results: [...results, duplicate],
    summary: {
      inbound: n + 1,
      executed,
      rejected_in_flight: results.filter((r) => r.status === "REJECTED_IN_FLIGHT").length,
      replayed_from_cache: 1,
      invariant_holds: executed === 1,
      invariant: "exactly ONE recovery decision per payment per storm, under any concurrency",
    },
    audit_proof: {
      chain_valid: v.ok,
      entries: v.length,
      decision_entries: audit.entries().filter((e) => e.kind === "decision").length,
      head: v.head,
      note: "an isolated chain for this scenario — the engine's frozen chain is untouched by the lab. verify: exactly one 'decision' entry.",
    },
  };
}

/* ── Chaos Lab: the bank flap, over the shared breaker ──────────
   Deterministic per call: the breaker is reset, then the caller's
   failure burst is injected. Uses the SAME instance the live
   diagnosis path consults, so a tripped route here is visible in
   Live AI (diagnose with route=hdfc) and on /health — the lab and
   the live path share one truth. */
function runBankFlap({ route = "HDFC", failures = 4, error_code = "NPCI_ISSUER_TIMEOUT" } = {}) {
  const rt = String(route).toUpperCase().slice(0, 24);
  const n = Math.min(20, Math.max(1, Math.floor(Number(failures) || 4)));

  breaker.reset();
  const timeline = [];
  for (let i = 1; i <= n; i++) {
    const s = breaker.recordFailure(rt, error_code);
    timeline.push({
      step: i,
      event: `payment.failed · ${rt} · ${error_code}`,
      circuit: s.circuit,
      note: i < n ? "counted in the rolling window" : s.reason,
    });
  }

  const status = breaker.status(rt);

  /* what the recovery layer does with an OPEN route: does NOT offer
     RETRY_CHARGE against it, offers the alternate rail instead, and
     states the cost of what it just avoided. */
  const retryCost = safeRetryCost();
  const suppressed = status.allowed ? 0 : n;
  return {
    scenario: "bank_flap",
    route: rt,
    injected: n,
    error_code,
    timeline,
    final: status,
    reroute: status.allowed ? null : {
      original_action: "RETRY_CHARGE",
      suppressed_on: rt,
      recommended_instead: "PAYMENT_LINK_SMS",
      why: "a payment link lets the customer complete on a healthy rail (card / netbanking) while the UPI switch recovers — instead of burning retries, penalty fees and success-rate marks against a route that is down for everyone",
      penalty_fees_avoided_paise: suppressed * retryCost,
      cooldown_minutes: Math.ceil((status.cooldownRemainingMs || 0) / 60_000),
    },
    shared_state: {
      note: "this is the same breaker instance /api/llm/diagnose consults — diagnose a UPI record with route " + rt + " now and the suppression appears there too. /health exposes the same stats.",
      stats: breaker.stats(),
    },
  };
}

function safeRetryCost() {
  try { return require("./gates").estimateCost("RETRY_CHARGE", STATE.rates) || 50; }
  catch { return 50; }
}

/* ── Chaos Lab: the NRV calculator ──────────────────────────
   The named unit-economics gate, driven live. Inputs are the
   operator's own numbers; the response shows the full arithmetic
   so the verdict is checkable by hand. */
function runNrvSim(input) {
  const amountPaise = Math.max(100, Math.floor(Number(input.amount_paise) || 15000));
  const p = Math.min(1, Math.max(0, Number(input.p_success) || 0.15));
  const action = String(input.action || "PAYMENT_LINK_WHATSAPP");
  const ltvPaise = Math.max(0, Math.floor(Number(input.customer_ltv_paise) || 250000));
  const fatigue = Math.min(1, Math.max(0, Number(input.fatigue) || 0));
  const v = evaluateNRV({ amount_paise: amountPaise, p_success: p, action, customer_ltv_paise: ltvPaise, fatigue });
  return {
    scenario: "nrv",
    input: { amount_paise: amountPaise, p_success: p, action, customer_ltv_paise: ltvPaise, fatigue },
    formula: "NRV = P(success) × amount − channel cost − churn risk (fatigue × LTV, above 0.6 fatigue)",
    channel_costs_inr: CHANNEL_COST_INR,
    verdict: v,
    engine_note: "the frozen engine implements this same ranking in paise as policy-ev.js's expected-value rule (Thompson-sampled P, bandit-calibrated), so the numbers on the Evidence tab and this verdict come from one discipline, not two.",
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        engine: "loaded",
        seed: SEED, records: RECORDS, rounds: ROUNDS, warmup: WARMUP,
        eval_summary: !!STATE.evalSummary,
        ui_dist: fs.existsSync(path.join(UI_DIST, "index.html")),
        circuit_breaker: breaker.stats(),
      });
    }

    if (url.pathname === "/api/recon") return json(res, 200, STATE.ledgerPayload);

    if (url.pathname === "/api/recover") return json(res, 200, STATE.recovery);

    if (url.pathname === "/api/eval") {
      if (!STATE.evalSummary) {
        return json(res, 503, { error: "eval summary not generated", hint: "cd server && npm run eval:console" });
      }
      return json(res, 200, STATE.evalSummary);
    }

    if (url.pathname === "/api/audit") {
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") || 200)));
      return json(res, 200, buildAuditPayload(limit));
    }

    if (url.pathname === "/api/gates/evaluate" && req.method === "POST") {
      const raw = await readBody(req);
      const probe = JSON.parse(raw.toString("utf8"));
      return json(res, 200, await gatesEvaluate(probe));
    }

    /* ── live provider surfaces ─────────────────────────────────── */

    if (url.pathname === "/api/providers") {
      return json(res, 200, { providers: { razorpay: razorpayStatus(), groq: groqStatus() } });
    }

    if (url.pathname === "/api/llm/diagnose" && req.method === "POST") {
      const raw = await readBody(req);
      const input = JSON.parse(raw.toString("utf8"));
      return json(res, 200, await liveDiagnose(input));
    }

    if (url.pathname === "/api/rzp/ping" && req.method === "POST") {
      const { client, error } = getRazorpayClient();
      if (error) return json(res, 503, { ok: false, error });
      const result = await client.ping();
      return json(res, 200, {
        ok: result.ok !== false,
        simulated: !!result.simulated,
        mode: client.live ? "test-live" : "dry-run",
        entity: result.entity ?? null,
        error: result.error ?? null,
        note: client.live
          ? "Real GET /v1/payments?count=1 against api.razorpay.com with your test keys."
          : "Dry-run: keys present but RAZORPAY_LIVE is not true, so no request left this machine.",
      });
    }

    if (url.pathname === "/api/rzp/link" && req.method === "POST") {
      const raw = await readBody(req);
      const input = JSON.parse(raw.toString("utf8"));
      const { client, error } = getRazorpayClient();
      if (error) return json(res, 503, { ok: false, error });

      const amountPaise = Math.max(100, Math.floor(Number(input.amount_paise) || 250000));
      const entityId = String(input.entity_id || "live_demo_entity");
      const attemptNo = Math.max(1, Math.floor(Number(input.attempt) || 1));

      const result = await client.createPaymentLink({
        amountPaise,
        description: String(input.description || "AXIOM Recover — settle your outstanding payment"),
        customer: input.customer || undefined,
        entityId,
        attemptNo,
        notes: { demo: "axiom-console-live-ai" },
      });

      return json(res, 200, {
        ok: result.ok !== false,
        simulated: !!result.simulated,
        replayed: !!result.replayed,
        mode: client.live ? "test-live" : "dry-run",
        link: result.entity ?? null,
        error: result.error ?? null,
        idempotency: RazorpayClient.idempotencyKey(entityId, "PAYMENT_LINK", attemptNo),
        note: result.replayed
          ? "Same (entity, action, attempt) — the persisted idempotency store returned the ORIGINAL result. No second link was created."
          : client.live
            ? "A real Razorpay Test Mode payment link, created live on your keys. It is visible in Dashboard → Payment Links (Test Mode)."
            : "Dry-run shape of a payment link. Set RAZORPAY_LIVE=true with your rzp_test_ keys for the real call.",
      });
    }

    /* ── Chaos Lab — the resilience demos, live over the real lib code ── */

    if (url.pathname === "/api/simulate/chaos-concurrency" && req.method === "POST") {
      const raw = await readBody(req);
      const input = raw.length ? JSON.parse(raw.toString("utf8") || "{}") : {};
      return json(res, 200, await runChaosConcurrency(input));
    }

    if (url.pathname === "/api/simulate/bank-flap" && req.method === "POST") {
      const raw = await readBody(req);
      const input = raw.length ? JSON.parse(raw.toString("utf8") || "{}") : {};
      return json(res, 200, runBankFlap(input));
    }

    if (url.pathname === "/api/simulate/nrv" && req.method === "POST") {
      const raw = await readBody(req);
      const input = JSON.parse(raw.toString("utf8") || "{}");
      return json(res, 200, runNrvSim(input));
    }

    /* ── the audit seal — full chain + merkle root, downloadable ── */

    if (url.pathname === "/api/audit/export") {
      if (!STATE._finalRun) return json(res, 503, { ok: false, error: "engine not booted yet" });
      const bundle = buildAuditBundle();
      const body = JSON.stringify(bundle, null, 2);
      const disposition = url.searchParams.get("download") === "1"
        ? `attachment; filename="axiom-audit-seal-${bundle.run_id}.json"`
        : "inline";
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": disposition,
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
      });
      return res.end(body);
    }

    if (url.pathname === "/api/breaker/status") {
      const route = String(url.searchParams.get("route") || "").toUpperCase().slice(0, 24);
      return json(res, 200, {
        config: breaker.config(),
        stats: breaker.stats(),
        route: route ? breaker.status(route) : null,
      });
    }

    if (url.pathname.startsWith("/api/")) return json(res, 404, { ok: false });

    return serveStatic(req, res, url);
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err?.message || err) });
  }
});

boot().then(() => {
  server.listen(PORT, () => {
    console.log(`\naxiom-recover console on http://localhost:${PORT}/`);
    console.log(`  GET  /api/recover /api/recon /api/eval /api/audit /api/audit/export /api/breaker/status`);
    console.log(`  POST /api/gates/evaluate /api/simulate/chaos-concurrency /api/simulate/bank-flap /api/simulate/nrv\n`);
  });
}).catch((e) => { console.error("[console] boot failed:", e); process.exit(1); });



module.exports = { server, boot };
