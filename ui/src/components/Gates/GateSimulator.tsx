import { useEffect, useMemo, useState } from 'react';
import type { FailureReason, GateTrace, Intervention } from '@/types/domain';
import { evaluateGates, type GateProbe } from '@/services/api';
import { simulateGates, firstBlock } from '@/services/gateSim';
import { rupees } from '@/services/format';
import { GateTraceList } from './GateTraceList';
import './gates.css';

/**
 * The gate simulator.
 *
 * This is the one screen built for a reviewer rather than an operator: move
 * a slider, watch all eleven gates re-evaluate, and see WHY an action is or
 * isn't allowed. It replaces a paragraph of README prose with something a
 * panel member can drive themselves in thirty seconds.
 *
 * Preset scenarios are the same seven `npm run gates:demo` prints — each one
 * engineered to trip exactly one gate.
 */

const INTERVENTIONS: Intervention[] = [
  'RETRY_CHARGE', 'SEND_PAYMENT_LINK', 'SEND_NUDGE_SMS',
  'SEND_NUDGE_WHATSAPP', 'VOICE_NUDGE_REGIONAL', 'ESCALATE_HUMAN',
  'WRITE_OFF', 'NO_ACTION',
];

const REASONS: FailureReason[] = [
  'insufficient_funds', 'card_expired', 'soft_decline', 'hard_decline',
  'network_timeout', 'mandate_revoked', 'mandate_paused_by_customer',
  'mandate_paused_by_business', 'checkout_abandoned', 'invoice_overdue',
];

const DEFAULT: GateProbe = {
  action: 'RETRY_CHARGE',
  amount_paise: 4_50_00,
  attempts: 1,
  failure_reason: 'insufficient_funds',
  hour_ist: 14,
  minutes_since_last_attempt: 180,
  do_not_contact: false,
  kill_switch: false,
  spend_so_far_run_paise: 3_700,
  spend_cap_run_paise: 50_00_00,
  approval_ceiling_paise: 100_00_00,
};

const PRESETS: { name: string; note: string; probe: Partial<GateProbe> }[] = [
  { name: 'Clean retry', note: 'Nothing blocks. All eleven still recorded.', probe: {} },
  { name: 'Kill switch', note: 'Everything stops, no exception carved out.', probe: { kill_switch: true } },
  { name: 'Do-not-contact', note: 'Blocks a message. Does NOT block a silent retry.', probe: { do_not_contact: true, action: 'SEND_NUDGE_SMS' } },
  { name: 'Dead mandate', note: 'No live authorisation exists. Zero, as a rule.', probe: { action: 'RETRY_CHARGE', failure_reason: 'mandate_revoked' } },
  { name: 'Business paused', note: 'Customer was never the blocker — messaging is pointless.', probe: { action: 'SEND_NUDGE_WHATSAPP', failure_reason: 'mandate_paused_by_business' } },
  { name: 'Quiet hours', note: '23:00 IST. Outside the RBI∩TRAI window.', probe: { action: 'SEND_NUDGE_SMS', hour_ist: 23 } },
  { name: 'Over ceiling', note: 'Amount alone forces human review.', probe: { amount_paise: 250_00_00 } },
  { name: 'Bad action', note: 'Outside the vocabulary — coerced, never guessed.', probe: { action: 'TRANSFER_ALL_FUNDS' as Intervention } },
];

export function GateSimulator() {
  const [probe, setProbe] = useState<GateProbe>(DEFAULT);
  const [trace, setTrace] = useState<GateTrace>(() => simulateGates(DEFAULT));
  const [evaluatedBy, setEvaluatedBy] = useState<'backend' | 'browser'>('browser');

  const local = useMemo(() => simulateGates(probe), [probe]);

  useEffect(() => {
    let cancelled = false;
    evaluateGates(probe, local).then((env) => {
      if (cancelled) return;
      setTrace(env.data);
      setEvaluatedBy(env.source === 'live' ? 'backend' : 'browser');
    });
    return () => { cancelled = true; };
  }, [probe, local]);

  const block = firstBlock(trace);
  const set = <K extends keyof GateProbe>(k: K, v: GateProbe[K]) =>
    setProbe((p) => ({ ...p, [k]: v }));

  return (
    <div className="ax-sim">
      <div className="ax-sim__presets">
        <span className="eyebrow">Scenarios</span>
        <div className="ax-sim__presetrow">
          {PRESETS.map((p) => (
            <button key={p.name} onClick={() => setProbe({ ...DEFAULT, ...p.probe })} title={p.note}>
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="ax-sim__body">
        <form className="ax-sim__controls sheet" onSubmit={(e) => e.preventDefault()}>
          <fieldset>
            <legend>Proposed action</legend>

            <label>
              Intervention
              <select value={probe.action} onChange={(e) => set('action', e.target.value as Intervention)}>
                {INTERVENTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                <option value="TRANSFER_ALL_FUNDS">TRANSFER_ALL_FUNDS (invalid)</option>
              </select>
            </label>

            <label>
              Failure reason
              <select value={probe.failure_reason} onChange={(e) => set('failure_reason', e.target.value as FailureReason)}>
                {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>

            <label>
              Amount <span className="figure ax-sim__value">{rupees(probe.amount_paise)}</span>
              <input
                type="range" min={10_00} max={300_00_00} step={10_00}
                value={probe.amount_paise}
                onChange={(e) => set('amount_paise', Number(e.target.value))}
              />
            </label>

            <label>
              Attempts already made <span className="figure ax-sim__value">{probe.attempts}</span>
              <input
                type="range" min={0} max={6} step={1}
                value={probe.attempts}
                onChange={(e) => set('attempts', Number(e.target.value))}
              />
            </label>

            <label>
              Hour (IST) <span className="figure ax-sim__value">{String(probe.hour_ist).padStart(2, '0')}:00</span>
              <input
                type="range" min={0} max={23} step={1}
                value={probe.hour_ist}
                onChange={(e) => set('hour_ist', Number(e.target.value))}
              />
            </label>

            <label>
              Minutes since last attempt <span className="figure ax-sim__value">{probe.minutes_since_last_attempt}</span>
              <input
                type="range" min={0} max={480} step={5}
                value={probe.minutes_since_last_attempt}
                onChange={(e) => set('minutes_since_last_attempt', Number(e.target.value))}
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Operator state</legend>
            <label className="ax-sim__check">
              <input type="checkbox" checked={probe.kill_switch} onChange={(e) => set('kill_switch', e.target.checked)} />
              Kill switch engaged
            </label>
            <label className="ax-sim__check">
              <input type="checkbox" checked={probe.do_not_contact} onChange={(e) => set('do_not_contact', e.target.checked)} />
              Customer on do-not-contact list
            </label>
            <label>
              Approval ceiling <span className="figure ax-sim__value">{rupees(probe.approval_ceiling_paise)}</span>
              <input
                type="range" min={10_00} max={200_00_00} step={50_00}
                value={probe.approval_ceiling_paise}
                onChange={(e) => set('approval_ceiling_paise', Number(e.target.value))}
              />
            </label>
          </fieldset>
        </form>

        <div className="ax-sim__result">
          <div className={`ax-verdict-card sheet ${block ? 'is-blocked' : 'is-allowed'}`}>
            <span className="eyebrow">
              Verdict · evaluated by {evaluatedBy === 'backend' ? 'gates.js' : 'browser mirror'}
            </span>
            <p className="ax-verdict-card__headline">
              {block ? 'Blocked' : 'Allowed'}
            </p>
            <p className="ax-verdict-card__why">
              {block
                ? <>First gate to block: <code>{block.gate}</code>. {block.detail}</>
                : 'Every gate had its say and none of them objected. The action may run.'}
            </p>
            {evaluatedBy === 'browser' && (
              <p className="ax-verdict-card__caveat">
                The backend isn't running, so this verdict came from the browser
                mirror of gates.js. It decides nothing real — start the API on
                :3000 to evaluate against the actual gate layer.
              </p>
            )}
          </div>

          <GateTraceList trace={trace} />
        </div>
      </div>
    </div>
  );
}
