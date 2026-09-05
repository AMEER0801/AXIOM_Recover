"use strict";
/* ══════════════════════════════════════════════════════════════
   LOAD-ENV — zero-dependency .env loader
   ──────────────────────────────────────────────────────────────
   Node does not read .env files on its own — nothing in this
   project ever did, despite server/.env.example implying it would.
   Filling in server/.env silently did nothing: every process.env
   read fell through to its hardcoded default (PORT 3000, Razorpay
   "no-keys", Groq "off"), no matter what was typed into the file.

   This is a loader, not a dependency, on purpose: a demo machine
   should not need `npm install` to succeed for something this
   small, and a missing devDependency on stage is not a risk worth
   taking. require()'d first, synchronously, by every entry point
   below — by the time any of those files reads process.env.PORT
   or process.env.GROQ_API_KEY, this has already run.

   Behaviour, deliberately simple and safe:
     - reads server/.env relative to THIS file, not the caller's
       cwd, so it works whether you're in server/ or the repo root
     - does nothing (no throw, no warning) if .env is absent —
       a real deployment (Render, for example) sets real
       environment variables directly and has no .env file at all
     - does NOT override a variable already set in the real
       environment — `$env:PORT="9000"; npm run console` in
       PowerShell still wins over whatever server/.env says,
       matching how every real dotenv-style loader behaves
     - skips blank lines and lines starting with #
     - strips a single layer of surrounding "..." or '...' quotes,
       nothing fancier — this project's own .env.example never
       needs more than that
     - LAST DUPLICATE WINS WITHIN THE FILE ITSELF. .env.example
       ships GROQ_API_KEY= blank near its Razorpay block; a person
       filling in keys often adds a second GROQ_API_KEY=gsk_...
       line further down rather than editing the first one. If an
       earlier blank line in the same file "claimed" the key first,
       every later real value in that same file would be silently
       discarded — found by testing exactly this scenario, not by
       inspection. The "don't override" rule below is scoped to
       values ALREADY in the real process environment before this
       file ran (a real `$env:PORT=...` in PowerShell, or a host's
       real environment variable) — never to earlier lines of this
       same .env file.
   ══════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, ".env");

function loadEnv() {
  let raw;
  try {
    raw = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    return; // no .env — fine, rely on real environment variables
  }

  // Preexisting real environment variables (set before this process
  // started) always win — that check happens once, up front, against
  // a snapshot. It must NOT be re-checked per line against
  // process.env, or the first blank/placeholder occurrence of a key
  // inside THIS SAME FILE would "claim" it via the exact same check
  // and silently block every real value later in the same file.
  const preexisting = new Set(Object.keys(process.env));
  const fromFile = {}; // last occurrence in the file wins

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    fromFile[key] = value; // later line for the same key overwrites earlier
  }

  for (const [key, value] of Object.entries(fromFile)) {
    if (!preexisting.has(key)) {
      process.env[key] = value;
    }
  }
}

loadEnv();
