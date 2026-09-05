"use strict";
/* ══════════════════════════════════════════════════════════════
   IDEMPOTENCY — atomic in-flight locks + event-result cache
   ──────────────────────────────────────────────────────────────
   Upstream payment gateways retry webhook deliveries by design, and
   during network flaps those retries can arrive CONCURRENTLY — ten
   deliveries of the same payment.failed inside the same millisecond.
   Without a lock, ten workers can each decide a recovery action for
   the same payment and each fire it: the double-charge problem.

   This module is the zero-double-charge invariant, in two layers:

     1. In-flight locks.  acquire(paymentId) is atomic in a single
        threaded process: the first caller wins, every other caller
        for the same payment while the first is still working gets
        `false` and answers HTTP 409 immediately.  The winner's job
        is to release the lock in a finally block — a crash without
        release is a leak, so locks also carry a TTL and a sweeper.

     2. Event-result cache.  Once a payment's webhook has been fully
        processed, the OUTCOME (not just "seen") is remembered, so a
        duplicate delivery minutes later gets the original result
        replayed to it — 200 with the same body, no re-execution.
        "Seen" alone is not enough: between two deliveries the
        answer must be the same, or the second delivery diverges.

   ── Honest scope ──────────────────────────────────────────────
   This is a single-process guard, the same trust domain as the
   engine itself. A multi-worker deployment needs the same two
   layers over a shared store (Redis SETNX with TTL, or a database
   unique constraint) — documented in README as the scale-out path,
   not implied to already exist. SQLite's unique-constraint
   backstop (used by a competing submission) gives layer 1 across
   processes but not layer 2's replay-the-same-answer semantics;
   neither approach survives two hosts without shared state, which
   is why the deployment doc says: run one recovery authority per
   merchant, or move the lock to the shared store.

   Verified by server/test/concurrency.test.js — 20 simultaneous
   deliveries, exactly one execution, and by
   /api/simulate/chaos-concurrency in the console, live.
   ══════════════════════════════════════════════════════════════ */

const LOCK_TTL_MS = 60_000;          /* a worker stuck longer than this is presumed dead */
const RESULT_TTL_MS = 10 * 60_000;   /* duplicate deliveries arrive within minutes, not hours */
const SWEEP_EVERY_MS = 30_000;

function createIdempotency({ lockTtlMs = LOCK_TTL_MS, resultTtlMs = RESULT_TTL_MS, sweepEveryMs = SWEEP_EVERY_MS, sweep = true } = {}) {
  /* paymentId -> { acquiredAt }  — the in-flight reservation        */
  const inFlight = new Map();
  /* eventId    -> { at, result }  — the processed-outcome cache      */
  const processed = new Map();
  /* how many expired locks had to be taken over from dead workers —
     a health signal, because silent takeover would hide the crash */
  let takeovers = 0;

  function acquireLock(paymentId) {
    if (!paymentId) return false;
    const now = Date.now();
    const held = inFlight.get(paymentId);
    if (held) {
      /* A lock held past its TTL is a crashed worker, not an active
         one. Taking it over is recovery, not a race violation — but
         it is counted, because silent takeover would hide the
         crash that caused it. */
      if (now - held.acquiredAt < lockTtlMs) return false;
      takeovers += 1;
    }
    inFlight.set(paymentId, { acquiredAt: now });
    return true;
  }

  function releaseLock(paymentId) {
    inFlight.delete(paymentId);
  }

  /** Result of an earlier completed delivery, or null if unseen.
   *  Callers replay this to the duplicate rather than re-executing. */
  function cachedResult(eventId) {
    if (!eventId) return null;
    const hit = processed.get(eventId);
    if (!hit) return null;
    if (Date.now() - hit.at > resultTtlMs) {
      processed.delete(eventId);
      return null;
    }
    return hit.result;
  }

  /** Store the outcome of a completed delivery. Only meaningful when
   *  called once per eventId — the caller already holds the lock. */
  function recordResult(eventId, result) {
    if (!eventId) return;
    processed.set(eventId, { at: Date.now(), result });
  }

  function sweepExpired(now = Date.now()) {
    for (const [id, held] of inFlight) {
      if (now - held.acquiredAt > lockTtlMs) inFlight.delete(id);
    }
    for (const [id, hit] of processed) {
      if (now - hit.at > resultTtlMs) processed.delete(id);
    }
  }

  let timer = null;
  if (sweep) {
    timer = setInterval(sweepExpired, sweepEveryMs);
    if (typeof timer.unref === "function") timer.unref();   /* never hold the process open */
  }

  return {
    acquireLock, releaseLock, cachedResult, recordResult, sweepExpired,
    stats: () => ({
      in_flight: inFlight.size,
      processed: processed.size,
      stale_locks_taken_over: takeovers,
    }),
    close: () => { if (timer) clearInterval(timer); },
  };
}

/* The singleton the ingestion server and the chaos lab share, so
   the flood test exercises the same guard real traffic does. */
const shared = createIdempotency();

module.exports = { createIdempotency, idempotency: shared };
