import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import type { EvalSummary, PolicyResult, RecoveryRun } from '@/types/domain';
import { rupees } from '@/services/format';
import { useCountUp } from '@/hooks/useCountUp';
import './evidence.css';

/**
 * The evidence screen.
 *
 * A single "the agent recovered ₹X" figure is unfalsifiable — there is
 * nothing to compare it against. Every claim on this screen is a DELTA
 * against a baseline that ran on the identical seeded population through
 * the identical gates, reported net of what it cost to produce, with a
 * paired confidence interval and a mathematical ceiling to anchor it.
 *
 * The metric the Track 3 bar is measured on is VALUE — money recovered
 * over money at risk — not record count. Count is reported too, because
 * the gap between the two is exactly how the approval-ceiling bug stayed
 * invisible for so long.
 */

const ARM_LABEL: Record<string, { name: string; note: string }> = {
  baseline: { name: 'Baseline', note: 'Blind retry. What a merchant gets with zero intelligence.' },
  smart:    { name: 'Smart',    note: 'The original rule ladder, corrected accounting.' },
  ev:       { name: 'EV + bandit', note: 'Expected-value policy, online-learned channel rates, FINAL config: 6 attempts, ₹50k dual control, 4-contact cap.' },
  dp:       { name: 'DP (PSRL)', note: 'Posterior-sampling lookahead — a research arm, close to EV.' },
  llm:      { name: 'LLM',      note: 'A model proposes; the same gates validate.' },
};

export function Evidence({ run, evalSummary }: { run: RecoveryRun; evalSummary: EvalSummary }) {
  const baseline = run.arms.find((a) => a.policy === 'baseline')!;
  const final = run.arms.find((a) => a.policy === 'ev') ?? run.arms.find((a) => a.policy !== 'baseline')!;

  return (
    <div className="ax-evidence">
      <HeroDelta baseline={baseline} final={final} run={run} evalSummary={evalSummary} />
      <ArmTable arms={run.arms} baseline={baseline} />
      <StabilityPanel summary={evalSummary} />
      <ProvenancePanel summary={evalSummary} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function HeroDelta({ baseline, final, run, evalSummary }: {
  baseline: PolicyResult; final: PolicyResult; run: RecoveryRun; evalSummary: EvalSummary;
}) {
  const valueDelta = (final.value_recovery_pct ?? 0) - (baseline.value_recovery_pct ?? 0);
  const animated = useCountUp(valueDelta, 700);
  const capture = evalSummary.headline?.finalCaptureOfCeilingPct;
  const sweepMean = evalSummary.headline?.finalValuePctMean;
  const ci = evalSummary.valueDeltaCi;
  const seeds = evalSummary.headline?.seeds ?? evalSummary.batches;

  return (
    <div className="ax-hero sheet">
      <div>
        <span className="eyebrow">Value recovery, FINAL policy minus baseline · seed {run.seed}</span>
        <div className="figure ax-hero__figure">
          +{animated.toFixed(1)}<span className="ax-hero__unit">pp</span>
        </div>
        <p className="ax-hero__line figure">
          {baseline.value_recovery_pct?.toFixed(1)}% → <strong>{final.value_recovery_pct?.toFixed(1)}%</strong> of at-risk value
          {run.oracle_ceiling_pct != null && (
            <> · provable ceiling {run.oracle_ceiling_pct.toFixed(1)}%</>
          )}
        </p>
      </div>
      <div className="ax-hero__facts">
        {sweepMean != null && (
          <p className="ax-hero__note">
            Single-seed numbers are anecdotes. Across <strong className="figure">{seeds} paired seeds</strong> the
            FINAL policy averages <strong className="figure">{sweepMean.toFixed(1)}%</strong> value recovery
            {capture != null && <> — <strong className="figure">{capture.toFixed(0)}%</strong> of what dynamic
            programming proves is the maximum for this exact configuration</>}.
            {ci && <> The paired 95% interval on the delta is{' '}
              <strong className="figure">[{ci.lo.toFixed(1)}, {ci.hi.toFixed(1)}]pp</strong> — it excludes
              zero, so this is not a lucky draw.</>}
          </p>
        )}
        <p className="ax-hero__note">
          Every rupee here is <strong>simulated</strong> against the hash-frozen response
          model, net of channel spend and the estimated cost of customers annoyed into
          opting out. Execution is dry-run. No live money was moved, and no number on
          this screen pretends otherwise.
        </p>
        {final.stillInProgress > 0 && (
          <p className="ax-hero__warn">
            {final.stillInProgress} records had not reached a terminal state when the
            window closed. This comparison is against a moving target — widen the
            round count before quoting it.
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ArmTable({ arms, baseline }: { arms: PolicyResult[]; baseline: PolicyResult }) {
  const chartData = arms.map((a) => ({
    name: ARM_LABEL[a.policy]?.name ?? a.policy,
    value: a.value_recovery_pct ?? 0,
    policy: a.policy,
  }));
  const barColor = (p: string) =>
    p === 'baseline' ? 'var(--ink-faint)' : p === 'smart' ? 'var(--owed)' : 'var(--tie)';

  return (
    <section className="ax-arms">
      <h3>{arms.length} arms, one seeded population, money-weighted</h3>

      <div className="ax-arms__chart">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="2 4" stroke="var(--rule)" vertical={false} />
            <XAxis dataKey="name" stroke="var(--ink-faint)" tick={{ fontSize: 12 }} axisLine={{ stroke: 'var(--rule-strong)' }} />
            <YAxis stroke="var(--ink-faint)" tick={{ fontSize: 12 }} axisLine={false} tickLine={false}
              tickFormatter={(v: number) => `${v}%`} />
            <Tooltip
              contentStyle={{
                background: 'var(--paper-raised)',
                border: '1px solid var(--rule-strong)',
                borderRadius: 3,
                fontSize: 12,
              }}
              formatter={(v: number) => [`${v.toFixed(1)}% of at-risk value`, 'Recovered']}
            />
            <ReferenceLine y={baseline.value_recovery_pct ?? 0} stroke="var(--ink-faint)" strokeDasharray="4 4" />
            <Bar dataKey="value" radius={[2, 2, 0, 0]}>
              {chartData.map((d) => (
                <Cell key={d.policy} fill={barColor(d.policy)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="ax-arms__caption">
          Dashed line is the blind baseline. The bars are <em>value</em> recovered —
          the count metric used to hide a bug that condemned 93% of the money while
          the count looked healthy.
        </p>
      </div>

      <table className="ax-table ax-arms__table">
        <thead>
          <tr>
            <th scope="col">Arm</th>
            <th scope="col" className="num">Recovered</th>
            <th scope="col" className="num">Value %</th>
            <th scope="col" className="num">Gross</th>
            <th scope="col" className="num">Direct cost</th>
            <th scope="col" className="num">Opt-out loss</th>
            <th scope="col" className="num">Net</th>
            <th scope="col" className="num">Δ vs baseline</th>
          </tr>
        </thead>
        <tbody>
          {arms.map((a) => {
            const d = a.net_recovered - baseline.net_recovered;
            return (
              <tr key={a.policy}>
                <td>
                  <strong>{ARM_LABEL[a.policy]?.name ?? a.policy}</strong>
                  <span className="ax-arms__note">{ARM_LABEL[a.policy]?.note}</span>
                </td>
                <td className="figure num">{a.records_recovered} / {a.records_total}</td>
                <td className="figure num"><strong>{a.value_recovery_pct != null ? `${a.value_recovery_pct.toFixed(1)}%` : '—'}</strong></td>
                <td className="figure num">{rupees(a.gross_recovered)}</td>
                <td className="figure num">{rupees(a.direct_cost)}</td>
                <td className="figure num">{rupees(a.optout_loss)}</td>
                <td className="figure num"><strong>{rupees(a.net_recovered)}</strong></td>
                <td className={`figure num ax-arms__delta ${d > 0 ? 'is-up' : d < 0 ? 'is-down' : ''}`}>
                  {a.policy === 'baseline' ? '—' : rupees(d, { sign: true })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------------ */

/**
 * How stable is each claim across independent populations? Count is
 * the stable claim; rupees swing on a few large invoices; value-% is
 * the compromise — money-weighted, but bounded, so it is the one the
 * confidence interval is quoted on.
 */
function StabilityPanel({ summary }: { summary: EvalSummary }) {
  const rows = [
    {
      key: 'count',
      title: 'Payments recovered',
      unit: 'records',
      stat: summary.countDelta,
      stable: summary.countDelta.cv < 100,
      verdict: 'The stable claim. Count is bounded, so the spread is honest.',
      fmt: (n: number) => n.toFixed(1),
    },
    {
      key: 'value',
      title: 'Value recovered',
      unit: 'percentage points',
      stat: summary.valueDelta ?? null,
      stable: true,
      ci: summary.valueDeltaCi,
      verdict: 'The bar metric. Money-weighted, bounded, CI excludes zero.',
      fmt: (n: number) => `${n.toFixed(1)}pp`,
    },
    {
      key: 'rupee',
      title: 'Net ₹ recovered',
      unit: 'rupees',
      stat: summary.rupeeDelta,
      stable: summary.rupeeDelta.cv < 100,
      ci: summary.netDeltaCi,
      verdict: 'Directionally right, genuinely noisy — quote the interval, not the point.',
      fmt: (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
    },
  ].filter((r) => r.stat);

  const ceiling = summary.oracleCeilingPct;

  return (
    <section className="ax-stability">
      <h3>How stable is each claim, across {summary.batches} independent seeds?</h3>

      <div className="ax-stability__grid">
        {rows.map((r) => (
          <div key={r.key} className={`ax-stat sheet ${r.stable ? 'is-stable' : 'is-noisy'}`}>
            <div className="ax-stat__head">
              <span className="eyebrow">{r.title} — delta, {r.unit}</span>
              <span className={`ax-chip ${r.stable ? 'ax-chip--tie' : 'ax-chip--owed'}`}>
                {r.stable ? 'stable' : 'cv > 100%'}
              </span>
            </div>

            <div className="figure ax-stat__mean">{r.fmt(r.stat!.mean)}</div>

            {r.ci && (
              <p className="ax-stat__ci figure">
                95% CI [{r.fmt(r.ci.lo)}, {r.fmt(r.ci.hi)}]
                <span className={`ax-chip ${r.ci.lo > 0 || r.ci.hi < 0 ? 'ax-chip--tie' : 'ax-chip--owed'}`}>
                  {r.ci.lo > 0 || r.ci.hi < 0 ? 'excludes zero' : 'straddles zero'}
                </span>
              </p>
            )}

            <dl className="ax-stat__facts">
              <div><dt>sd</dt><dd className="figure">{r.fmt(r.stat!.sd)}</dd></div>
              <div><dt>cv</dt><dd className="figure">{r.stat!.cv.toFixed(1)}%</dd></div>
              <div><dt>range</dt><dd className="figure">{r.fmt(r.stat!.min)} … {r.fmt(r.stat!.max)}</dd></div>
              <div><dt>won</dt><dd className="figure">{r.stat!.wins}/{r.stat!.batches} seeds</dd></div>
            </dl>

            <p className="ax-stat__verdict">{r.verdict}</p>
          </div>
        ))}
      </div>

      {ceiling && (
        <p className="ax-stability__foot">
          The anchor for all of it: an omniscient policy — one that knew every
          outcome in advance — recovers <strong className="figure">{ceiling.mean.toFixed(1)}%</strong> of
          value on these exact rules (mean across seeds, ±{ceiling.sd.toFixed(1)}). That is the{' '}
          <strong>mathematical ceiling</strong>, computed by dynamic programming over the frozen model.
          The FINAL policy captures {summary.headline?.finalCaptureOfCeilingPct?.toFixed(0) ?? '—'}% of it
          while remaining blind to the answer key. The honest headline is the{' '}
          <strong>interval and the capture fraction</strong>, never a single-seed percentage.
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ProvenancePanel({ summary }: { summary: EvalSummary }) {
  const p = summary.provenance;
  if (!p) return null;
  return (
    <section className="ax-stability">
      <h3>How these numbers were produced</h3>
      <dl className="ax-stat__facts ax-prov">
        <div><dt>seeds</dt><dd className="figure">{p.seeds.join(', ')}</dd></div>
        <div><dt>warm-up</dt><dd className="figure">{p.warmup} held-out populations ({p.warmupSeeds[0]}…{p.warmupSeeds[p.warmupSeeds.length - 1]})</dd></div>
        <div><dt>population</dt><dd className="figure">{p.records} records × {p.rounds} rounds per seed</dd></div>
        <div><dt>pairing</dt><dd>{p.pairing}</dd></div>
        <div><dt>bootstrap</dt><dd>{p.bootstrap}</dd></div>
        <div><dt>regenerate</dt><dd><code className="figure">{p.regenerate}</code></dd></div>
        <div><dt>generated</dt><dd className="figure">{new Date(p.generatedAt).toLocaleString('en-IN')}</dd></div>
      </dl>
      <p className="ax-stability__foot">
        The sweep is deterministic — fixed seeds, seeded bootstrap, no Math.random()
        anywhere in the path — so regenerating it reproduces every number on this
        screen. Warm-up populations are disjoint from evaluation seeds: a
        train/test split, not a rehearsal on the exam.
      </p>
    </section>
  );
}
