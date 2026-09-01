import { useMemo, useState } from 'react';
import type { LedgerRow, LedgerVerdict, ReconSummary } from '@/types/domain';
import { rupees, percent, gutterWidth, titleCase, dateIST } from '@/services/format';
import { useCountUp } from '@/hooks/useCountUp';
import './ledger.css';

/* ------------------------------------------------------------------ */
/* Verdict → visual class. Colour carries the verdict and nothing else. */
/* ------------------------------------------------------------------ */

const VERDICT_CLASS: Record<LedgerVerdict, 'tie' | 'owed' | 'break'> = {
  exact: 'tie',
  explained_split: 'tie',
  explained_refund: 'tie',
  explained_fee: 'owed',
  flagged_duplicate: 'break',
  unexplained: 'break',
  orphan_credit: 'break',
};

const GOES_TO_PERSON: Record<LedgerVerdict, string> = {
  exact: 'No',
  explained_split: 'No',
  explained_refund: 'No',
  explained_fee: 'Yes — low priority',
  flagged_duplicate: 'Yes — high priority',
  unexplained: 'Yes — high priority',
  orphan_credit: 'Yes — high priority',
};

type Filter = 'all' | 'tie' | 'owed' | 'break';

export function LedgerTable({
  rows,
  summary,
}: {
  rows: LedgerRow[];
  summary: ReconSummary;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (filter !== 'all' && VERDICT_CLASS[r.verdict] !== filter) return false;
        if (query && !r.payment_id.toLowerCase().includes(query.toLowerCase())) return false;
        return true;
      }),
    [rows, filter, query],
  );

  // The gutter is scaled against the whole batch, not the filtered view —
  // otherwise filtering to the small breaks would silently rescale them
  // to look enormous.
  const maxAbs = useMemo(
    () => rows.reduce((m, r) => Math.max(m, Math.abs(r.delta)), 0),
    [rows],
  );

  const counts = useMemo(() => {
    const c = { tie: 0, owed: 0, break: 0 };
    rows.forEach((r) => c[VERDICT_CLASS[r.verdict]]++);
    return c;
  }, [rows]);

  return (
    <div className="ax-ledger">
      <TieOut summary={summary} counts={counts} />

      <div className="ax-ledger__controls">
        <label className="sr-only" htmlFor="ledger-search">Find a payment</label>
        <input
          id="ledger-search"
          type="search"
          placeholder="Find a payment ID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ax-segmented" role="group" aria-label="Filter by verdict">
          {(['all', 'tie', 'owed', 'break'] as Filter[]).map((f) => (
            <button
              key={f}
              className={`ax-segmented__btn ${filter === f ? 'is-active' : ''} tone-${f}`}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
            >
              {f === 'all' ? 'All' : f === 'tie' ? 'Tied out' : f === 'owed' ? 'Still owed' : 'Needs a person'}
              <span className="figure ax-segmented__n">
                {f === 'all' ? rows.length : counts[f]}
              </span>
            </button>
          ))}
        </div>
        <button onClick={() => exportCsv(visible)} className="ax-ledger__export">
          Export {visible.length} rows
        </button>
      </div>

      <table className="ax-table">
        <caption className="sr-only">
          Reconciliation: expected settlement against actual settlement, with the
          difference and its explanation.
        </caption>
        <thead>
          <tr>
            <th scope="col">Payment</th>
            <th scope="col" className="num">Should settle</th>
            <th scope="col" className="gutter-head" title="Left of centre is short, right is over. Square-root scaled so small breaks stay legible.">
              Difference
            </th>
            <th scope="col" className="num">Actually settled</th>
            <th scope="col">Verdict</th>
            <th scope="col">To a person?</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const tone = VERDICT_CLASS[r.verdict];
            const isOpen = openRow === r.payment_id;
            return (
              <>
                <tr
                  key={r.payment_id}
                  className={`tone-${tone} ${isOpen ? 'is-open' : ''}`}
                  onClick={() => setOpenRow(isOpen ? null : r.payment_id)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpenRow(isOpen ? null : r.payment_id);
                    }
                  }}
                >
                  <td className="figure id">
                    {r.payment_id}
                    {r.pairRole && (
                      <span className={`ax-pair ax-pair--${r.pairRole}`}>{r.pairRole}</span>
                    )}
                  </td>
                  <td className="figure num">{rupees(r.expected)}</td>
                  <td className="gutter">
                    <DeltaGutter delta={r.delta} maxAbs={maxAbs} tone={tone} />
                  </td>
                  <td className="figure num">{rupees(r.actual)}</td>
                  <td>
                    <span className={`ax-verdict tone-${tone}`}>{titleCase(r.verdict)}</span>
                  </td>
                  <td className="ax-toperson">{GOES_TO_PERSON[r.verdict]}</td>
                </tr>
                {isOpen && (
                  <tr className="ax-table__detail" key={`${r.payment_id}-d`}>
                    <td colSpan={6}>
                      <div className="ax-detail">
                        <div>
                          <span className="eyebrow">Explanation</span>
                          <p>{r.explanation}</p>
                        </div>
                        <dl className="ax-detail__facts">
                          <div><dt>Merchant</dt><dd className="figure">{r.merchant_id}</dd></div>
                          <div><dt>Settled</dt><dd className="figure">{dateIST(r.settled_at)}</dd></div>
                          <div><dt>Difference</dt><dd className="figure">{rupees(r.delta, { sign: true })}</dd></div>
                        </dl>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>

      {visible.length === 0 && (
        <p className="ax-state">No rows match that filter. Clear the search to see the full batch.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The delta gutter — this project's signature                         */
/* ------------------------------------------------------------------ */

/**
 * A row that ties out draws NOTHING. That absence is the point: scanning the
 * gutter column alone shows the shape of a batch before a single figure is
 * read, and a clean batch reads as a clean empty channel.
 */
function DeltaGutter({
  delta,
  maxAbs,
  tone,
}: {
  delta: number;
  maxAbs: number;
  tone: 'tie' | 'owed' | 'break';
}) {
  if (delta === 0) {
    return (
      <span className="ax-gutter" aria-label="Ties out exactly">
        <span className="ax-gutter__centre" />
      </span>
    );
  }
  const w = gutterWidth(delta, maxAbs);
  const short = delta < 0;
  return (
    <span
      className="ax-gutter"
      aria-label={`${short ? 'Short by' : 'Over by'} ${rupees(Math.abs(delta))}`}
      title={rupees(delta, { sign: true })}
    >
      <span className="ax-gutter__centre" />
      <span
        className={`ax-gutter__bar tone-${tone} ${short ? 'is-short' : 'is-over'}`}
        style={{ width: `${w / 2}%` }}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Tie-out — the hero figure, decomposed                               */
/* ------------------------------------------------------------------ */

function TieOut({
  summary,
  counts,
}: {
  summary: ReconSummary;
  counts: { tie: number; owed: number; break: number };
}) {
  const animated = useCountUp(summary.gap_total, 700);
  const total = summary.gap_total || 1;

  const parts = [
    { key: 'tie',   label: 'Tied out',        value: summary.gap_tied },
    { key: 'owed',  label: 'Explained, owed', value: summary.gap_explained_owed },
    { key: 'break', label: 'Needs a person',  value: summary.gap_needs_person },
  ] as const;

  return (
    <div className="ax-tieout sheet">
      <div className="ax-tieout__figure">
        <span className="eyebrow">Unreconciled across {summary.rows_examined} payments</span>
        <div className="figure ax-tieout__amount">{rupees(Math.round(animated))}</div>
        <p className="ax-tieout__note">
          A reconciler that reports a total it cannot break down is reporting a
          number, not a result. The parts below sum back to this figure — rows
          that tie out contribute exactly ₹0.00.
        </p>
      </div>

      <div className="ax-tieout__decomp">
        <div className="ax-decomp__bar" role="img" aria-label="Gap decomposed by verdict class">
          {parts.map((p) => (
            <span
              key={p.key}
              className={`ax-decomp__seg tone-${p.key}`}
              style={{ width: `${(p.value / total) * 100}%` }}
            />
          ))}
        </div>
        <ul className="ax-decomp__legend">
          {parts.map((p, i) => (
            <li key={p.key}>
              <span className={`ax-swatch tone-${p.key}`} />
              <span className="ax-decomp__label">{p.label}</span>
              <span className="figure ax-decomp__value">{rupees(p.value)}</span>
              <span className="ax-decomp__count figure">
                {i === 0 ? counts.tie : i === 1 ? counts.owed : counts.break} rows
              </span>
            </li>
          ))}
        </ul>

        <dl className="ax-scorecard">
          <div>
            <dt>Precision</dt>
            <dd className="figure">{percent(summary.precision)}</dd>
          </div>
          <div>
            <dt>Recall</dt>
            <dd className="figure">{percent(summary.recall)}</dd>
          </div>
          <div>
            <dt>Explanation accuracy</dt>
            <dd className="figure">{percent(summary.explanation_accuracy)}</dd>
          </div>
        </dl>
        <p className="ax-scorecard__caveat">
          Scored across 25 independent batches, not the one on screen — a single
          batch is an anecdote and shouldn't be dressed as a measurement just
          because it happens to be displayed. Explanation accuracy is the
          informative figure here precisely because it isn't perfect.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function exportCsv(rows: LedgerRow[]) {
  const head = ['payment_id', 'merchant_id', 'expected_paise', 'actual_paise', 'delta_paise', 'verdict', 'severity', 'explanation'];
  const body = rows.map((r) =>
    [r.payment_id, r.merchant_id, r.expected, r.actual, r.delta, r.verdict, r.severity, `"${r.explanation.replace(/"/g, '""')}"`].join(','),
  );
  const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `axiom-ledger-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
