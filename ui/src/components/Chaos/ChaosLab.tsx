import { useState } from 'react';
import type { ChaosConcurrencyResult, BankFlapResult, NrvResult, Intervention } from '@/types/domain';
import { runChaosConcurrency, runBankFlap, runNrvSim } from '@/services/api';
import { rupees } from '@/services/format';
import './chaos.css';

/**
 * The Chaos Lab.
 *
 * The one screen built to answer the questions a payments judge asks
 * out loud: "what happens when ten webhooks land in the same
 * millisecond?", "what does your system do when HDFC's UPI switch is
 * down?", "would you recover a ₹150 payment at the cost of the
 * customer?". Every button here attacks the REAL server-side
 * safeguards — the same lib/ code the live ingestion path runs — and
 * shows the verdicts, not claims about them.
 *
 * There is deliberately no fixture fallback with invented results:
 * offline, each panel says the backend is not running.
 */

const DEMO_CHANNELS: Intervention[] = [
  'PAYMENT_LINK_WHATSAPP', 'PAYMENT_LINK_SMS', 'DUNNING_EMAIL', 'VOICE_NUDGE_REGIONAL', 'RETRY_CHARGE',
];

/* ──────────────────────────────────────────────────────────────── */
/* Demo 1 — the webhook flood                                       */
/* ──────────────────────────────────────────────────────────────── */

function ConcurrencyDemo() {
  const [workers, setWorkers] = useState(20);
  const [result, setResult] = useState<ChaosConcurrencyResult | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const fire = async () => {
    setBusy(true);
    const env = await runChaosConcurrency({ workers });
    setResult(env.data);
    setLive(env.source === 'live');
    setBusy(false);
  };

  const rejected = result?.summary.rejected_in_flight ?? 0;
  const replayed = result?.summary.replayed_from_cache ?? 0;

  return (
    <div className="ax-chaos__demo sheet">
      <header className="ax-chaos__head">
        <div>
          <h3>The webhook flood</h3>
          <p>
            An upstream gateway retries by design, and during a timeout flap its retries can arrive
            concurrently — twenty deliveries of the same payment inside the same millisecond. Without
            an in-flight lock, twenty workers each decide a recovery and each fire it: the double
            charge. Fire the storm against the real <code>lib/idempotency.js</code> the ingestion
            server runs.
          </p>
        </div>
        <div className="ax-chaos__fire">
          <label>
            concurrent deliveries
            <span className="ax-sim__value figure">{workers}</span>
            <input type="range" min={2} max={50} value={workers}
              onChange={(e) => setWorkers(Number(e.target.value))} />
          </label>
          <button className="ax-chaos__button" onClick={fire} disabled={busy}>
            {busy ? 'flooding…' : `Inject ${workers} concurrent webhooks`}
          </button>
        </div>
      </header>

      {result && (
        <>
          <div className={`ax-chaos__verdict ${result.summary.invariant_holds ? 'is-holds' : 'is-breaks'}`}>
            <span className="ax-chaos__verdict-title figure">
              {result.summary.invariant_holds
                ? `1 executed · ${rejected} rejected (409) · ${replayed} replayed from cache`
                : 'INVARIANT FAILED — see the note below'}
            </span>
            <p>
              {result.summary.invariant_holds
                ? `Zero double-charge invariant held under ${result.workers}-way concurrency, in ${result.elapsed_ms}ms. Exactly one worker acquired the lock and recorded a decision in the scenario audit chain; the other ${rejected} were refused before they could reach the append. A late duplicate delivery was answered from the result cache with the ORIGINAL outcome — not re-executed.`
                : result.summary.invariant}
            </p>
          </div>

          <div className="ax-chaos__proof">
            <span className="eyebrow">Audit proof</span>
            <div className="ax-chaos__proof-grid figure">
              <div><span className="ax-num">{result.audit_proof.decision_entries}</span><span>decision entries</span></div>
              <div><span className="ax-num">{result.audit_proof.entries}</span><span>chain entries</span></div>
              <div><span className={result.audit_proof.chain_valid ? 'ax-num is-ok' : 'ax-num is-bad'}>
                {result.audit_proof.chain_valid ? 'intact' : 'broken'}
              </span><span>chain verification</span></div>
              <div className="ax-chaos__proof-note">{result.audit_proof.note}</div>
            </div>
          </div>

          <details className="ax-chaos__log">
            <summary>Per-worker log — all {result.results.length} deliveries</summary>
            <ol className="ax-chaos__workers">
              {result.results.map((r) => (
                <li key={r.worker} className={`ax-chaos__worker is-${r.status.toLowerCase()}`}>
                  <span className="figure ax-chaos__w-id">{String(r.worker).padStart(2, '0')}</span>
                  <span className="ax-chaos__w-status">{r.status}</span>
                  <span className="figure ax-chaos__w-http">HTTP {r.http}</span>
                  <span className="ax-chaos__w-detail">{r.detail ?? (r.executed ? 'acquired the lock — the ONE decision' : '')}</span>
                </li>
              ))}
            </ol>
          </details>

          {live === false && (
            <p className="ax-chaos__offline">The backend on :3000 was not reachable — this panel refuses to invent flood results.</p>
          )}
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/* Demo 2 — the bank flap                                           */
/* ──────────────────────────────────────────────────────────────── */

function BankFlapDemo() {
  const [route, setRoute] = useState('HDFC');
  const [failures, setFailures] = useState(4);
  const [result, setResult] = useState<BankFlapResult | null>(null);
  const [busy, setBusy] = useState(false);

  const fire = async () => {
    setBusy(true);
    const env = await runBankFlap({ route, failures });
    setResult(env.data);
    setBusy(false);
  };

  return (
    <div className="ax-chaos__demo sheet">
      <header className="ax-chaos__head">
        <div>
          <h3>The bank flap</h3>
          <p>
            When an issuing switch (or NPCI itself) degrades, every retry against that route adds a
            penalty fee and a success-rate mark — while the route is down for everyone and the
            retries cannot succeed. Route-shaped failures feed a rolling-window circuit breaker
            (<code>lib/circuitBreaker.js</code>); four inside the window trips it OPEN and retries
            are suppressed for a cooldown, with an alternate rail offered instead.
          </p>
        </div>
        <div className="ax-chaos__fire">
          <label>
            route
            <select value={route} onChange={(e) => setRoute(e.target.value)}>
              {['HDFC', 'ICICI', 'SBI', 'AXIS', 'UPI', 'NETBANKING'].map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
          <label>
            failures in window
            <span className="ax-sim__value figure">{failures}</span>
            <input type="range" min={1} max={10} value={failures}
              onChange={(e) => setFailures(Number(e.target.value))} />
          </label>
          <button className="ax-chaos__button" onClick={fire} disabled={busy}>
            {busy ? 'injecting…' : `Simulate ${failures} × ${route} 504 flap`}
          </button>
        </div>
      </header>

      {result && result.injected > 0 && (
        <>
          <div className={`ax-chaos__verdict ${result.final.circuit === 'OPEN' ? 'is-breaks' : 'is-holds'}`}>
            <span className="ax-chaos__verdict-title figure">
              {result.route} · circuit {result.final.circuit} · retries {result.final.allowed ? 'allowed' : 'SUPPRESSED'}
            </span>
            <p>{result.final.reason}</p>
          </div>

          <div className="ax-chaos__timeline">
            <span className="eyebrow">Failure timeline</span>
            <ol className="ax-chaos__steps">
              {result.timeline.map((t) => (
                <li key={t.step} className={`ax-chaos__step is-${t.circuit.toLowerCase()}`}>
                  <span className="figure ax-chaos__step-n">{t.step}</span>
                  <span className="figure ax-chaos__step-event">{t.event}</span>
                  <span className="ax-chip ax-chaos__step-circuit">{t.circuit}</span>
                  <span className="ax-chaos__step-note">{t.note}</span>
                </li>
              ))}
            </ol>
          </div>

          {result.reroute && (
            <div className="ax-chaos__reroute">
              <span className="eyebrow">Reroute advisory — what the live path does with an OPEN route</span>
              <p className="ax-chaos__reroute-main">
                <code className="figure">{result.reroute.original_action}</code> on {result.reroute.suppressed_on} is off the table for{' '}
                {result.reroute.cooldown_minutes} minutes. Offer{' '}
                <code className="figure">{result.reroute.recommended_instead}</code> instead — {result.reroute.why}
              </p>
              <p className="figure ax-chaos__reroute-cost">
                penalty fees avoided this window: {rupees(result.reroute.penalty_fees_avoided_paise)}
              </p>
            </div>
          )}

          <p className="ax-chaos__shared">
            {result.shared_state.note} A tripped route is visible on <code>/health</code> and in the
            Live AI tab — the lab and the live path share one breaker, not two truths.
          </p>
        </>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/* Demo 3 — the NRV calculator                                      */
/* ──────────────────────────────────────────────────────────────── */

function NrvDemo() {
  const [amount, setAmount] = useState(15000);          /* paise */
  const [p, setP] = useState(0.15);
  const [action, setAction] = useState<Intervention>('PAYMENT_LINK_WHATSAPP');
  const [fatigue, setFatigue] = useState(0.75);
  const [ltv, setLtv] = useState(300000);               /* paise */
  const [result, setResult] = useState<NrvResult | null>(null);
  const [busy, setBusy] = useState(false);

  const fire = async () => {
    setBusy(true);
    const env = await runNrvSim({ amount_paise: amount, p_success: p, action, customer_ltv_paise: ltv, fatigue });
    setResult(env.data);
    setBusy(false);
  };

  const v = result?.verdict;

  return (
    <div className="ax-chaos__demo sheet">
      <header className="ax-chaos__head">
        <div>
          <h3>Net Recovery Value — the margin gate</h3>
          <p>
            Recovery-rate is not profit. A ₹150 drop recovered by a ₹0.90 WhatsApp while carrying a
            ₹90 churn penalty is a loss with a success metric attached. The NRV gate
            (<code>lib/nrv.js</code>) prices every candidate action before it runs — channel sticker
            cost, fatigue-driven churn risk against the customer's LTV — and vetoes anything
            margin-negative. The frozen engine runs the same ranking in paise as its expected-value
            rule, so the Evidence tab and this gate are one discipline, not two.
          </p>
        </div>
      </header>

      <div className="ax-chaos__nrv-grid">
        <form className="ax-chaos__nrv-controls" onSubmit={(e) => e.preventDefault()}>
          <label>
            gross amount
            <span className="ax-sim__value figure">{rupees(amount)}</span>
            <input type="range" min={5000} max={500000} step={5000} value={amount}
              onChange={(e) => setAmount(Number(e.target.value))} />
          </label>
          <label>
            channel
            <select value={action} onChange={(e) => setAction(e.target.value as Intervention)}>
              {DEMO_CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label>
            P(success)
            <span className="ax-sim__value figure">{p.toFixed(2)}</span>
            <input type="range" min={0.02} max={0.9} step={0.01} value={p}
              onChange={(e) => setP(Number(e.target.value))} />
          </label>
          <label>
            fatigue
            <span className="ax-sim__value figure">{fatigue.toFixed(2)}</span>
            <input type="range" min={0} max={1} step={0.05} value={fatigue}
              onChange={(e) => setFatigue(Number(e.target.value))} />
          </label>
          <label>
            customer LTV
            <span className="ax-sim__value figure">{rupees(ltv, { compact: true })}</span>
            <input type="range" min={50000} max={1000000} step={50000} value={ltv}
              onChange={(e) => setLtv(Number(e.target.value))} />
          </label>
          <button className="ax-chaos__button" onClick={fire} disabled={busy}>
            {busy ? 'computing…' : 'Price this recovery'}
          </button>
        </form>

        {v && result && (
          <div className={`ax-chaos__verdict ax-chaos__nrv-verdict ${v.margin_positive ? 'is-holds' : 'is-breaks'}`}>
            <span className="ax-chaos__verdict-title figure">
              {v.verdict === 'EXECUTE_RECOVERY' ? 'EXECUTE_RECOVERY' : v.verdict === 'VETO_SMALL_TICKET' ? 'VETO — small-ticket invariant' : 'VETO — negative margin'}
            </span>
            <dl className="ax-chaos__nrv-math figure">
              <div><dt>expected yield</dt><dd>{rupees(v.breakdown.expected_yield_paise)}</dd></div>
              <div><dt>− channel cost</dt><dd>{rupees(v.breakdown.channel_cost_paise)}</dd></div>
              <div><dt>− churn risk</dt><dd>{rupees(v.breakdown.churn_penalty_paise)}</dd></div>
              <div className="ax-chaos__nrv-total"><dt>= NRV</dt><dd>{rupees(v.nrv_paise, { sign: true })}</dd></div>
            </dl>
            <p>{v.reason}</p>
            <p className="ax-chaos__nrv-formula figure">{result.formula}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── */

export function ChaosLab() {
  return (
    <div className="ax-chaos">
      <ConcurrencyDemo />
      <BankFlapDemo />
      <NrvDemo />
    </div>
  );
}
