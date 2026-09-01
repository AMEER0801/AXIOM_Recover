import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import type { EvalSummary, PolicyResult, RecoveryRun } from '@/types/domain';
import { rupees, rupeeValue } from '@/services/format';
import { useCountUp } from '@/hooks/useCountUp';
import './evidence.css';

/**
 * The evidence screen.
 *
 * A single "the agent recovered ₹X" figure is unfalsifiable — there is
 * nothing to compare it against. Every claim on this screen is a DELTA
 * against a baseline that ran on the identical seeded population through
 * the identical gates, and every delta is reported net of what it cost to
 * produce.
 */

const ARM_LABEL: Record<string, { name: string; note: string }> = {
  baseline: { name: 'Baseline', note: 'Retry everything, blindly. What a merchant gets with zero intelligence.' },
  smart:    { name: 'Smart',    note: 'Rule-based, reads the same failure taxonomy Razorpay already returns.' },
  llm:      { name: 'LLM',      note: 'A real model proposes; the same gates validate. Groq free tier.' },
};

export function Evidence({ run, evalSummary }: { run: RecoveryRun; evalSummary: EvalSummary }) {
  const baseline = run.arms.find((a) => a.policy === 'baseline')!;
  const smart = run.arms.find((a) => a.policy === 'smart')!;

  return (
    <div className="ax-evidence">
      <HeroDelta baseline={baseline} smart={smart} />
      <ArmTable arms={run.arms} baseline={baseline} />
      <StabilityPanel summary={evalSummary} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function HeroDelta({ baseline, smart }: { baseline: PolicyResult; smart: PolicyResult }) {
  const delta = smart.net_recovered - baseline.net_recovered;
  const animated = useCountUp(delta, 700);

  return (
    <div className="ax-hero sheet">
      <div>
        <span className="eyebrow">Smart minus baseline, net of cost</span>
        <div className="figure ax-hero__figure">{rupees(Math.round(animated), { sign: true })}</div>
      </div>
      <p className="ax-hero__note">
        Baseline's cost is genuinely zero — a silent retry costs nothing to
        send. Smart's advantage has to clear that bar before it counts as an
        improvement at all, which is why this figure is reported after
        subtracting every message sent <em>and</em> the estimated value of the
        customers annoyed into opting out.
      </p>
      {smart.stillInProgress > 0 && (
        <p className="ax-hero__warn">
          {smart.stillInProgress} records had not reached a terminal state when the
          window closed. This comparison is against a moving target — widen the
          round count before quoting it.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ArmTable({ arms, baseline }: { arms: PolicyResult[]; baseline: PolicyResult }) {
  const chartData = arms.map((a) => ({
    name: ARM_LABEL[a.policy].name,
    recovered: a.records_recovered,
    net: rupeeValue(a.net_recovered),
    policy: a.policy,
  }));

  return (
    <section className="ax-arms">
      <h3>Three arms, one seeded population</h3>

      <div className="ax-arms__chart">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="2 4" stroke="var(--rule)" vertical={false} />
            <XAxis dataKey="name" stroke="var(--ink-faint)" tick={{ fontSize: 12 }} axisLine={{ stroke: 'var(--rule-strong)' }} />
            <YAxis stroke="var(--ink-faint)" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{
                background: 'var(--paper-raised)',
                border: '1px solid var(--rule-strong)',
                borderRadius: 3,
                fontSize: 12,
              }}
              formatter={(v: number) => [`${v} payments`, 'Recovered']}
            />
            <ReferenceLine y={baseline.records_recovered} stroke="var(--ink-faint)" strokeDasharray="4 4" />
            <Bar dataKey="recovered" radius={[2, 2, 0, 0]}>
              {chartData.map((d) => (
                <Cell
                  key={d.policy}
                  fill={d.policy === 'baseline' ? 'var(--ink-faint)' : d.policy === 'smart' ? 'var(--tie)' : 'var(--gate)'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="ax-arms__caption">
          Dashed line is the baseline. Losing to the rule-based arm is a
          legitimate, reportable outcome for the LLM — not a result to bury.
        </p>
      </div>

      <table className="ax-table ax-arms__table">
        <thead>
          <tr>
            <th scope="col">Arm</th>
            <th scope="col" className="num">Recovered</th>
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
                  <strong>{ARM_LABEL[a.policy].name}</strong>
                  <span className="ax-arms__note">{ARM_LABEL[a.policy].note}</span>
                </td>
                <td className="figure num">{a.records_recovered} / {a.records_total}</td>
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
 * The distinction this panel exists to make: the count-based delta is a
 * reliable claim, the rupee-based delta is directionally right but noisy.
 * Reporting only the rupee figure would either overstate confidence on a
 * lucky seed or make a consistently-working policy look shaky.
 */
function StabilityPanel({ summary }: { summary: EvalSummary }) {
  const rows = [
    {
      key: 'count',
      title: 'Payments recovered',
      unit: 'a count',
      stat: summary.countDelta,
      stable: summary.countDelta.cv < 100,
      verdict: 'The reliable claim.',
      fmt: (n: number) => n.toFixed(1),
    },
    {
      key: 'rupee',
      title: 'Net ₹ recovered',
      unit: 'rupees',
      stat: summary.rupeeDelta,
      stable: summary.rupeeDelta.cv < 100,
      verdict: 'Directionally right, genuinely noisy.',
      fmt: (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
    },
  ];

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

            <div className="figure ax-stat__mean">{r.fmt(r.stat.mean)}</div>

            <dl className="ax-stat__facts">
              <div><dt>sd</dt><dd className="figure">{r.fmt(r.stat.sd)}</dd></div>
              <div><dt>cv</dt><dd className="figure">{r.stat.cv.toFixed(1)}%</dd></div>
              <div><dt>range</dt><dd className="figure">{r.fmt(r.stat.min)} … {r.fmt(r.stat.max)}</dd></div>
              <div><dt>smart won</dt><dd className="figure">{r.stat.wins}/{r.stat.batches}</dd></div>
            </dl>

            <p className="ax-stat__verdict">{r.verdict}</p>
          </div>
        ))}
      </div>

      <p className="ax-stability__foot">
        The rupee spread is dominated by whether one or two high-value overdue
        invoices happen to convert in a given draw, not by the policy being
        unreliable — and a bigger batch doesn't fix that on its own, because a
        handful of large invoices still swings a bigger total by a proportionally
        similar amount. So the honest headline is{' '}
        <strong>“recovers more payments, reliably”</strong> — not a specific rupee
        figure, yet.
      </p>
    </section>
  );
}
