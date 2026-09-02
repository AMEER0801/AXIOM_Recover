import { useMemo, useState } from 'react';
import { runDiagnosis, createTestLink, pingRazorpay, type DiagnoseVerdict, type LinkResult, type ProvidersPayload } from '@/services/api';
import { rupees, titleCase } from '@/services/format';
import type { RecoveryRun } from '@/types/domain';
import './live.css';

/**
 * LivePanel — the interactive surface for the two real providers.
 *
 * Left: one at-risk record goes to three judges in order. The
 * deterministic policy proposes; the eleven gates decide what may
 * actually run; Groq — on the operator's own key — gives an advisory
 * second opinion constrained to the same closed vocabulary. The
 * disagreement badge is the point: bounded autonomy, visible AI
 * judgment.
 *
 * Right: a REAL Razorpay Test Mode payment link, created through the
 * same lib/rzp.js choke point the engine uses, with the persisted
 * idempotency store replayable on screen.
 *
 * Both halves fail closed and say why when keys are absent.
 */

const FAILURE_REASONS = [
  'insufficient_funds',
  'soft_decline',
  'card_expired',
  'mandate_revoked',
  'mandate_paused_by_customer',
  'mandate_paused_by_business',
  'network_timeout',
  'checkout_abandoned',
  'invoice_overdue',
] as const;

const LOCALES = ['en', 'ta', 'hi', 'kn', 'ml', 'te'] as const;

export function LivePanel({ run, providers }: { run: RecoveryRun; providers: ProvidersPayload | null }) {
  const [recordIdx, setRecordIdx] = useState(0);
  const records = useMemo(
    () => run.records.slice(0, 40),
    [run.records],
  );
  const record = records[Math.min(recordIdx, records.length - 1)] ?? run.records[0];

  const [failureReason, setFailureReason] = useState<string>(record?.failure_reason ?? 'insufficient_funds');
  const [amountRupees, setAmountRupees] = useState(record ? Math.round(record.amount / 100) : 2500);
  const [attempts, setAttempts] = useState(1);
  const [locale, setLocale] = useState<string>(record?.locale ?? 'en');
  const [dnc, setDnc] = useState(false);
  const [hourIst, setHourIst] = useState(11);

  const [verdict, setVerdict] = useState<DiagnoseVerdict | null>(null);
  const [busy, setBusy] = useState(false);

  const [linkAmount, setLinkAmount] = useState(2500);
  const [linkResult, setLinkResult] = useState<LinkResult | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkAttempt, setLinkAttempt] = useState(1);

  const rzp = providers?.providers.razorpay;
  const groq = providers?.providers.groq;

  function pickRecord(i: number) {
    setRecordIdx(i);
    const r = records[i];
    if (r) {
      setFailureReason(r.failure_reason);
      setAmountRupees(Math.round(r.amount / 100));
      setLocale(r.locale);
    }
  }

  async function diagnose() {
    setBusy(true);
    try {
      const env = await runDiagnosis({
        entity_id: record?.id,
        failure_reason: failureReason,
        amount_paise: Math.round(amountRupees * 100),
        attempts,
        minutes_since_last_attempt: 720,
        locale,
        dnc,
        hour_ist: hourIst,
      });
      setVerdict(env.data);
    } finally {
      setBusy(false);
    }
  }

  async function makeLink() {
    setLinkBusy(true);
    try {
      const env = await createTestLink({
        amount_paise: Math.round(linkAmount * 100),
        entity_id: record?.id ?? 'live_demo_entity',
        attempt: linkAttempt,
      });
      setLinkResult(env.data);
    } finally {
      setLinkBusy(false);
    }
  }

  async function ping() {
    setLinkBusy(true);
    try {
      const env = await pingRazorpay();
      setLinkResult({
        ok: env.data.ok,
        simulated: env.data.simulated,
        replayed: false,
        mode: env.data.mode,
        link: null,
        error: env.data.error ?? null,
        idempotency: '',
        note: env.data.note,
      });
    } finally {
      setLinkBusy(false);
    }
  }

  return (
    <div className="live-grid">
      {/* ── The three judges ─────────────────────────────────────── */}

      <div className="live-col">
        <div className="live-setup sheet">
          <div className="live-setup__head">
            <span className="eyebrow">The case</span>
            <h3>One at-risk record, three judges</h3>
          </div>

          <label className="live-field">
            <span>Record from the live run</span>
            <select
              value={recordIdx}
              onChange={(e) => pickRecord(Number(e.target.value))}
            >
              {records.map((r, i) => (
                <option key={r.id} value={i}>
                  {shortHash(r.id)} · {titleCase(r.failure_reason)} · {rupees(r.amount)} · {r.locale}
                </option>
              ))}
            </select>
          </label>

          <div className="live-row">
            <label className="live-field">
              <span>Failure reason</span>
              <select value={failureReason} onChange={(e) => setFailureReason(e.target.value)}>
                {FAILURE_REASONS.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
              </select>
            </label>

            <label className="live-field">
              <span>Amount (₹)</span>
              <input type="number" min={1} value={amountRupees}
                onChange={(e) => setAmountRupees(Number(e.target.value) || 0)} />
            </label>
          </div>

          <div className="live-row">
            <label className="live-field">
              <span>Attempts so far</span>
              <input type="number" min={0} max={20} value={attempts}
                onChange={(e) => setAttempts(Number(e.target.value) || 0)} />
            </label>

            <label className="live-field">
              <span>Customer locale</span>
              <select value={locale} onChange={(e) => setLocale(e.target.value)}>
                {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>

            <label className="live-field">
              <span>Hour (IST)</span>
              <input type="number" min={0} max={23} value={hourIst}
                onChange={(e) => setHourIst(Number(e.target.value) || 0)} />
            </label>

            <label className="live-check">
              <input type="checkbox" checked={dnc} onChange={(e) => setDnc(e.target.checked)} />
              <span>Do not contact</span>
            </label>
          </div>

          <button className="btn-primary live-run" onClick={diagnose} disabled={busy}>
            {busy ? 'Consulting the three judges…' : 'Run live diagnosis'}
          </button>

          {!groq?.configured && (
            <p className="live-hint">{groq?.detail ?? 'GROQ_API_KEY is not set — the diagnosis still runs policy + gates; the LLM judge stays off.'}</p>
          )}
        </div>

        {verdict && (
          <div className="live-verdicts">
            <JudgeCard
              no="1"
              name="Deterministic policy"
              role="authoritative"
              action={verdict.policy.proposed}
              tone="gate"
              lines={[
                'Pure, synchronous, reproducible. No network, no key, same answer every time.',
                'This is the decision the system would act on.',
              ]}
            />

            <JudgeCard
              no="2"
              name="The eleven gates"
              role={verdict.gates.allowed ? 'allowed to run' : 'blocked'}
              action={verdict.gates.finalAction}
              tone={verdict.gates.allowed ? 'tie' : 'break'}
              lines={[
                `Cost if it runs: ${rupees(verdict.gates.estimatedCostPaise)}.`,
                ...(verdict.gates.trace.filter((t) => t.blocked).map((t) => `${t.gate}: ${t.detail}`)),
                ...(verdict.gates.allowed ? ['Every gate passed — the proposal may execute.'] : []),
              ]}
            />

            {verdict.llm ? (
              <JudgeCard
                no="3"
                name={`Groq · ${verdict.llm.model}`}
                role={verdict.llm.agreesWithPolicy ? 'agrees with policy' : 'disagrees — human decides'}
                action={verdict.llm.action}
                tone={verdict.llm.agreesWithPolicy ? 'tie' : 'owed'}
                lines={[
                  `Live inference · ${verdict.llm.latencyMs}ms · ${verdict.llm.promptTokens}+${verdict.llm.completionTokens} tokens`,
                  verdict.llm.valid
                    ? 'A valid action from the closed vocabulary — advisory only.'
                    : `Response outside the vocabulary, coerced to NO_ACTION. Raw: ${verdict.llm.raw ?? '—'}`,
                  ...(verdict.llm.degraded ? [`Degraded: ${verdict.llm.degraded}`] : []),
                ]}
              />
            ) : (
              <div className="judge judge--off sheet">
                <div className="judge__head">
                  <span className="judge__no">3</span>
                  <div>
                    <div className="judge__name">Groq · second opinion</div>
                    <span className="ax-chip ax-chip--quiet">advisory · off</span>
                  </div>
                </div>
                <p className="judge__line">{verdict.llmError ?? 'GROQ_API_KEY is not configured. The policy and gates verdicts above are complete without it.'}</p>
              </div>
            )}

            <p className="live-note">{verdict.note}</p>
          </div>
        )}
      </div>

      {/* ── Razorpay Test Mode ───────────────────────────────────── */}

      <div className="live-col">
        <div className="live-setup sheet">
          <div className="live-setup__head">
            <span className="eyebrow">Razorpay · Test Mode</span>
            <h3>A real payment link, through the real choke point</h3>
          </div>

          <div className="live-mode-row">
            <span className={`ax-chip ${rzp?.mode === 'test-live' ? 'ax-chip--tie' : 'ax-chip--quiet'}`}>
              {rzp?.mode === 'test-live' ? 'LIVE · test keys' : (rzp?.mode ?? 'offline')}
            </span>
            {rzp?.mode === 'test-live' && <span className="ax-chip ax-chip--gate">api.razorpay.com</span>}
          </div>

          <label className="live-field">
            <span>Amount (₹)</span>
            <input type="number" min={1} value={linkAmount}
              onChange={(e) => setLinkAmount(Number(e.target.value) || 0)} />
          </label>

          <label className="live-field">
            <span>Attempt number (idempotency input)</span>
            <input type="number" min={1} value={linkAttempt}
              onChange={(e) => setLinkAttempt(Number(e.target.value) || 1)} />
          </label>

          <div className="live-actions">
            <button className="btn-primary" onClick={makeLink} disabled={linkBusy}>
              {linkBusy ? 'Creating…' : 'Create payment link'}
            </button>
            <button onClick={ping} disabled={linkBusy}>Ping API</button>
            <button onClick={makeLink} disabled={linkBusy} title="Same entity + same attempt = the idempotency store replays the original result.">
              Create again (replay)
            </button>
          </div>

          {linkResult && (
            <div className="live-link-result">
              <div className="live-link-row">
                <span className={`ax-chip ${linkResult.replayed ? 'ax-chip--gate' : linkResult.simulated ? 'ax-chip--quiet' : 'ax-chip--tie'}`}>
                  {linkResult.replayed ? 'REPLAYED · original result' : linkResult.simulated ? 'DRY-RUN' : 'LIVE · test mode'}
                </span>
                {linkResult.link && <span className="ax-chip ax-chip--quiet figure">{linkResult.link.id}</span>}
              </div>

              {linkResult.link && (
                <div className="live-link-detail">
                  {linkResult.link.short_url && (
                    <a href={linkResult.link.short_url} target="_blank" rel="noreferrer" className="live-link-url">
                      {linkResult.link.short_url}
                    </a>
                  )}
                  <div className="figure">status: {linkResult.link.status} · {rupees(linkResult.link.amount)}</div>
                </div>
              )}

              {linkResult.idempotency && (
                <div className="live-idem figure" title="sha256(entity | action | attempt) — deterministic across process restarts">
                  idem: {linkResult.idempotency}
                </div>
              )}

              <p className="live-note">{linkResult.note}</p>
              {linkResult.error ? <p className="live-error">{String((linkResult.error as { description?: string })?.description ?? JSON.stringify(linkResult.error)).slice(0, 200)}</p> : null}
            </div>
          )}

          {!rzp?.configured && (
            <p className="live-hint">
              {rzp?.detail ?? 'Provider status unavailable.'}
            </p>
          )}
        </div>

        <div className="live-discipline sheet">
          <span className="eyebrow">Why this panel exists</span>
          <p>
            Everything else in this console is simulation against the frozen response model, and it says so.
            This panel is the one place where the two real providers show up: the LLM that proposes, and the
            payment rails that would settle. A link created here is a real Test Mode object on your account —
            and the idempotency replay is the same protection the engine's dry-run executions rehearse.
          </p>
        </div>
      </div>
    </div>
  );
}

function shortHash(s: string) {
  return s.length > 10 ? `${s.slice(0, 10)}…` : s;
}

function JudgeCard({
  no, name, role, action, tone, lines,
}: {
  no: string; name: string; role: string; action: string; tone: 'tie' | 'break' | 'owed' | 'gate'; lines: string[];
}) {
  return (
    <div className={`judge judge--${tone} sheet`}>
      <div className="judge__head">
        <span className="judge__no">{no}</span>
        <div className="judge__title">
          <div className="judge__name">{name}</div>
          <span className={`ax-chip ax-chip--${tone}`}>{role}</span>
        </div>
        <span className="judge__action figure">{action}</span>
      </div>
      {lines.map((l, i) => <p key={i} className="judge__line">{l}</p>)}
    </div>
  );
}
