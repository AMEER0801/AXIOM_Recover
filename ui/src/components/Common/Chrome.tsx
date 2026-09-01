import type { ReactNode } from 'react';
import type { Source } from '@/services/api';
import './chrome.css';

/* ------------------------------------------------------------------ */
/* Header — the spine of the document                                  */
/* ------------------------------------------------------------------ */

export function Header({
  theme,
  onToggleTheme,
  source,
  reportable,
  auditHead,
}: {
  theme: 'paper' | 'night';
  onToggleTheme: () => void;
  source: Source | null;
  reportable: boolean;
  auditHead?: string;
}) {
  return (
    <header className="ax-header">
      <div className="ax-header__mark">
        <span className="eyebrow">Razorpay AI Buildathon · Track 3</span>
        <h1>
          AXIOM <span className="ax-header__thin">Recover</span>
        </h1>
        <p className="ax-header__sub">
          Recovers at-risk revenue, then proves the number with the ledger that
          audits it.
        </p>
      </div>

      <div className="ax-header__meta">
        <SourceBadge source={source} />
        <ReportableBadge reportable={reportable} />
        {auditHead && (
          <span className="ax-chip ax-chip--quiet figure" title="sha256 head of the audit chain. Same seed produces the same hash.">
            chain {auditHead.slice(0, 10)}
          </span>
        )}
        <button
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === 'paper' ? 'night' : 'day'} ledger`}
        >
          {theme === 'paper' ? 'Night ledger' : 'Day ledger'}
        </button>
      </div>
    </header>
  );
}

/**
 * States plainly whether the figures on screen came from a live backend run
 * or the bundled fixture batch. Showing fixture numbers without saying so is
 * exactly the failure this project's citation discipline exists to prevent.
 */
function SourceBadge({ source }: { source: Source | null }) {
  if (source === null) return <span className="ax-chip ax-chip--quiet">connecting…</span>;
  if (source === 'live') return <span className="ax-chip ax-chip--tie">live run</span>;
  return (
    <span
      className="ax-chip ax-chip--owed"
      title="The API on :3000 is not reachable, so these are the bundled fixture figures. Start the backend to see a live run."
    >
      fixture data
    </span>
  );
}

function ReportableBadge({ reportable }: { reportable: boolean }) {
  return reportable ? (
    <span className="ax-chip ax-chip--tie" title="Every base rate carries a source.">
      cited
    </span>
  ) : (
    <span className="ax-chip ax-chip--break" title="Some base rates are still uncited — this run is not reportable.">
      uncited
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export type TabId = 'ledger' | 'recovery' | 'gates' | 'metrics' | 'audit';

const TABS: { id: TabId; label: string; note: string }[] = [
  { id: 'ledger',   label: 'Ledger',   note: 'What settled vs. what should have' },
  { id: 'recovery', label: 'Recovery', note: 'Propose, gate, execute, reconcile' },
  { id: 'gates',    label: 'Gates',    note: 'The money firewall, hands-on' },
  { id: 'metrics',  label: 'Evidence', note: 'Three arms, and how stable each claim is' },
  { id: 'audit',    label: 'Audit',    note: 'Hash-chained record of every decision' },
];

export function Tabs({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  return (
    <nav className="ax-tabs" role="tablist" aria-label="Console sections">
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={`ax-tab ${active === t.id ? 'is-active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          <span className="ax-tab__label">{t.label}</span>
          <span className="ax-tab__note">{t.note}</span>
        </button>
      ))}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */

export function Loading({ what }: { what: string }) {
  return (
    <div className="ax-state" role="status">
      <span className="eyebrow">Reading</span>
      <p>{what}</p>
    </div>
  );
}

/** An empty screen is an invitation to act, not a shrug. */
export function Empty({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="ax-state">
      <p>{title}</p>
      {action}
    </div>
  );
}

export function Section({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section className="ax-section">
      <div className="ax-section__head">
        <h2>{title}</h2>
        {lede && <p className="ax-section__lede">{lede}</p>}
      </div>
      {children}
    </section>
  );
}
