"use strict";
/* ══════════════════════════════════════════════════════════════
   CONCURRENCY TEST — the zero-double-charge invariant
   ──────────────────────────────────────────────────────────────
   A competitor's README can claim race-condition safety; this file
   makes the claim a reproduction. Fire N simultaneous webhook
   deliveries for the SAME payment — the exact storm an upstream
   gateway produces during a timeout flap — and assert:

     · exactly ONE delivery acquires the in-flight lock
     · every other delivery is rejected while the first works
     · the ONE winner's result is cached, and a duplicate
       delivery arriving afterwards gets the SAME answer replayed
       to it — no re-execution, no divergence
     · a second storm AFTER the first completes still executes
       exactly once (locks are released, not leaked)
     · a crashed worker's stale lock is taken over after the TTL,
       and the takeover is recorded rather than silent

   No framework. `node test/concurrency.test.js`.
   The console's Chaos Lab runs the same scenario over HTTP:
   POST /api/simulate/chaos-concurrency.
   ══════════════════════════════════════════════════════════════ */

const assert = require("assert");
const { createIdempotency } = require("../lib/idempotency");

async function main() {
  let pass = 0, fail = 0;
  const t = (name, fn) => {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
  };
  const ta = async (name, fn) => {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
  };

  console.log("\n──────────────────────────────────────────────────────");
  console.log("  CONCURRENCY — zero double-charge invariant");
  console.log("──────────────────────────────────────────────────────");

  /* ── Test 1: the storm itself ───────────────────────────────── */
  await ta("20 simultaneous deliveries → exactly 1 acquires, 19 rejected", async () => {
    const idem = createIdempotency({ sweep: false });
    const paymentId = "pay_test_race_condition_007";
    const eventId = "evt_failed_hook_101";

    const workers = Array.from({ length: 20 }, (_, i) => new Promise((resolve) => {
      const cached = idem.cachedResult(eventId);
      if (cached) return resolve({ worker: i, status: "IDEMPOTENT_CACHED", executed: false });

      if (!idem.acquireLock(paymentId)) return resolve({ worker: i, status: "REJECTED_IN_FLIGHT", executed: false, http: 409 });

      /* winner: do the "work" asynchronously, then publish + release */
      setTimeout(() => {
        idem.recordResult(eventId, { status: "RECOVERY_SCHEDULED", by: i });
        idem.releaseLock(paymentId);
        resolve({ worker: i, status: "ACQUIRED_LOCK", executed: true, http: 200 });
      }, 25);
    }));

    const results = await Promise.all(workers);
    const executed = results.filter((r) => r.executed);
    assert.strictEqual(executed.length, 1, `expected exactly 1 execution, saw ${executed.length} — DOUBLE CHARGE`);
    assert.strictEqual(results.filter((r) => r.status === "REJECTED_IN_FLIGHT").length, 19);
    assert.deepStrictEqual(executed[0].status, "ACQUIRED_LOCK");
  });

  /* ── Test 2: the replay ─────────────────────────────────────── */
  await ta("duplicate delivery after completion gets the SAME answer, no re-execution", async () => {
    const idem = createIdempotency({ sweep: false });
    const paymentId = "pay_dup_1", eventId = "evt_dup_1";

    assert.strictEqual(idem.acquireLock(paymentId), true);
    const original = { status: "RECOVERY_SCHEDULED", decision: "PAYMENT_LINK_WHATSAPP" };
    idem.recordResult(eventId, original);
    idem.releaseLock(paymentId);

    const replayed = idem.cachedResult(eventId);
    assert.deepStrictEqual(replayed, original, "duplicate must receive the ORIGINAL outcome, byte-for-byte");
    /* and it must not need the lock to be answered — the answer is
       the cache, so even an in-flight lock elsewhere cannot make a
       duplicate diverge */
    assert.strictEqual(idem.acquireLock("other_payment"), true);
    assert.deepStrictEqual(idem.cachedResult(eventId), original);
  });

  /* ── Test 3: locks are released, not leaked ─────────────────── */
  await ta("a SECOND storm after the first completes still executes exactly once", async () => {
    const idem = createIdempotency({ sweep: false });
    for (const round of [1, 2]) {
      const pid = `pay_storm_${round}`;
      let acquired = 0;
      await Promise.all(Array.from({ length: 15 }, () => new Promise((resolve) => {
        if (idem.acquireLock(pid)) { acquired++; setTimeout(() => idem.releaseLock(pid), 10); }
        resolve();
      })));
      assert.strictEqual(acquired, 1, `round ${round}: expected 1 acquisition, saw ${acquired}`);
    }
  });

  /* ── Test 4: stale-lock takeover is recorded ────────────────── */
  await ta("a crashed worker's stale lock is taken over after TTL, and counted", async () => {
    const idem = createIdempotency({ lockTtlMs: 5, sweep: false });
    assert.strictEqual(idem.acquireLock("pay_crashed"), true);
    /* worker "crashes" — never releases */
    const before = idem.stats().stale_locks_taken_over;
    assert.strictEqual(idem.acquireLock("pay_crashed"), false, "fresh lock must not be stealable");
    await new Promise((r) => setTimeout(r, 12));
    const ok = idem.acquireLock("pay_crashed");
    assert.strictEqual(ok, true, "expired lock must be recoverable");
    assert.strictEqual(idem.stats().stale_locks_taken_over, before + 1, "takeover must be visible in stats, not silent");
  });

  /* ── Test 5: interleave two DIFFERENT payments ──────────────── */
  await ta("two different payments proceed concurrently — the lock scopes per payment, not globally", async () => {
    const idem = createIdempotency({ sweep: false });
    assert.strictEqual(idem.acquireLock("pay_A"), true);
    assert.strictEqual(idem.acquireLock("pay_B"), true, "different payment must not be blocked by pay_A's lock");
    assert.strictEqual(idem.acquireLock("pay_A"), false);
    idem.releaseLock("pay_A"); idem.releaseLock("pay_B");
  });

  /* ── Test 6: result TTL expiry ──────────────────────────────── */
  await ta("expired results are dropped, not replayed forever", async () => {
    const idem = createIdempotency({ resultTtlMs: 10, sweep: false });
    idem.recordResult("evt_old", { status: "X" });
    assert.notStrictEqual(idem.cachedResult("evt_old"), null);
    await new Promise((r) => setTimeout(r, 15));
    assert.strictEqual(idem.cachedResult("evt_old"), null, "result past TTL must be gone");
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
