import { useMemo, useState } from 'react';
import type { AuditEntry, ChainVerification } from '@/types/domain';
import { timeIST } from '@/services/format';
import { downloadAuditSeal } from '@/services/api';
import './audit.css';

/**
 * The audit chain viewer.
 *
 * States the honest claim up front: this is tamper-EVIDENT, not
 * tamper-PROOF. Anyone who can rewrite the whole file can recompute every
 * hash from their edit onward. What the chain defends against is a casual or
 * partial edit — one changed amount, one deleted inconvenient row, entries
 * shuffled. Letting a reviewer assume the stronger claim would be the kind of
 * quiet overstatement this project exists to avoid.
 */

/* Tone by kind — the engine's closed set, not an invented one. */
const KIND_TONE: Record<AuditEntry['kind'], string> = {
  run_started: 'neutral',
  decision: 'gate',
  execution: 'owed',
  outcome: 'tie',
  state_change: 'break',
  run_ended: 'neutral',
};

const FILTER_KINDS = ['all', 'decision', 'execution', 'outcome', 'state_change'] as const;

export function AuditChain({
  entries,
  verification,
}: {
  entries: AuditEntry[];
  verification: ChainVerification;
}) {
  const [filter, setFilter] = useState<'all' | AuditEntry['kind']>('all');
  const [open, setOpen] = useState<number | null>(null);
  const [exportState, setExportState] = useState<'idle' | 'done' | 'failed'>('idle');

  const visible = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => e.kind === filter)),
    [entries, filter],
  );

  /**
   * A decision must be recorded BEFORE its execution — a crash between the
   * two should leave evidence, not a gap. This checks the invariant in the
   * browser rather than trusting that the backend held it.
   */
  const orphanExecutions = useMemo(() => {
    const seen = new Set<string>();
    const orphans: number[] = [];
    for (const e of entries) {
      if (e.kind === 'decision' && e.entity_id) seen.add(e.entity_id);
      if (e.kind === 'execution' && (!e.entity_id || !seen.has(e.entity_id))) orphans.push(e.seq);
    }
    return orphans;
  }, [entries]);

  return (
    <div className="ax-audit">
      <div className={`ax-chain sheet ${verification.valid ? 'is-valid' : 'is-broken'}`}>
        <div>
          <span className="eyebrow">Chain verification</span>
          <p className="ax-chain__headline">
            {verification.valid
              ? `${verification.entries} entries, chain intact`
              : `Chain breaks at sequence ${verification.brokenAt}`}
          </p>
          <p className="ax-chain__formula figure">
            hash(n) = sha256( seq | ts | hash(n−1) | canonical(payload) )
          </p>
          {typeof verification.prevented_actions === 'number' && verification.prevented_actions > 0 && (
            <p className="ax-chain__prevented figure">
              {verification.prevented_actions} gate vetoes recorded inside these payloads — every
              action the system REFUSED to take is counted here, read from the chain itself rather
              than a second counter that could drift from it.
            </p>
          )}
        </div>

        <div className="ax-chain__side">
          <span className="eyebrow">Head</span>
          <code className="figure ax-chain__head">{verification.head}</code>
          <p className="ax-chain__note">
            The audit clock is the run's simulated time, not wall-clock, so the
            same seed produces a byte-identical chain. This head is therefore a
            fingerprint of an entire run — different seed, different hash.
          </p>
          <button
            className="ax-chain__export"
            onClick={() => void downloadAuditSeal('run').then((r) => setExportState(r.ok ? 'done' : 'failed'))}
          >
            Export audit seal (chain + merkle root)
          </button>
          {exportState === 'failed' && (
            <p className="ax-chain__export-note is-failed">
              Export failed — the backend on :3000 is not reachable. The seal is built server-side
              from the live chain, so it cannot be faked offline.
            </p>
          )}
          {exportState === 'done' && (
            <p className="ax-chain__export-note">
              Downloaded. Verify it standalone, with nothing from this repo except the script:
              <code className="figure"> node server/verify-proof.js axiom-audit-seal-*.json</code>
            </p>
          )}
        </div>
      </div>

      <p className="ax-audit__claim">
        <strong>Tamper-evident, not tamper-proof.</strong> Change one amount and
        that entry's hash stops matching its contents; recompute it and the next
        entry's <code>prev_hash</code> stops matching. What this does not defend
        against is someone with write access rewriting the whole file and
        recomputing every hash from their edit onward. The merkle root in the
        exported seal is the documented answer to exactly that attack: publish
        the root anywhere append-only — email it to finance, commit it, notarise
        it — and any later bundle that verifies internally but commits to a
        different root is provably not the original. Signing each entry with a
        key the writer doesn't hold is the full upgrade path, not something
        already here.
      </p>

      {orphanExecutions.length > 0 && (
        <p className="ax-audit__violation">
          {orphanExecutions.length} execution entries have no preceding decision
          (sequences {orphanExecutions.join(', ')}). No action without a recorded
          reason is an invariant, not a preference — this is a real defect.
        </p>
      )}

      <div className="ax-audit__filters">
        {FILTER_KINDS.map((k) => (
          <button
            key={k}
            className={filter === k ? 'is-active' : ''}
            onClick={() => setFilter(k as 'all' | AuditEntry['kind'])}
            aria-pressed={filter === k}
          >
            {k === 'all' ? 'All entries' : k.replace('_', ' ')}
          </button>
        ))}
      </div>

      <ol className="ax-entries">
        {visible.map((e) => (
          <li key={e.seq} className={`ax-entry tone-${KIND_TONE[e.kind]}`}>
            <button className="ax-entry__row" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
              <span className="figure ax-entry__seq">{String(e.seq).padStart(4, '0')}</span>
              <span className={`ax-chip ax-chip--quiet ax-entry__kind`}>{e.kind}</span>
              <span className="figure ax-entry__id">{e.entity_id ?? '—'}</span>
              <span className="figure ax-entry__hash">{e.hash.slice(0, 12)}…</span>
              <span className="figure ax-entry__ts">{timeIST(e.ts)}</span>
            </button>
            {open === e.seq && (
              <div className="ax-entry__payload">
                <div className="ax-entry__links figure">
                  <span>prev {e.prev_hash.slice(0, 20)}…</span>
                  <span>→</span>
                  <span>this {e.hash.slice(0, 20)}…</span>
                </div>
                <pre className="figure">{JSON.stringify(e.payload, null, 2)}</pre>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
