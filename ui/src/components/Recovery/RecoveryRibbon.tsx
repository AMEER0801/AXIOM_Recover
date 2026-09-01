import { useMemo, useState } from 'react';
import type { RecoveryRun, RecoveryRecord, RoundOutcome, GateCoverage } from '@/types/domain';
import { rupees, titleCase } from '@/services/format';
import { GateTraceList } from '@/components/Gates/GateTraceList';
import './recovery.css';

/**
 * The decision ribbon: one track per record, one cell per round.
 *
 * Semantic note that differs from the ledger console on purpose — here, a
 * gate blocking an action is the system WORKING, not a fault. It gets the
 * deliberate-intervention indigo, never the exception red.
 */

const OUTCOME_LABEL: Record<RoundOutcome, string> = {
  paid: 'Recovered',
  gated: 'Gate intervened',
  escalated: 'To a person',
  written_off: 'Written off',
  attempted: 'Attempted',
  idle: 'Nothing proposed',
};

const OUTCOME_TONE: Record<RoundOutcome, string> = {
  paid: 'tie',
  gated: 'gate',
  escalated: 'owed',
  written_off: 'break',
  attempted: 'neutral',
  idle: 'empty',
};

export function RecoveryRibbon({ run }: { run: RecoveryRun }) {
  const [selected, setSelected] = useState<RecoveryRecord | null>(null);
  const [openRound, setOpenRound] = useState(0);

  const sorted = useMemo(
    () =>
      [...run.records].sort((a, b) => {
        const order = { recovered: 0, escalated: 1, in_progress: 2, written_off: 3 };
        return order[a.terminal] - order[b.terminal] || b.amount - a.amount;
      }),
    [run.records],
  );

  const recovered = run.records.filter((r) => r.terminal === 'recovered').length;
  const reconciled = run.records.filter((r) => r.reconciled).length;

  return (
    <div className="ax-recovery">
      <div className="ax-verified sheet">
        <div>
          <span className="eyebrow">Verified recovery</span>
          <p className="ax-verified__line">
            <strong className="figure">{recovered}</strong> payments recovered,{' '}
            <strong className="figure">{reconciled}</strong> independently reconciled.
          </p>
          <p className="ax-verified__note">
            Every recovery is fed back through the same reconciler that tears
            apart a settlement file. Only what reconciles is reported here. The
            agent does not grade its own homework.
          </p>
        </div>
        <Legend />
      </div>

      <div className="ax-ribbon" role="group" aria-label="Recovery decisions by record and round">
        <div className="ax-ribbon__rounds">
          <span className="ax-ribbon__spacer" />
          {Array.from({ length: run.rounds }, (_, i) => (
            <span key={i} className="ax-ribbon__roundlabel figure">{i + 1}</span>
          ))}
        </div>

        {sorted.slice(0, 40).map((rec) => (
          <button
            key={rec.id}
            className={`ax-track ${selected?.id === rec.id ? 'is-selected' : ''}`}
            onClick={() => { setSelected(selected?.id === rec.id ? null : rec); setOpenRound(0); }}
            aria-expanded={selected?.id === rec.id}
          >
            <span className="ax-track__meta">
              <span className="figure ax-track__amount">{rupees(rec.amount, { compact: true })}</span>
              <span className="ax-track__reason">{titleCase(rec.failure_reason)}</span>
            </span>
            <span className="ax-track__cells">
              {Array.from({ length: run.rounds }, (_, i) => {
                const round = rec.rounds[i];
                const outcome: RoundOutcome = round?.outcome ?? 'idle';
                return (
                  <span
                    key={i}
                    className={`ax-cell tone-${OUTCOME_TONE[outcome]}`}
                    title={`Round ${i + 1}: ${OUTCOME_LABEL[outcome]}${round?.blockedBy ? ` (${round.blockedBy})` : ''}`}
                  />
                );
              })}
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="ax-trace sheet">
          <div className="ax-trace__head">
            <div>
              <span className="eyebrow">Record {selected.id}</span>
              <h3>
                {rupees(selected.amount)} · {titleCase(selected.failure_reason)} · {selected.locale}
              </h3>
            </div>
            <button onClick={() => setSelected(null)}>Close</button>
          </div>

          <div className="ax-trace__rounds">
            {selected.rounds.map((r, i) => (
              <button
                key={r.round}
                className={`ax-trace__roundbtn ${openRound === i ? 'is-active' : ''} tone-${OUTCOME_TONE[r.outcome]}`}
                onClick={() => setOpenRound(i)}
              >
                <span className="figure">R{r.round}</span>
                <span>{r.proposed.replace(/_/g, ' ').toLowerCase()}</span>
              </button>
            ))}
          </div>

          {selected.rounds[openRound] && (
            <>
              <p className="ax-trace__verdict">
                {OUTCOME_LABEL[selected.rounds[openRound].outcome]}
                {selected.rounds[openRound].blockedBy && (
                  <> — blocked by <code>{selected.rounds[openRound].blockedBy}</code></>
                )}
                {selected.rounds[openRound].cost > 0 && (
                  <> · direct cost {rupees(selected.rounds[openRound].cost)}</>
                )}
              </p>
              <GateTraceList trace={selected.rounds[openRound].trace} />
            </>
          )}
        </div>
      )}

      <GateCoveragePanel coverage={run.coverage} />
    </div>
  );
}

function Legend() {
  const items: { tone: string; label: string }[] = [
    { tone: 'tie', label: 'Recovered' },
    { tone: 'gate', label: 'Gate intervened' },
    { tone: 'owed', label: 'To a person' },
    { tone: 'break', label: 'Written off' },
    { tone: 'neutral', label: 'Attempted' },
  ];
  return (
    <ul className="ax-legend">
      {items.map((i) => (
        <li key={i.tone}>
          <span className={`ax-swatch tone-${i.tone}`} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * A run that reports "all gates passed" while eight of them never had
 * anything to check is not telling you much. Three categories, and the
 * distinction between them is the whole point.
 */
function GateCoveragePanel({ coverage }: { coverage: GateCoverage[] }) {
  const fired = coverage.filter((c) => c.fired > 0);
  const silent = coverage.filter((c) => c.fired === 0);

  return (
    <div className="ax-coverage">
      <h3>
        Gate coverage — <span className="figure">{fired.length}/{coverage.length}</span> gates fired this run
      </h3>

      <ul className="ax-coverage__fired">
        {fired.map((c) => (
          <li key={c.gate}>
            <span className="ax-coverage__x">✗</span>
            <code>{c.gate}</code>
            <span className="figure">blocked {c.fired} times</span>
          </li>
        ))}
      </ul>

      <p className="eyebrow">Silent this run — and why</p>
      <ul className="ax-coverage__silent">
        {silent.map((c) => (
          <li key={c.gate}>
            <code>{c.gate}</code>
            <span className={`ax-chip ax-chip--quiet ax-reason--${c.silentReason}`}>
              {c.silentReason}
            </span>
            <span className="ax-coverage__detail">{c.silentDetail}</span>
          </li>
        ))}
      </ul>

      <p className="ax-coverage__foot">
        <strong>by-design</strong> gates should never fire in a healthy run.{' '}
        <strong>backstop</strong> gates exist to catch a policy that isn't careful —
        smartPolicy refusing to propose a business-paused nudge is the policy being
        good, not the gate being useless. <strong>scenario</strong> gates simply
        weren't reached by this batch. Every gate has a direct unit test that forces
        it to fire; silent here means unreached, not unexercised.
      </p>
    </div>
  );
}
