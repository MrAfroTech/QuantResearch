import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePremarketPartialLockTrail, shouldRaisePartialLockBrokerStop, resolvePremarketPartialLockStopFillReason } from './premarketPartialLockTrail.js';
import {
  PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
  PREMARKET_PARTIAL_LOCK_CLOSE_REASON,
  PREMARKET_HARD_STOP_TRIGGER,
} from './premarketConfig.js';

describe('Premarket profit trail', () => {
  it('activation floor default is +3% (tunable)', () => {
    assert.equal(PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE, 0.03);
  });

  it('does not fire below activation MFE', () => {
    const d = evaluatePremarketPartialLockTrail({
      pnlFrac: 0.02,
      mfeFrac: 0.025,
      exitPhase: 'LADDER:0',
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.inactiveReason, 'below_activation');
  });

  it('fires close_all after peak lifts off a 5% rung and PnL is back at the floor', () => {
    const d = evaluatePremarketPartialLockTrail({
      pnlFrac: 0.04,
      mfeFrac: 0.08,
      exitPhase: 'LADDER:0',
    });
    assert.equal(d.action, 'close_all');
    assert.equal(d.reason, PREMARKET_PARTIAL_LOCK_CLOSE_REASON);
    assert.equal(d.peakMfe, 0.08);
    assert.equal(d.trailFloor, 0.05);
  });

  it('holds when still above the last printed increment', () => {
    const d = evaluatePremarketPartialLockTrail({
      pnlFrac: 0.07,
      mfeFrac: 0.08,
      exitPhase: 'LADDER:0',
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.trailFloor, 0.05);
  });

  it('uses current pnl as peak when it exceeds stored mfe', () => {
    const d = evaluatePremarketPartialLockTrail({
      pnlFrac: 0.09,
      mfeFrac: 0.05,
      exitPhase: null,
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.peakMfe, 0.09);
    assert.equal(d.trailFloor, 0.05);
  });

  it('keeps trailing after the old +20% ladder milestone', () => {
    const d = evaluatePremarketPartialLockTrail({
      pnlFrac: 0.22,
      mfeFrac: 0.22,
      exitPhase: 'LADDER:1',
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.trailFloor, 0.2);
  });

  it('refuses close when past hard stop so hard_stop owns the exit', () => {
    const d = evaluatePremarketPartialLockTrail({
      pnlFrac: -0.222,
      mfeFrac: 0.037,
      exitPhase: 'LADDER:0',
      hardStopPct: PREMARKET_HARD_STOP_TRIGGER,
    });
    assert.equal(d.action, 'hold');
    assert.equal(d.inactiveReason, 'hard_stop_owns_exit');
  });

  it('still fires give-back to the last increment when above hard stop', () => {
    const d = evaluatePremarketPartialLockTrail({
      pnlFrac: 0.05,
      mfeFrac: 0.193,
      exitPhase: 'LADDER:0',
      hardStopPct: PREMARKET_HARD_STOP_TRIGGER,
    });
    assert.equal(d.action, 'close_all');
    assert.equal(d.reason, PREMARKET_PARTIAL_LOCK_CLOSE_REASON);
    assert.equal(d.trailFloor, 0.15);
  });
});

describe('shouldRaisePartialLockBrokerStop', () => {
  const position = {
    entry_premium: 0.615,
    broker_stop_order_id: 'abc',
    broker_stop_trigger_price: 0.6,
    broker_stop_pnl_frac: -0.01,
  };

  it('raises from the 1% loss stop to peak/2 (IWM-62 shape)', () => {
    const check = shouldRaisePartialLockBrokerStop(position, 0.065040650406504);
    assert.equal(check.raise, true);
    assert.equal(check.currentTrigger, 0.6);
    assert.equal(check.desiredTrigger, 0.65);
  });

  it('does not lower or churn when trigger is already at the floor', () => {
    const check = shouldRaisePartialLockBrokerStop(
      { ...position, broker_stop_trigger_price: 0.65 },
      0.065040650406504
    );
    assert.equal(check.raise, false);
  });

  it('places a stop when none is resting yet', () => {
    const check = shouldRaisePartialLockBrokerStop(
      { entry_premium: 0.615, broker_stop_order_id: null },
      0.065
    );
    assert.equal(check.raise, true);
    assert.equal(check.desiredTrigger, 0.65);
  });

  it('raises again when a new MFE high lifts the floor a penny', () => {
    const check = shouldRaisePartialLockBrokerStop(
      { ...position, broker_stop_trigger_price: 0.65 },
      0.09
    );
    assert.equal(check.raise, true);
    assert.equal(check.desiredTrigger, 0.67);
  });

  it('ratchets after the first +3% lock when a later poll prints a higher peak (IWM #82 shape)', () => {
    const locked = {
      entry_premium: 1.65,
      broker_stop_order_id: '506713521',
      broker_stop_trigger_price: 1.73,
      broker_stop_pnl_frac: 0.046620046620046665,
    };
    const first = evaluatePremarketPartialLockTrail({
      pnlFrac: 0.06060606060606066,
      mfeFrac: 0.06060606060606066,
      exitPhase: 'LADDER:0',
    });
    assert.equal(first.action, 'hold');
    assert.equal(first.trailFloor, 0.05);
    assert.equal(
      shouldRaisePartialLockBrokerStop(
        { ...locked, broker_stop_trigger_price: 1.63, broker_stop_pnl_frac: -0.01 },
        first.trailFloor
      ).desiredTrigger,
      1.73
    );

    const second = evaluatePremarketPartialLockTrail({
      pnlFrac: 0.1,
      mfeFrac: 0.1,
      exitPhase: 'LADDER:0',
    });
    assert.equal(second.action, 'hold');
    assert.equal(second.trailFloor, 0.1);
    const check = shouldRaisePartialLockBrokerStop(locked, second.trailFloor);
    assert.equal(check.raise, true);
    assert.equal(check.desiredTrigger, 1.82);
  });
});

describe('resolvePremarketPartialLockStopFillReason', () => {
  it('keeps hard_stop even if the resting stop was the trail floor', () => {
    const reason = resolvePremarketPartialLockStopFillReason({
      position: { exit_phase: 'LADDER:0', broker_stop_pnl_frac: 0.065 },
      defaultReason: 'hard_stop',
    });
    assert.equal(reason, 'hard_stop');
  });

  it('labels pre-milestone positive-floor fills as partial_lock_trail', () => {
    const reason = resolvePremarketPartialLockStopFillReason({
      position: { exit_phase: 'LADDER:0', broker_stop_pnl_frac: 0.065 },
      defaultReason: 'stop_loss',
    });
    assert.equal(reason, PREMARKET_PARTIAL_LOCK_CLOSE_REASON);
  });

  it('labels a positive trail-floor fill as partial_lock_trail past +20%', () => {
    const reason = resolvePremarketPartialLockStopFillReason({
      position: { exit_phase: 'LADDER:1', broker_stop_pnl_frac: 0.2 },
      defaultReason: 'trailing_stop',
    });
    assert.equal(reason, PREMARKET_PARTIAL_LOCK_CLOSE_REASON);
  });
});
