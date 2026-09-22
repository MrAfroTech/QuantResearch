import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR0_ENTRY_POLICY,
  CONTROL_ENTRY_POLICY,
  ENTRY_POLICY_ASSIGNED_REASON,
  assignEntryPolicy,
  buildPolicyAssignedEvent,
  isBar0Policy,
  pickEntryPolicy,
  resolveEntryPolicy,
  setEntryPolicyAssigner,
} from './entryTimingPolicy.js';

afterEach(() => {
  setEntryPolicyAssigner(null);
});

describe('entryTimingPolicy', () => {
  it('defaults to control only, with no coin flip', () => {
    assert.equal(assignEntryPolicy(), CONTROL_ENTRY_POLICY);
    assert.equal(assignEntryPolicy(), CONTROL_ENTRY_POLICY);
  });

  it('maps 0 to control and 1 to bar0', () => {
    assert.equal(pickEntryPolicy(0), CONTROL_ENTRY_POLICY);
    assert.equal(pickEntryPolicy(1), BAR0_ENTRY_POLICY);
    assert.equal(pickEntryPolicy('1'), BAR0_ENTRY_POLICY);
    assert.equal(pickEntryPolicy(2), CONTROL_ENTRY_POLICY);
  });

  it('treats missing/legacy policy as control', () => {
    assert.equal(resolveEntryPolicy(null), CONTROL_ENTRY_POLICY);
    assert.equal(resolveEntryPolicy(undefined), CONTROL_ENTRY_POLICY);
    assert.equal(resolveEntryPolicy('control'), CONTROL_ENTRY_POLICY);
    assert.equal(resolveEntryPolicy('bar0'), BAR0_ENTRY_POLICY);
    assert.equal(isBar0Policy(null), false);
    assert.equal(isBar0Policy('bar0'), true);
  });

  it('uses the test assigner hook', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    assert.equal(assignEntryPolicy(), BAR0_ENTRY_POLICY);
    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    assert.equal(assignEntryPolicy(), CONTROL_ENTRY_POLICY);
  });

  it('builds a queryable assignment event', () => {
    const event = buildPolicyAssignedEvent({
      strategy: 'orb',
      symbol: 'SPY',
      tradeDate: '2026-09-01',
      direction: 'CALL',
      breakoutLevel: 600.12,
      breakoutBarTime: '2026-09-01T10:00:00',
      policy: 'bar0',
      bar: { time: '2026-09-01T10:00:00', close: 600.2 },
    });
    assert.equal(event.type, ENTRY_POLICY_ASSIGNED_REASON);
    assert.equal(event.strategy, 'orb');
    assert.equal(event.symbol, 'SPY');
    assert.equal(event.tradeDate, '2026-09-01');
    assert.equal(event.direction, 'CALL');
    assert.equal(event.breakout_level, 600.12);
    assert.equal(event.breakout_bar_time, '2026-09-01T10:00:00');
    assert.equal(event.entry_policy, 'bar0');
  });

  it('coerces unknown policy values to control on the assignment event', () => {
    const event = buildPolicyAssignedEvent({
      strategy: 'premarket',
      symbol: 'QQQ',
      direction: 'PUT',
      policy: 'experimental',
    });
    assert.equal(event.entry_policy, CONTROL_ENTRY_POLICY);
  });
});
