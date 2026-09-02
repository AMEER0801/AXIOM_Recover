import type { ReactNode } from 'react';
import type { Source } from '@/services/api';
import './chrome.css';

/* ------------------------------------------------------------------ */
/* Icons — inline SVG, 1.6 stroke, no dependency                        */
/* ------------------------------------------------------------------ */

const ico = (d: string) => (size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const ICONS = {
  ledger:   ico('M3 5h18M3 10h18M3 15h12M3 20h8'),
  recovery: ico('M21 12a9 9 0 1 1-3-6.7M21 3v6h-6'),
  gates:    ico('M12 3l8 3v6c0 4.4-3.4 7.9-8 9-4.6-1.1-8-4.6-8-9V6l8-3zM9 12l2 2 4-4'),
  evidence: ico('M4 20V10M10 20V4M16 20v-8M22 20H2'),
  audit:    ico('M9 12l2 2 4-4m5 2a9 9 0 1 1-1.9-5.5L21 3M21 8v5h-5'),
  live:     ico('M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4L12 3zM19 15l.9 2.3 2.3.9-2.3.9L19 21l-.9-2.3-2.3-.9 2.3-.9L19 15z'),
  sun:      ico('M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'),
  moon:     ico('M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z'),
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, size }: { name: IconName; size?: number }) {
  return <>{ICONS[name](size)}</>;
}

/* ------------------------------------------------------------------ */
/* Shell — Razorpay-dashboard layout: navy sidebar + top bar            */
/* ------------------------------------------------------------------ */

export function Sidebar({
  active,
  onChange,
  theme,
  onToggleTheme,
  providers,
}: {
  active: TabId;
  onChange: (t: TabId) => void;
  theme: 'paper' | 'night';
  onToggleTheme: () => void;
  providers?: { razorpay: ProviderStatus; groq: ProviderStatus };
}) {
  return (
    <aside className="ax-sidebar">
      <div className="ax-sidebar__brand">
        <span className="ax-brand-mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M4 4h7l4 8 4-8h1" stroke="#528FF0" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 12h5l3 8" stroke="#00E5A0" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div>
          <div className="ax-brand-name">AXIOM <span className="ax-brand-thin">Recover</span></div>
          <div className="ax-brand-sub">Razorpay Buildathon · Track 3</div>
        </div>
      </div>

      <nav className="ax-nav" role="tablist" aria-label="Console sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={`ax-nav__item ${active === t.id ? 'is-active' : ''}`}
            onClick={() => onChange(t.id)}
          >
            <span className="ax-nav__icon"><Icon name={t.icon} /></span>
            <span className="ax-nav__text">
              <span className="ax-nav__label">{t.label}</span>
              <span className="ax-nav__note">{t.note}</span>
            </span>
          </button>
        ))}
      </nav>

      <div className="ax-sidebar__foot">
        {providers && (
          <div className="ax-providers" aria-label="Live provider status">
            <ProviderDot label="Razorpay" ok={providers.razorpay.configured} detail={providers.razorpay.detail} />
            <ProviderDot label="Groq LLM" ok={providers.groq.configured} detail={providers.groq.detail} />
          </div>
        )}
        <button className="ax-theme-toggle" onClick={onToggleTheme}
          aria-label={`Switch to ${theme === 'paper' ? 'night' : 'day'} console`}>
          {theme === 'paper' ? <><Icon name="moon" size={15} /> Night console</> : <><Icon name="sun" size={15} /> Day console</>}
        </button>
      </div>
    </aside>
  );
}

function ProviderDot({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className={`ax-provider ${ok ? 'is-on' : ''}`} title={detail}>
      <span className="ax-provider__dot" />
      <span className="ax-provider__label">{label}</span>
      <span className="ax-provider__state">{ok ? 'live' : 'off'}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Top bar — the document header plus its honesty badges                */
/* ------------------------------------------------------------------ */

export function TopBar({
  title,
  sub,
  source,
  reportable,
  auditHead,
  mode,
}: {
  title: string;
  sub: string;
  source: Source | null;
  reportable: boolean;
  auditHead?: string;
  mode?: string;
}) {
  return (
    <div className="ax-topbar">
      <div className="ax-topbar__title">
        <h1>{title}</h1>
        <p className="ax-topbar__sub">{sub}</p>
      </div>
      <div className="ax-topbar__meta">
        <SourceBadge source={source} />
        <ReportableBadge reportable={reportable} />
        {mode && (
          <span
            className="ax-chip ax-chip--owed figure"
            title={`${mode} — every figure in this console is simulated against the hash-frozen response model. Execution is dry-run. No live money moves.`}
          >
            SIMULATION
          </span>
        )}
        {auditHead && (
          <span className="ax-chip ax-chip--quiet figure" title="sha256 head of the audit chain. Same seed produces the same hash.">
            chain {auditHead.slice(0, 10)}
          </span>
        )}
      </div>
    </div>
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
    <span className="ax-chip ax-chip--tie" title="Every base rate carries a source.">cited</span>
  ) : (
    <span className="ax-chip ax-chip--break" title="Some base rates are still uncited — this run is not reportable.">uncited</span>
  );
}

export interface ProviderStatus { configured: boolean; detail?: string; }

/* ------------------------------------------------------------------ */
/* Tabs                                                                  */
/* ------------------------------------------------------------------ */

export type TabId = 'ledger' | 'recovery' | 'gates' | 'metrics' | 'liveai' | 'audit';

const TABS: { id: TabId; label: string; note: string; icon: IconName }[] = [
  { id: 'ledger',   label: 'Ledger',   note: 'Settlement reconciliation',   icon: 'ledger' },
  { id: 'recovery', label: 'Recovery', note: 'Policy execution runs',      icon: 'recovery' },
  { id: 'gates',    label: 'Gates',    note: 'The money firewall',         icon: 'gates' },
  { id: 'metrics',  label: 'Evidence', note: 'Multi-seed statistics',      icon: 'evidence' },
  { id: 'liveai',   label: 'Live AI',  note: 'Groq diagnosis + Test Mode', icon: 'live' },
  { id: 'audit',    label: 'Audit',    note: 'Hash-chained decisions',     icon: 'audit' },
];

export const TAB_TITLES: Record<TabId, { title: string; sub: string }> = {
  ledger:   { title: 'Ledger', sub: 'What settled, against what should have' },
  recovery: { title: 'Recovery', sub: 'Propose, gate, execute, reconcile' },
  gates:    { title: 'Gates', sub: 'The money firewall, hands-on' },
  metrics:  { title: 'Evidence', sub: 'Three arms, and how stable each claim is' },
  liveai:   { title: 'Live AI', sub: 'The agent thinks. The policy still decides.' },
  audit:    { title: 'Audit', sub: 'Hash-chained record of every decision' },
};

/* ------------------------------------------------------------------ */
/* States                                                                */
/* ------------------------------------------------------------------ */

export function Loading({ what }: { what: string }) {
  return (
    <div className="ax-state" role="status">
      <span className="ax-spinner" aria-hidden="true" />
      <p>Reading {what}</p>
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
