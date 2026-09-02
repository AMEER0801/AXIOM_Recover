import { Suspense, lazy, useState } from 'react';
import { useTheme } from '@/hooks/useTheme';
import { useApi } from '@/hooks/useApi';
import { fetchLedger, fetchRecovery, fetchEval, fetchAudit, fetchProviders } from '@/services/api';
import { Sidebar, TopBar, Section, Loading, TAB_TITLES, type TabId } from '@/components/Common/Chrome';
import { LedgerTable } from '@/components/Ledger/LedgerTable';
import { RecoveryRibbon } from '@/components/Recovery/RecoveryRibbon';
import { GateSimulator } from '@/components/Gates/GateSimulator';
import { AuditChain } from '@/components/Audit/AuditChain';
import { LivePanel } from '@/components/LiveAI/LivePanel';

/**
 * Evidence is the only screen that needs a charting library (~150kB gzipped).
 * Loading it lazily means the Ledger — the screen a reviewer lands on — is
 * never waiting on a dependency it does not render.
 */
const Evidence = lazy(() =>
  import('@/components/Metrics/Evidence').then((m) => ({ default: m.Evidence })),
);

export default function App() {
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState<TabId>('ledger');

  const ledger = useApi(fetchLedger);
  const recovery = useApi(fetchRecovery);
  const evalSum = useApi(fetchEval);
  const audit = useApi(fetchAudit);
  const providers = useApi(fetchProviders);

  const head = TAB_TITLES[tab];

  return (
    <div className="ax-app">
      <Sidebar
        active={tab}
        onChange={setTab}
        theme={theme}
        onToggleTheme={toggle}
        providers={providers.data?.providers}
      />

      <div className="ax-body">
        <TopBar
          title={head.title}
          sub={head.sub}
          source={ledger.source}
          reportable={ledger.data?.summary.reportable ?? false}
          auditHead={recovery.data?.audit_head}
          mode={recovery.data?.mode}
        />

        <main className="ax-main">
          {tab === 'ledger' && (
            <Section
              title="What settled, against what should have"
              lede="A reconciliation is a document, not a dashboard: expected on the left, actual on the right, and the difference in the channel down the middle. Before flagging a gap, the engine tries to explain it — two of the problem classes here are not losses at all, and flagging them costs a person an afternoon confirming nothing was wrong."
            >
              {ledger.loading || !ledger.data
                ? <Loading what="the settlement batch" />
                : <LedgerTable rows={ledger.data.rows} summary={ledger.data.summary} />}
            </Section>
          )}

          {tab === 'recovery' && (
            <Section
              title="Propose, gate, execute, reconcile"
              lede="Each track is one record; each cell is one round. A gate blocking an action is the system working correctly, so it reads as deliberate intervention rather than an exception. Select any track to see the full eleven-gate trace behind every decision on it — including the gates that passed."
            >
              {recovery.loading || !recovery.data
                ? <Loading what="the recovery run" />
                : <RecoveryRibbon run={recovery.data} />}
            </Section>
          )}

          {tab === 'gates' && (
            <Section
              title="The money firewall, hands-on"
              lede="gates.js is the one place allowed to say whether a proposed action may run. Move anything below and watch all eleven re-evaluate. Each preset is engineered to trip exactly one gate — the same seven scenarios npm run gates:demo prints."
            >
              <GateSimulator />
            </Section>
          )}

          {tab === 'metrics' && (
            <Section
              title="What the numbers actually support"
              lede="A single 'the agent recovered ₹X' figure is unfalsifiable. Every claim here is a delta against a baseline that ran on the identical seeded population through the identical gates, reported net of what it cost to produce."
            >
              {recovery.loading || evalSum.loading || !recovery.data || !evalSum.data
                ? <Loading what="the twenty-seed sweep" />
                : (
                  <Suspense fallback={<Loading what="the comparison charts" />}>
                    <Evidence run={recovery.data} evalSummary={evalSum.data} />
                  </Suspense>
                )}
            </Section>
          )}

          {tab === 'liveai' && (
            <Section
              title="The agent thinks. The policy still decides."
              lede="One at-risk record goes to three judges in order: the deterministic policy proposes, the eleven gates decide what may actually run, and Groq — live, on your key — gives an independent second opinion constrained to the same closed vocabulary. Where they disagree, a human decides. That is the whole design."
            >
              {recovery.loading || !recovery.data
                ? <Loading what="the recovery run" />
                : <LivePanel run={recovery.data} providers={providers.data} />}
            </Section>
          )}

          {tab === 'audit' && (
            <Section
              title="Every decision, recorded before the action"
              lede="An audit log written after the fact records what a system decided it did. This one records what it decided to do, then separately what happened — so a crash between the two leaves evidence rather than a gap."
            >
              {audit.loading || !audit.data
                ? <Loading what="the audit chain" />
                : <AuditChain entries={audit.data.entries} verification={audit.data.verification} />}
            </Section>
          )}
        </main>
      </div>
    </div>
  );
}
