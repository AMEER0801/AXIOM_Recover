import type { GateTrace } from '@/types/domain';
import './gates.css';

/**
 * Renders the full eleven-gate trace — including the gates that passed.
 *
 * A trace that only shows failures invites the question "were the others
 * actually checked?" This component is built so that question doesn't need
 * asking, which is also why it refuses to render a short trace: if fewer
 * than eleven entries arrive, that is a backend bug and the UI says so
 * rather than quietly displaying a partial record as if it were complete.
 */
export function GateTraceList({ trace }: { trace: GateTrace }) {
  if (trace.length !== 11) {
    return (
      <p className="ax-gates__malformed">
        Trace contains {trace.length} entries, expected 11. Every gate must record
        an entry on every call — this trace is incomplete and is not being shown
        as if it were whole.
      </p>
    );
  }

  return (
    <ol className="ax-gates">
      {trace.map((e, i) => (
        <li key={e.gate} className={`ax-gate ${e.blocked ? 'is-blocked' : 'is-passed'}`}>
          <span className="ax-gate__n figure">{String(i + 1).padStart(2, '0')}</span>
          <span className="ax-gate__mark" aria-hidden="true">{e.blocked ? '✗' : '✓'}</span>
          <span className="ax-gate__name">{e.gate}</span>
          <span className="ax-gate__detail">{e.detail}</span>
          <span className="sr-only">{e.blocked ? 'Blocked' : 'Passed'}</span>
        </li>
      ))}
    </ol>
  );
}
