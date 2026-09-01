import { useMemo, useState } from 'react';
import type { AuditEntry, ChainVerification } from '@/types/domain';
import { timeIST } from '@/services/format';
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

const KIND_TONE: Record<AuditEntry['kind'], string> = {
  decision: 'gate',
  execution: 'owed',
  result: 'tie',
};

export function AuditChain({
  entries,
  verification,
}: {
  entries: AuditEntry[];
  verification: ChainVerification;
}) {
  const [filter, setFilter] = useState<'all' | AuditEntry['kind']>('all');
  const [open, setOpen] = useState<number | null>(null);

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
      if (e.kind === 'decision') seen.add(e.entity_id);
      if (e.kind === 'execution' && !seen.has(e.entity_id)) orphans.push(e.seq);
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
        </div>

        <div className="ax-chain__side">
          <span className="eyebrow">Head</span>
          <code className="figure ax-chain__head">{verification.head}</code>
          <p className="ax-chain__note">
            The audit clock is the run's simulated time, not wall-clock, so the
            same seed produces a byte-identical chain. This head is therefore a
            fingerprint of an entire run — different seed, different hash.
          </p>
        </div>
      </div>

      <p className="ax-audit__claim">
        <strong>Tamper-evident, not tamper-proof.</strong> Change one amount and
        that entry's hash stops matching its contents; recompute it and the next
        entry's <code>prev_hash</code> stops matching. What this does not defend
        against is someone with write access rewriting the whole file and
        recomputing every hash from their edit onward. Real tamper-proofing needs
        an anchor outside the file — signing with a key the writer doesn't hold,
        or committing the head somewhere append-only. That's the documented
        upgrade path, not something already here.
      </p>

      {orphanExecutions.length > 0 && (
        <p className="ax-audit__violation">
          {orphanExecutions.length} execution entries have no preceding decision
          (sequences {orphanExecutions.join(', ')}). No action without a recorded
          reason is an invariant, not a preference — this is a real defect.
        </p>
      )}

      <div className="ax-audit__filters">
        {(['all', 'decision', 'execution', 'result'] as const).map((k) => (
          <button
            key={k}
            className={filter === k ? 'is-active' : ''}
            onClick={() => setFilter(k)}
            aria-pressed={filter === k}
          >
            {k === 'all' ? 'All entries' : k}
          </button>
        ))}
      </div>

      <ol className="ax-entries">
        {visible.map((e) => (
          <li key={e.seq} className={`ax-entry tone-${KIND_TONE[e.kind]}`}>
            <button className="ax-entry__row" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
              <span className="figure ax-entry__seq">{String(e.seq).padStart(4, '0')}</span>
              <span className={`ax-chip ax-chip--quiet ax-entry__kind`}>{e.kind}</span>
              <span className="figure ax-entry__id">{e.entity_id}</span>
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
