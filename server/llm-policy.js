"use strict";
/* ══════════════════════════════════════════════════════════════
   LLM POLICY — a third arm, held to the same bar as the other two
   ──────────────────────────────────────────────────────────────
   baselinePolicy and smartPolicy are pure, synchronous, and
   perfectly reproducible. This one is none of those things, on
   purpose — an LLM call is a network request and its output is
   not guaranteed byte-identical across runs even at temperature 0.
   Isolating it in its own file, rather than folding it into
   recover.js, keeps that difference visible rather than hidden
   inside a file the rest of the project treats as deterministic.

   ── Why Groq, specifically — a decision that changed mid-build ──
   This project runs on a zero-investment budget: a real constraint,
   not a slogan. The first version of this file called Anthropic's
   paid API — a few paise per call, genuinely small, but genuinely
   not zero, which is a real mismatch with that budget and was
   correctly called out rather than left alone.

   Groq's free tier is checked here against its OWN current terms,
   not assumed from memory: no credit card, access gated by rate
   limits rather than a per-token charge — 30 requests/minute,
   6,000 tokens/minute, 14,400 requests/day, at the organisation
   level (multiple keys do not raise this). Source:
   https://console.groq.com/docs/rate-limits

   ── A model name that would have shipped broken ─────────────────
   The obvious small/fast choice, llama-3.1-8b-instant, is what
   training data would suggest by default. Checking Groq's live
   deprecations page before writing this found that Groq announced
   its retirement on June 17, 2026 and shut it down on August 16,
   2026 — before this file was written. Shipping that model string
   would have failed on the first real call, on every machine,
   forever, and looked like a mystery bug to anyone who hit it.
   The verified current replacement, per Groq's own migration
   guidance, is openai/gpt-oss-20b — the smallest current model in
   the family Groq recommends replacing it with, matching the
   original reasoning (a structured 8-way classification does not
   need the 120b-parameter version). Source:
   https://console.groq.com/docs/deprecations

   ── What is deterministic here, and what genuinely is not ──────
   The PROMPT is deterministic — built only from fields already in
   the canonical record, temperature 0. The RESPONSE is not
   guaranteed deterministic run to run. eval.js's multi-seed sweep
   is deliberately NOT run against this policy for that reason:
   repeating an unreliable measurement many times does not make it
   reliable, it makes it an expensive unreliable measurement.

   ── Rate-limit pacing is not optional on a free tier ────────────
   30 requests/minute means one call roughly every two seconds is
   already at the ceiling. A tight loop that fires calls back to
   back would exhaust the per-minute cap in under 30 requests and
   start failing — a paid tier with a generous limit could absorb
   that mistake silently; a free tier cannot, and pretending
   otherwise would make the "zero investment" claim work in a demo
   and break for the next person who runs it. Every call here is
   paced, and a 429 gets a real backoff-and-retry rather than an
   immediate failure.

   ── Every safety property from the rest of the project still applies
   The model's raw output is untrusted input, validated against the
   exact same closed INTERVENTIONS vocabulary gates.js enforces. An
   invalid or unparseable response is coerced to NO_ACTION and
   logged — the same treatment any other malformed proposal gets.
   This is also the first policy in the project that can genuinely
   produce an invalid proposal in normal operation, which means it
   is the first time gates.js's action_allowlist gate is exercised
   by something other than a unit test.

   ── Requires ────────────────────────────────────────────────────
     GROQ_API_KEY   in the environment. Absent it, this file throws
                    with a clear message rather than silently
                    falling back to a different policy — a silent
                    fallback would make a missing key look like a
                    working comparison. Get one free, no card, at
                    https://console.groq.com/keys
   ══════════════════════════════════════════════════════════════ */

const API_URL = "https://api.groq.com/openai/v1/chat/completions";
/* Verified current (checked against console.groq.com/docs/deprecations
   at build time, not recalled from training data — see file header).
   Overridable via GROQ_MODEL so this doesn't silently go stale the
   next time Groq retires a model. */
const DEFAULT_MODEL = "openai/gpt-oss-20b";

/* Free-tier ceiling, organisation-wide, per Groq's own docs. Kept
   as named constants so the pacing math below is traceable to a
   real, cited number rather than a guessed delay. */
const FREE_TIER_RPM = 30;
const PACE_MS = Math.ceil(60000 / FREE_TIER_RPM) + 100;   // ~2.1s between calls, with headroom
const MAX_RETRIES_ON_429 = 3;

const VALID_ACTIONS = Object.freeze([
  "NO_ACTION", "RETRY_CHARGE", "PAYMENT_LINK_SMS", "PAYMENT_LINK_WHATSAPP",
  "DUNNING_EMAIL", "VOICE_NUDGE_REGIONAL", "ESCALATE_HUMAN", "WRITE_OFF",
]);

const SYSTEM_PROMPT = `You are a payment-recovery decision function for an Indian merchant on Razorpay.

You will be given one at-risk payment record. Choose exactly ONE recovery action from this closed list:

  NO_ACTION              do nothing this round
  RETRY_CHARGE            silently retry the charge (only meaningful for a card/UPI/e-mandate payment, never a paused or revoked mandate)
  PAYMENT_LINK_SMS        send an SMS with a payment link
  PAYMENT_LINK_WHATSAPP   send a WhatsApp message with a payment link
  DUNNING_EMAIL           send a reminder email
  VOICE_NUDGE_REGIONAL    a voice message in the customer's own language
  ESCALATE_HUMAN          hand this to a human to decide
  WRITE_OFF               give up on this record

Rules you must follow:
- A mandate that is revoked or paused (by either party) can NEVER be fixed by RETRY_CHARGE — there is no live authorisation to charge against.
- A mandate paused BY THE BUSINESS cannot be fixed by messaging the customer — they are not the blocker. Choose ESCALATE_HUMAN.
- A mandate paused BY THE CUSTOMER can still be helped by one message asking them to resume it themselves.
- Do not repeatedly propose a message channel that has already been tried several times without success — escalate or write off instead.
- If the customer's locale is not English, prefer a channel that can be delivered in their language over a channel that cannot.

Respond with ONLY the action name from the list above. No punctuation, no explanation, no other text.`;

function buildUserPrompt(record, hist) {
  const lines = [
    `amount_paise: ${record.amount_paise}`,
    `method: ${record.method}`,
    `failure_reason: ${record.failure?.reason || "none"}`,
    `attempts_so_far: ${hist.count}`,
    `hours_since_last_attempt: ${hist.lastAt ? Math.round((Date.now() - new Date(hist.lastAt).getTime()) / 3.6e6) : "n/a (first attempt)"}`,
    `customer_locale: ${record.customer?.locale || "en"}`,
    `customer_on_do_not_contact_list: ${!!record.customer?.dnc}`,
  ];
  return lines.join("\n");
}

/**
 * Validate and normalise whatever text the model returned.
 * Untrusted input, exactly like a webhook payload — parsed
 * defensively, never trusted to already be well-formed.
 */
function parseAction(rawText) {
  const cleaned = String(rawText || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  if (VALID_ACTIONS.includes(cleaned)) return { action: cleaned, valid: true };
  return { action: "NO_ACTION", valid: false, raw: rawText };
}

/* Simple in-process pacer. A free-tier RPM cap is shared across
   every call this process makes, not per-caller, so one shared
   "next allowed time" clock — not a per-record timer — is what
   actually keeps the whole run under 30/minute. */
let nextAllowedAt = 0;
async function paceForFreeTier(sleepImpl) {
  const now = Date.now();
  const wait = Math.max(0, nextAllowedAt - now);
  nextAllowedAt = Math.max(now, nextAllowedAt) + PACE_MS;
  if (wait > 0) await sleepImpl(wait);
}

/**
 * Call Groq's OpenAI-compatible Messages endpoint for one decision.
 *
 * @param {object} a
 * @param {object} a.record
 * @param {object} a.hist
 * @param {object} [a.opts]
 * @param {string} [a.opts.apiKey]
 * @param {string} [a.opts.model]
 * @param {(url:string, init:object) => Promise<Response>} [a.opts.fetchImpl]
 *   Injectable so tests can supply a mocked response without a
 *   real network call — the VALIDATION and ERROR-HANDLING logic
 *   is fully testable offline, even though the live call is not.
 * @param {(ms:number) => Promise<void>} [a.opts.sleepImpl]
 *   Injectable for the same reason — tests should not actually
 *   wait 2 seconds per call.
 * @param {boolean} [a.opts.skipPacing] test-only escape hatch.
 */
async function callModel({ record, hist, opts = {} }) {
  const apiKey = opts.apiKey || process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("llmPolicy: GROQ_API_KEY is not set — the LLM arm cannot run without it. This is a hard requirement, not a fallback-and-continue, because a silently-skipped LLM call would make a missing key look like a real comparison. Get a free key, no card required, at https://console.groq.com/keys");
  }
  const model = opts.model || process.env.GROQ_MODEL || DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl || fetch;
  const sleepImpl = opts.sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const body = {
    model,
    max_tokens: 12,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(record, hist) },
    ],
  };

  let attempt = 0;
  while (true) {
    if (!opts.skipPacing) await paceForFreeTier(sleepImpl);

    const started = Date.now();
    let res, json;
    try {
      res = await fetchImpl(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      json = await res.json();
    } catch (networkErr) {
      /* A network failure degrades to NO_ACTION, not a crash and
         not a silent switch to a different policy — the record
         gets another chance next round, the same way a cooldown-
         deferred record does. */
      return { action: "NO_ACTION", valid: false, degraded: "network_error", error: networkErr.message, latencyMs: Date.now() - started, promptTokens: 0, completionTokens: 0 };
    }

    if (res.status === 429 && attempt < MAX_RETRIES_ON_429) {
      /* Free-tier rate limit hit despite pacing — a burst, a
         second process, a slightly-too-fast clock. Back off with
         growing delay rather than immediately declaring the call
         failed; a 429 is not the same kind of error as a broken
         request and does not deserve the same treatment. */
      attempt++;
      await sleepImpl(PACE_MS * attempt * 2);
      continue;
    }

    if (!res.ok) {
      return { action: "NO_ACTION", valid: false, degraded: `http_${res.status}`, error: json?.error?.message || `HTTP ${res.status}`, latencyMs: Date.now() - started, promptTokens: 0, completionTokens: 0 };
    }

    const rawText = json?.choices?.[0]?.message?.content || "";
    const parsed = parseAction(rawText);

    return {
      action: parsed.action, valid: parsed.valid, raw: rawText, model,
      latencyMs: Date.now() - started,
      promptTokens: json?.usage?.prompt_tokens || 0,
      completionTokens: json?.usage?.completion_tokens || 0,
    };
  }
}

/**
 * The policy function itself — same (record, hist, rates, opts)
 * shape as baselinePolicy/smartPolicy, so it drops into runBatch's
 * policy slot unchanged. Unlike the other two, it is async, and
 * runBatch awaits every policy call for exactly this reason.
 */
async function llmPolicy(record, hist, rates, opts) {
  const result = await callModel({ record, hist, opts });
  return result.action;
}

/**
 * Cost, honestly. On Groq's free tier this is genuinely zero —
 * gated by request-rate, not billed per token — so the function
 * returns 0 by default. It only returns a non-zero figure if the
 * caller explicitly says they are on a paid Groq account, and
 * that figure is deliberately left as a caller-supplied rate
 * rather than a hard-coded number this project has not verified
 * for openai/gpt-oss-20b specifically. Guessing a price and
 * presenting it as fact would be worse than no number at all.
 */
function estimateUsdCost(promptTokens, completionTokens, { onFreeTier = true, paidRatePerMTokUsd } = {}) {
  if (onFreeTier) return 0;
  if (!paidRatePerMTokUsd) {
    throw new Error("estimateUsdCost: not on the free tier, but no verified paidRatePerMTokUsd was supplied — refusing to guess at a price. Check console.groq.com/pricing for the current rate.");
  }
  const { input = 0, output = 0 } = paidRatePerMTokUsd;
  return (promptTokens / 1e6) * input + (completionTokens / 1e6) * output;
}

module.exports = {
  llmPolicy, callModel, buildUserPrompt, parseAction,
  VALID_ACTIONS, DEFAULT_MODEL, estimateUsdCost,
  FREE_TIER_RPM, PACE_MS,
};
