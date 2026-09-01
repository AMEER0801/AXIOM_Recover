import { describe, it, expect } from 'vitest';
import { simulateGates, firstBlock } from '@/services/gateSim';
import { GATE_ORDER } from '@/types/domain';
import type { GateProbe } from '@/services/api';

const base: GateProbe = {
  action: 'RETRY_CHARGE',
  amount_paise: 45000,
  attempts: 1,
  failure_reason: 'insufficient_funds',
  hour_ist: 14,
  minutes_since_last_attempt: 180,
  do_not_contact: false,
  kill_switch: false,
  spend_so_far_run_paise: 3700,
  spend_cap_run_paise: 500000,
  approval_ceiling_paise: 1000000,
};

describe('gate trace shape', () => {
  it('records ALL eleven gates on a clean pass, not just the failures', () => {
    const trace = simulateGates(base);
    expect(trace).toHaveLength(11);
    expect(trace.every((e) => !e.blocked)).toBe(true);
    // A trace that only records failures invites "were the others checked?"
    expect(trace.every((e) => e.detail.length > 0)).toBe(true);
  });

  it('always emits gates in the canonical order', () => {
    const trace = simulateGates({ ...base, kill_switch: true });
    expect(trace.map((e) => e.gate)).toEqual([...GATE_ORDER]);
  });
});

describe('kill switch', () => {
  it('blocks unconditionally with no exception carved out', () => {
    const trace = simulateGates({ ...base, kill_switch: true, action: 'NO_ACTION' });
    expect(trace[0].blocked).toBe(true);
    expect(firstBlock(trace)?.gate).toBe('kill_switch');
  });
});

describe('do-not-contact', () => {
  it('blocks a message', () => {
    const t = simulateGates({ ...base, do_not_contact: true, action: 'SEND_NUDGE_SMS' });
    expect(t.find((e) => e.gate === 'do_not_contact')?.blocked).toBe(true);
  });

  it('does NOT block a silent retry — the list governs contact, not charging', () => {
    const t = simulateGates({ ...base, do_not_contact: true, action: 'RETRY_CHARGE' });
    expect(t.find((e) => e.gate === 'do_not_contact')?.blocked).toBe(false);
  });
});

describe('the three mandate states are genuinely distinct', () => {
  it('blocks a charge against every suspended mandate at zero, as a rule', () => {
    for (const r of ['mandate_revoked', 'mandate_paused_by_customer', 'mandate_paused_by_business'] as const) {
      const t = simulateGates({ ...base, action: 'RETRY_CHARGE', failure_reason: r });
      expect(t.find((e) => e.gate === 'mandate_charge_block')?.blocked).toBe(true);
    }
  });

  it('lets a customer-paused mandate still be nudged — only they hold that switch', () => {
    const t = simulateGates({
      ...base, action: 'SEND_NUDGE_SMS',
      failure_reason: 'mandate_paused_by_customer', hour_ist: 14,
    });
    expect(t.find((e) => e.gate === 'business_paused_no_nudge')?.blocked).toBe(false);
    expect(firstBlock(t)).toBeNull();
  });

  it('refuses to nudge a business-paused mandate — the customer was never the blocker', () => {
    const t = simulateGates({
      ...base, action: 'SEND_NUDGE_WHATSAPP',
      failure_reason: 'mandate_paused_by_business',
    });
    expect(t.find((e) => e.gate === 'business_paused_no_nudge')?.blocked).toBe(true);
  });
});

describe('quiet hours', () => {
  it('blocks a message at 23:00 IST', () => {
    const t = simulateGates({ ...base, action: 'SEND_NUDGE_SMS', hour_ist: 23 });
    expect(t.find((e) => e.gate === 'quiet_hours')?.blocked).toBe(true);
  });

  it('allows a message inside the RBI-TRAI intersection', () => {
    const t = simulateGates({ ...base, action: 'SEND_NUDGE_SMS', hour_ist: 11 });
    expect(t.find((e) => e.gate === 'quiet_hours')?.blocked).toBe(false);
  });

  it('never blocks a silent retry on quiet hours — no message is sent', () => {
    const t = simulateGates({ ...base, action: 'RETRY_CHARGE', hour_ist: 3 });
    expect(t.find((e) => e.gate === 'quiet_hours')?.blocked).toBe(false);
  });
});

describe('allowlist', () => {
  it('coerces an action outside the vocabulary rather than guessing the nearest match', () => {
    const t = simulateGates({ ...base, action: 'TRANSFER_ALL_FUNDS' as any });
    expect(t.find((e) => e.gate === 'action_allowlist')?.blocked).toBe(true);
  });
});

describe('approval ceiling', () => {
  it('forces review on amount alone, regardless of what else passed', () => {
    const t = simulateGates({ ...base, amount_paise: 25000000 });
    expect(t.find((e) => e.gate === 'approval_ceiling')?.blocked).toBe(true);
  });
});
