import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEmaVwapPartialLockTrail,
  shouldRaiseEmaVwapPartialLockBrokerStop,
  resolveEmaVwapPartialLockStopFillReason,
} from './emaVwapPartialLockTrail.js';
import {
  EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE,
  EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON,
  EMA_VWAP_HARD_STOP_PCT,
} from './emaVwapConfig.js';

describe('EMA/VWAP profit trail', () => {
  it('activation floor default is +3% (tunable)', () => {
    assert.equal(EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE, 0.03);
  });

  it('does not fire below activation MFE', () => {
    const d = evaluateEmaVwapPartialLockTrail({
      pnlFrac: 0.02,
      mfeFrac: 0.025,
      exitPhase: 'LADDER:0',
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.inactiveReason, 'below_activation');
  });

  it('fires close_all after peak lifts off a 5% rung and PnL is back at the floor', () => {
    const d = evaluateEmaVwapPartialLockTrail({
      pnlFrac: 0.04,
      mfeFrac: 0.08,
      exitPhase: 'LADDER:0',
    });
    assert.equal(d.action, 'close_all');
    assert.equal(d.reason, EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON);
    assert.equal(d.peakMfe, 0.08);
    assert.equal(d.trailFloor, 0.05);
  });

  it('holds when still above the last printed increment', () => {
    const d = evaluateEmaVwapPartialLockTrail({
      pnlFrac: 0.07,
      mfeFrac: 0.08,
      exitPhase: 'LADDER:0',
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.trailFloor, 0.05);
  });

  it('uses current pnl as peak when it exceeds stored mfe', () => {
    const d = evaluateEmaVwapPartialLockTrail({
      pnlFrac: 0.09,
      mfeFrac: 0.05,
      exitPhase: null,
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.peakMfe, 0.09);
    assert.equal(d.trailFloor, 0.05);
  });

  it('keeps trailing after the old +20% ladder milestone', () => {
    const d = evaluateEmaVwapPartialLockTrail({
      pnlFrac: 0.22,
      mfeFrac: 0.22,
      exitPhase: 'LADDER:1',
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.trailFloor, 0.2);
  });

  it('refuses close when past hard stop so hard_stop owns the exit', () => {
    const d = evaluateEmaVwapPartialLockTrail({
      pnlFrac: -0.222,
      mfeFrac: 0.037,
      exitPhase: 'LADDER:0',
      hardStopPct: EMA_VWAP_HARD_STOP_PCT,
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.inactiveReason, 'hard_stop_owns_exit');
  });

  it('still fires give-back to the last increment when above hard stop', () => {
    const d = evaluateEmaVwapPartialLockTrail({
      pnlFrac: 0.05,
      mfeFrac: 0.193,
      exitPhase: 'LADDER:0',
      hardStopPct: EMA_VWAP_HARD_STOP_PCT,
    });
    assert.equal(d.action, 'close_all');
    assert.equal(d.reason, EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON);
    assert.equal(d.trailFloor, 0.15);
  });
});

describe('shouldRaiseEmaVwapPartialLockBrokerStop', () => {
  const position = {
    entry_premium: 0.615,
    broker_stop_order_id: 'abc',
    broker_stop_trigger_price: 0.6,
    broker_stop_pnl_frac: -0.0175,
  };

  it('raises from the 1.75% loss stop to peak/2', () => {
    const check = shouldRaiseEmaVwapPartialLockBrokerStop(position, 0.065040650406504);
    assert.equal(check.raise, true);
    assert.equal(check.currentTrigger, 0.6);
    assert.equal(check.desiredTrigger, 0.65);
  });

  it('does not lower or churn when trigger is already at the floor', () => {
    const check = shouldRaiseEmaVwapPartialLockBrokerStop(
      { ...position, broker_stop_trigger_price: 0.65 },
      0.065040650406504
    );
    assert.equal(check.raise, false);
  });

  it('places a stop when none is resting yet', () => {
    const check = shouldRaiseEmaVwapPartialLockBrokerStop(
      { entry_premium: 0.615, broker_stop_order_id: null },
      0.065
    );
    assert.equal(check.raise, true);
    assert.equal(check.desiredTrigger, 0.65);
  });

  it('raises again when a new MFE high lifts the floor a penny', () => {
    const check = shouldRaiseEmaVwapPartialLockBrokerStop(
      { ...position, broker_stop_trigger_price: 0.65 },
      0.09
    );
    assert.equal(check.raise, true);
    assert.equal(check.desiredTrigger, 0.67);
  });
});

describe('resolveEmaVwapPartialLockStopFillReason', () => {
  it('keeps hard_stop even if the resting stop was the trail floor', () => {
    const reason = resolveEmaVwapPartialLockStopFillReason({
      position: { exit_phase: 'LADDER:0', broker_stop_pnl_frac: 0.065 },
      defaultReason: 'hard_stop',
    });
    assert.equal(reason, 'hard_stop');
  });

  it('labels pre-milestone positive-floor fills as partial_lock_trail', () => {
    const reason = resolveEmaVwapPartialLockStopFillReason({
      position: { exit_phase: 'LADDER:0', broker_stop_pnl_frac: 0.065 },
      defaultReason: 'stop_loss',
    });
    assert.equal(reason, EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON);
  });

  it('labels a positive trail-floor fill as partial_lock_trail past +20%', () => {
    const reason = resolveEmaVwapPartialLockStopFillReason({
      position: { exit_phase: 'LADDER:1', broker_stop_pnl_frac: 0.2 },
      defaultReason: 'trailing_stop',
    });
    assert.equal(reason, EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON);
  });
});
