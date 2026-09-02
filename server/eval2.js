"use strict";
/* Multi-seed evaluation for the corrected engine. A single-seed
   result is an anecdote; this reports the spread. Also sweeps the
   churn valuation, because the EV policy's appetite for voice is
   entirely a function of how expensive an opt-out is assumed to be. */
const fs = require("fs"), path = require("path");
const { generate } = require("./seed");
const { createBandit } = require("./bandit");
const { compareAll, runBatch2 } = require("./recover2");
const { createEvPolicy } = require("./policy-ev");
const { DEFAULT_POLICY } = require("./gates");
const { __v: v } = require("./model/response-model.frozen");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const nSeeds = Number(arg("seeds", 20)), records = Number(arg("records", 200)), rounds = Number(arg("rounds", 8));
const warmup = Number(arg("warmup", 12));

const rates = JSON.parse(fs.readFileSync(path.join(__dirname,"model","base-rates.json"),"utf8"));
const priors = JSON.parse(fs.readFileSync(path.join(__dirname,"model","agent-priors.json"),"utf8"));

const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); };
const R = p => "\u20B9" + (p/100).toLocaleString("en-IN",{maximumFractionDigits:0});

(async () => {
  const warmupSeeds = Array.from({length:warmup},(_,i)=>90001+i);
  const evalSeeds = Array.from({length:nSeeds},(_,i)=>42+i*7);   // 42,49,56,... none collide with 1001+
  const { warmBandit } = require("./recover2");
  /* Fail loudly. An earlier version guarded this with `&& warmBandit`
     and, when the export was missing, silently ran every seed cold
     while the header still printed "warm-up 8". A harness that
     mislabels its own conditions is worse than one that crashes. */
  if (warmup > 0 && typeof warmBandit !== "function") {
    throw new Error("warmBandit not exported from recover2.js — refusing to report a run labelled as warmed");
  }

  const acc = { baseline:{c:[],val:[],net:[],oo:[]}, smart:{c:[],val:[],net:[],oo:[]}, ev:{c:[],val:[],net:[],oo:[]} };

  for (const seed of evalSeeds) {
    const { ledger } = generate({ seed, records });
    let b = createBandit({ priors, seed });
    if (warmup > 0) b = await warmBandit({ bandit:b, rates, priors, records, rounds, evalSeed:seed, warmupSeeds });
    const r = await compareAll({ ledger, rates, priors, seed, rounds, bandit:b });
    for (const k of ["baseline","smart","ev"]) {
      acc[k].c.push(100*r[k].paidCount/r[k].atRiskCount);
      acc[k].val.push(100*r[k].grossPaise/r[k].atRiskValuePaise);
      acc[k].net.push(r[k].netPaise);
      acc[k].oo.push(r[k].optOuts);
    }
  }

  console.log(`\n── MULTI-SEED EVAL · ${nSeeds} seeds · ${records} records · ${rounds} rounds · warm-up ${warmup} held-out populations ──\n`);
  console.log("  arm".padEnd(14), "count %".padStart(16), "VALUE %".padStart(16), "net (mean)".padStart(16), "opt-outs".padStart(12));
  for (const k of ["baseline","smart","ev"]) {
    const a = acc[k];
    console.log("  " + k.padEnd(12),
      `${mean(a.c).toFixed(1)} ±${sd(a.c).toFixed(1)}`.padStart(16),
      `${mean(a.val).toFixed(1)} ±${sd(a.val).toFixed(1)}`.padStart(16),
      R(mean(a.net)).padStart(16),
      `${mean(a.oo).toFixed(1)} ±${sd(a.oo).toFixed(1)}`.padStart(12));
  }
  /* ── Paired bootstrap ──────────────────────────────────────
     All three arms face the identical population on each seed, so
     the per-seed difference is a paired observation and the paired
     spread is the right thing to quote. It matters here: the
     portfolio is dominated by a handful of very large records, so
     whether two or three of them happen to land moves the net by
     more than the entire policy effect. An unpaired mean would hide
     that; a bootstrap CI on the paired differences does not. */
  function bootCI(diffs, iters = 4000) {
    /* Deterministic bootstrap — Math.random() is banned project-wide,
       and a CI that moves between runs is not a CI. */
    const { rngFor } = require("./lib/rng");
    const rand = rngFor("bootstrap", diffs.length, iters);
    const means = [];
    for (let b = 0; b < iters; b++) {
      let s = 0;
      for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rand() * diffs.length)];
      means.push(s / diffs.length);
    }
    means.sort((a, b) => a - b);
    return { lo: means[Math.floor(0.025 * iters)], hi: means[Math.floor(0.975 * iters)] };
  }
  const med = a => { const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };

  const dEv = acc.ev.net.map((x,i)=>x-acc.baseline.net[i]);
  const dSm = acc.smart.net.map((x,i)=>x-acc.baseline.net[i]);
  console.log(`\n  delta vs baseline (net, mean ± sd):`);
  console.log(`    smart      ${R(mean(dSm))}  ± ${R(sd(dSm))}   ${mean(dSm)>0?"":"\u2190 NEGATIVE"}`);
  console.log(`    ev+bandit  ${R(mean(dEv))}  ± ${R(sd(dEv))}`);
  console.log(`    ev beats baseline on ${dEv.filter(x=>x>0).length}/${nSeeds} seeds; smart on ${dSm.filter(x=>x>0).length}/${nSeeds}`);

  const ciE = bootCI(dEv), ciS = bootCI(dSm);
  console.log(`\n  paired 95% bootstrap CI on the NET delta:`);
  console.log(`    smart      [${R(ciS.lo)}, ${R(ciS.hi)}]   median ${R(med(dSm))}`);
  console.log(`    ev+bandit  [${R(ciE.lo)}, ${R(ciE.hi)}]   median ${R(med(dEv))}`);

  const dValE = acc.ev.val.map((x,i)=>x-acc.baseline.val[i]);
  const dValS = acc.smart.val.map((x,i)=>x-acc.baseline.val[i]);
  const cvE = bootCI(dValE), cvS = bootCI(dValS);
  console.log(`\n  paired 95% CI on VALUE-recovery delta (percentage points):`);
  console.log(`    smart      [${cvS.lo.toFixed(1)}, ${cvS.hi.toFixed(1)}] pp`);
  console.log(`    ev+bandit  [${cvE.lo.toFixed(1)}, ${cvE.hi.toFixed(1)}] pp`);

  const straddles = c => c.lo < 0 && c.hi > 0;
  console.log(`\n  READ THIS BEFORE QUOTING A RUPEE FIGURE:`);
  if (straddles(ciE)) {
    console.log(`    The NET-rupee CI straddles zero. On this population the net delta is NOT`);
    console.log(`    statistically distinguishable at ${nSeeds} seeds: ~93% of the money sits in ~20% of`);
    console.log(`    the records, so the total swings on whether two or three large invoices`);
    console.log(`    happen to land. Quote the count-% and VALUE-% columns, which are stable,`);
    console.log(`    and quote the net only with this interval attached. A single-seed rupee`);
    console.log(`    figure from this batch is noise wearing a decimal point.`);
  } else {
    console.log(`    NET delta CI excludes zero — the rupee figure is reportable as stated.`);
  }
  console.log("");
})();
