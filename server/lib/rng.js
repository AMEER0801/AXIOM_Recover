"use strict";
/* ══════════════════════════════════════════════════════════════
   DETERMINISTIC RNG
   ──────────────────────────────────────────────────────────────
   Math.random() is banned everywhere in this project. Two reasons,
   and only the second one is obvious:

   1. A run must be reproducible. A reviewer who clones the repo
      and runs `npm run eval -- --seed 42` has to get the numbers
      in the README, digit for digit, or the numbers are a claim
      rather than a result.

   2. The baseline arm and the agent arm must face the SAME world.
      With a global generator, the two arms consume draws in a
      different order and diverge — so a chunk of the measured
      "improvement" is just two different rolls of the dice. Keying
      the stream on (seed, record, attempt, intervention) means a
      given record's luck is a property of the record, not of when
      it happened to be processed.

   splitmix64-derived, folded to 32 bits. Not cryptographic. It
   does not need to be: nothing here protects a secret, it only
   has to be uniform, fast and reproducible across machines.
   ══════════════════════════════════════════════════════════════ */

/* FNV-1a over a string — a stable way to fold arbitrary key parts
   into the seed without pulling in a hash dependency. Stable across
   Node versions and platforms, which `String.hashCode`-style ad hoc
   loops often are not once non-ASCII shows up. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* mulberry32 — small, well-distributed, and passes the smoke tests
   that matter at this scale (mean ~0.5, no visible period inside a
   few million draws). */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A generator whose stream is fully determined by its key parts.
 * @param  {...(string|number)} parts
 * @returns {() => number} uniform in [0,1)
 */
function rngFor(...parts) {
  return mulberry32(fnv1a(parts.map(String).join("\u0000")));
}

/** Integer in [lo, hi] inclusive. */
function randInt(rand, lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** Uniform pick from an array. */
function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

/**
 * Weighted pick. `weights` is an object of key -> relative weight.
 * Throws on an empty or all-zero table rather than returning
 * undefined, because a silent undefined here surfaces three layers
 * later as a confusing schema error.
 */
function weighted(rand, weights) {
  const keys = Object.keys(weights);
  const total = keys.reduce((a, k) => a + weights[k], 0);
  if (!keys.length || total <= 0) throw new Error("weighted: empty or zero-weight table");
  let r = rand() * total;
  for (const k of keys) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

module.exports = { rngFor, randInt, pick, weighted, fnv1a };
