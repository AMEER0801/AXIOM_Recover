"use strict";
/* ══════════════════════════════════════════════════════════════
   CIRCUIT BREAKER — the bank-cluster outage oracle
   ──────────────────────────────────────────────────────────────
   The failure mode everyone in payments knows: an issuing bank's
   UPI switch (or NPCI itself) degrades, and every retry against
   that route adds another timeout, another penalty fee, and
   another red mark on the merchant's success-rate dashboard —
   while the route is down for EVERYONE, so the retries cannot
   possibly succeed. The correct behaviour is to stop hammering
   the dead route, move what can move to another rail, and probe
   the route periodically until it recovers.

   This is the classic circuit-breaker pattern, scoped per bank
   route rather than per endpoint:

       CLOSED    failures counted in a rolling window;
                 ≥ threshold within the window → trip to OPEN.
       OPEN      retries on that route are suppressed for the
                 cooldown (default 15 minutes). Recovery traffic
                 is offered an alternate rail instead.
       HALF-OPEN after the cooldown, exactly one probe goes
                 through; success closes the circuit, failure
                 re-opens it for another cooldown.

   ── Attribution ───────────────────────────────────────────────
   Failures are attributed to a route key derived from what the
   webhook actually carries (error_source / method / issuer notes).
   When the payload has no bank identity, the failure lands on the
   method rail ("upi", "netbanking") — still a useful scope, and
   an honest one: we never guess a bank we were not told about.

   ── Honest scope ──────────────────────────────────────────────
   In-memory, single process, per-instance. A fleet of workers
   each trips their own breaker — which is conservative (a route
   stays suppressed per-worker until that worker sees the trip),
   not unsafe. Shared-state breakers are the documented scale-out
   path. The threshold (4), window (120s) and cooldown (15m) are
   engineering defaults, tunable per deployment, not citations.

   Verified by server/test/enterprise.test.js and drivable live
   from the console's Chaos Lab: POST /api/simulate/bank-flap.
   ══════════════════════════════════════════════════════════════ */

const CLOSED = "CLOSED";
const OPEN = "OPEN";
const HALF_OPEN = "HALF_OPEN";

function createCircuitBreaker({ threshold = 4, windowMs = 120_000, cooldownMs = 15 * 60_000 } = {}) {
  const failures = [];                       /* [{ route, at }] rolling window */
  const tripped = new Map();                 /* route -> { at, probeDone }     */
  let suppressedCount = 0;

  function prune(now = Date.now()) {
    while (failures.length && now - failures[0].at > windowMs) failures.shift();
  }

  function routeOf(bankOrRail) {
    return String(bankOrRail || "unknown").toUpperCase().slice(0, 24);
  }

  /** Record a failed attempt against a route. Returns the breaker
   *  state for that route AFTER absorbing this failure. */
  function recordFailure(route, errorCode) {
    const key = routeOf(route);
    const now = Date.now();
    prune(now);
    failures.push({ route: key, at: now, errorCode: String(errorCode || "ISSUER_DOWN") });
    const recent = failures.filter((f) => f.route === key);
    if (recent.length >= threshold && !tripped.has(key)) {
      tripped.set(key, { at: now, probeDone: false, trippedBy: recent.length });
    }
    return status(key, now);
  }

  /** Route-level status, consumed by the live path before any
   *  retry-shaped action is offered. */
  function status(route, now = Date.now()) {
    const key = routeOf(route);
    const t = tripped.get(key);
    if (!t) return { route: key, circuit: CLOSED, allowed: true, failuresInWindow: failures.filter((f) => f.route === key).length, reason: "route healthy — no systemic failure pattern observed in the rolling window" };

    if (now - t.at < cooldownMs) {
      suppressedCount += 1;
      const remainingMs = cooldownMs - (now - t.at);
      return {
        route: key,
        circuit: OPEN,
        allowed: false,
        failuresInWindow: failures.filter((f) => f.route === key).length,
        cooldownRemainingMs: remainingMs,
        reason: `systemic outage pattern on ${key}: ${failures.filter((f) => f.route === key).length} failures in the ${Math.round(windowMs / 1000)}s window — retries suppressed ${Math.ceil(remainingMs / 60_000)}m to avoid penalty fees and success-rate damage`,
      };
    }

    /* Cooldown elapsed → half-open. ONE probe may pass; the caller
       marks probeOutcome so the breaker closes or re-opens. */
    return {
      route: key,
      circuit: HALF_OPEN,
      allowed: true,
      probe: true,
      failuresInWindow: failures.filter((f) => f.route === key).length,
      reason: `cooldown elapsed — ${key} accepts exactly one probe; a failed probe re-opens the circuit, a successful one closes it`,
    };
  }

  /** Report the outcome of a half-open probe. */
  function probeOutcome(route, ok) {
    const key = routeOf(route);
    if (ok) {
      tripped.delete(key);
      /* drop that route's failures so a healthy probe is not
         instantly re-tripped by stale counts */
      for (let i = failures.length - 1; i >= 0; i--) if (failures[i].route === key) failures.splice(i, 1);
    } else {
      const prev = tripped.get(key);
      tripped.set(key, { at: Date.now(), probeDone: true, trippedBy: prev?.trippedBy || threshold });
    }
  }

  function reset() {
    failures.length = 0;
    tripped.clear();
    suppressedCount = 0;
  }

  return {
    recordFailure, status, probeOutcome, reset,
    config: () => ({ threshold, windowMs: windowMs, cooldownMs }),
    stats: () => ({
      open_routes: [...tripped.keys()],
      window_failures: failures.length,
      retries_suppressed: suppressedCount,
    }),
  };
}

/* Shared instance: the ingestion server feeds it real failures,
   the console's Chaos Lab can inject synthetic ones, and the live
   diagnosis path consults it. All against the same breaker, so a
   trip caused by real traffic is visible in the console. */
const shared = createCircuitBreaker();

module.exports = { createCircuitBreaker, breaker: shared, CLOSED, OPEN, HALF_OPEN };
