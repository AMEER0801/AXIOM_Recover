"use strict";
/* ══════════════════════════════════════════════════════════════
   MERKLE — the root over the audit chain, for external proof
   ──────────────────────────────────────────────────────────────
   audit.js gives tamper-EVIDENCE: edit one entry, the chain breaks
   at that sequence. The merkle root adds a second, complementary
   property: ONE hash that commits to the ENTIRE run. Publish that
   root anywhere append-only (an email to the merchant's finance
   team, a commit in their repo, a notarised PDF) and afterwards
   nobody — including the operator of this system — can produce a
   different chain and claim it is the original, because a
   different chain computes a different root.

   Construction, deliberately boring:

     leaf_i   = sha256( "axiom-leaf:" + entry_i.hash )
     node     = sha256( "axiom-node:" + left + right )
     odd level → last node is duplicated (standard Bitcoin-style
     duplication, so the root is well-defined for any count)

   The domain-separation prefixes stop a leaf value from being
   reinterpreted as an internal node — cheap, and it closes a whole
   family of merkle malleability games.

   verify-proof.js (standalone, zero-dependency) recomputes both
   the per-entry chain AND this root from an exported bundle, so a
   third party needs nothing from this repo except the script and
   the bundle.
   ══════════════════════════════════════════════════════════════ */

const crypto = require("crypto");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Merkle root over the chain's entry hashes. Empty → genesis-style zero hash. */
function merkleRoot(entryHashes) {
  if (!Array.isArray(entryHashes) || entryHashes.length === 0) return "0".repeat(64);
  let level = entryHashes.map((h) => sha256(`axiom-leaf:${h}`));
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);   /* duplicate last */
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(`axiom-node:${level[i]}${level[i + 1]}`));
    level = next;
  }
  return level[0];
}

module.exports = { merkleRoot };
