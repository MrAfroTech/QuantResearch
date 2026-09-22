import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateOrbSignals } from '../orb/orbSignalEngine.js';
import { evaluatePremarketSignals } from '../premarketBreakout/premarketSignalEngine.js';
import { evaluateEmaVwapSignals } from '../emaVwapCross/emaVwapSignalEngine.js';
import {
  BAR0_ENTRY_POLICY,
  CONTROL_ENTRY_POLICY,
  ENTRY_POLICY_ASSIGNED_REASON,
  setEntryPolicyAssigner,
} from './entryTimingPolicy.js';
import {
  MAX_CONFIRM_RANGE_PCT,
  MAX_CONFIRM_OVERSHOOT_PCT,
  MAX_CONFIRM_VOLUME,
  CONFIRMATION_TOO_EXPLOSIVE_REASON,
  GATE_REMOVED_ENTRY_REASON,
} from './confirmationBarQuality.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..');

afterEach(() => {
  setEntryPolicyAssigner(null);
});

function quietCallBar(time, close = 100.04) {
  return {
    time,
    open: 100.02,
    high: close + 0.01,
    low: 100.0,
    close,
    volume: 50_000,
  };
}

function explosiveCallBar(time) {
  return {
    time,
    open: 100.2,
    high: 101.8,
    low: 100.0,
    close: 101.4,
    volume: 50_000,
  };
}

function quietPutBar(time, close = 98.96) {
  return {
    time,
    open: 98.98,
    high: 99.0,
    low: close - 0.01,
    close,
    volume: 50_000,
  };
}

function orbState(fsm = {}) {
  return {
    rangeComplete: true,
    orHigh: 100,
    orLow: 99,
    symbol: 'SPY',
    tradeDate: '2026-09-01',
    fsm: {
      phase: 'watching',
      direction: null,
      breakout_level: null,
      breakout_candle: null,
      breakout_bar_time: null,
      entry_policy: null,
      ...fsm,
    },
  };
}

function pmState(fsm = {}) {
  return {
    rangeComplete: true,
    pmHigh: 100,
    pmLow: 99,
    symbol: 'QQQ',
    tradeDate: '2026-09-01',
    fsm: {
      phase: 'watching',
      direction: null,
      breakout_level: null,
      breakout_candle: null,
      breakout_bar_time: null,
      entry_policy: null,
      ...fsm,
    },
  };
}

function assignedEvents(events) {
  return events.filter((e) => e.type === ENTRY_POLICY_ASSIGNED_REASON);
}

describe('ORB bar-0 vs control entry timing', () => {
  it('control does not enter on the breakout bar; quiet next bar enters', () => {
    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    const breakout = quietCallBar('2026-09-01T10:00:00');
    const hold = quietCallBar('2026-09-01T10:05:00', 100.03);

    const mid = evaluateOrbSignals(orbState(), [breakout]);
    assert.equal(mid.entries.length, 0);
    assert.equal(mid.rangeState.fsm.phase, 'awaiting_confirmation');
    assert.equal(mid.rangeState.fsm.entry_policy, 'control');
    assert.equal(assignedEvents(mid.events).length, 1);
    assert.equal(assignedEvents(mid.events)[0].entry_policy, 'control');
    assert.equal(assignedEvents(mid.events)[0].symbol, 'SPY');
    assert.equal(assignedEvents(mid.events)[0].tradeDate, '2026-09-01');
    assert.equal(assignedEvents(mid.events)[0].breakout_bar_time, breakout.time);

    const done = evaluateOrbSignals(mid.rangeState, [hold]);
    assert.equal(done.entries.length, 1);
    assert.equal(done.entries[0].entry_policy, 'control');
    assert.equal(done.entries[0].confirmation_bar.time, hold.time);
    assert.equal(done.rangeState.fsm.phase, 'watching');
  });

  it('bar0 enters on a quiet breakout bar', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const breakout = quietCallBar('2026-09-01T10:00:00');
    const result = evaluateOrbSignals(orbState(), [breakout]);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].entry_policy, 'bar0');
    assert.equal(result.entries[0].confirmation_bar.time, breakout.time);
    assert.equal(result.rangeState.fsm.phase, 'watching');
    assert.deepEqual(result.rangeState.fsm.spent_levels, []);
    assert.deepEqual(result.rangeState.fsm.repeat_blocks, ['CALL:100']);
    assert.equal(assignedEvents(result.events)[0].entry_policy, 'bar0');
  });

  it('bar0 explosive breakout now enters and is tagged gate_removed_entry', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const breakout = explosiveCallBar('2026-09-01T10:00:00');
    const result = evaluateOrbSignals(orbState(), [breakout]);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].gate_removed_entry, true);
    assert.equal(result.entries[0].would_have_rejected_reason, CONFIRMATION_TOO_EXPLOSIVE_REASON);
    assert.equal(result.rangeState.fsm.phase, 'watching');
    assert.deepEqual(result.rangeState.fsm.spent_levels, []);
    assert.deepEqual(result.rangeState.fsm.repeat_blocks, ['CALL:100']);
    assert.ok(result.events.some((e) => e.type === GATE_REMOVED_ENTRY_REASON));
    assert.ok(!result.events.some((e) => e.type === CONFIRMATION_TOO_EXPLOSIVE_REASON));
  });

  it('control explosive hold now enters and is tagged gate_removed_entry', () => {
    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    const breakout = quietCallBar('2026-09-01T10:00:00');
    const hold = explosiveCallBar('2026-09-01T10:05:00');
    const result = evaluateOrbSignals(orbState(), [breakout, hold]);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].gate_removed_entry, true);
    assert.equal(result.entries[0].confirmation_bar.time, hold.time);
    assert.ok(result.events.some((e) => e.type === GATE_REMOVED_ENTRY_REASON));
  });

  it('quiet control confirm is not tagged gate_removed_entry', () => {
    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    const result = evaluateOrbSignals(orbState(), [
      quietCallBar('2026-09-01T10:00:00'),
      quietCallBar('2026-09-01T10:05:00', 100.03),
    ]);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].gate_removed_entry, false);
    assert.equal(result.entries[0].would_have_rejected_reason, null);
  });

  it('control still invalidates on a wrong-side close', () => {
    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    const breakout = quietCallBar('2026-09-01T10:00:00');
    const fail = {
      time: '2026-09-01T10:05:00',
      open: 100.0,
      high: 100.02,
      low: 99.8,
      close: 99.9,
      volume: 50_000,
    };
    const result = evaluateOrbSignals(orbState(), [breakout, fail]);
    assert.equal(result.entries.length, 0);
    assert.equal(result.rangeState.fsm.phase, 'watching');
    assert.ok(result.events.some((e) => e.type === 'breakout_invalidated'));
  });

  it('legacy awaiting FSM without a policy field keeps control timing', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const hold = quietCallBar('2026-09-01T10:05:00', 100.03);
    const result = evaluateOrbSignals(
      orbState({
        phase: 'awaiting_confirmation',
        direction: 'CALL',
        breakout_level: 100,
        breakout_candle: quietCallBar('2026-09-01T10:00:00'),
        breakout_bar_time: '2026-09-01T10:00:00',
        entry_policy: null,
      }),
      [hold]
    );
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].entry_policy, 'control');
  });

  it('bar0 does not re-signal the same IWM PUT level on later bars (today\'s $292.84 loop)', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const iwm = {
      rangeComplete: true,
      orHigh: 294.155,
      orLow: 292.84,
      symbol: 'IWM',
      tradeDate: '2026-09-09',
      fsm: {
        phase: 'watching',
        direction: null,
        breakout_level: null,
        breakout_candle: null,
        breakout_bar_time: null,
        entry_policy: null,
      },
    };
    const first = {
      time: '2026-09-09T09:55:00',
      open: 293.05,
      high: 293.115,
      low: 292.76,
      close: 292.79,
      volume: 205_180,
    };
    const later = {
      time: '2026-09-09T10:05:00',
      open: 293.19,
      high: 293.28,
      low: 292.795,
      close: 292.83,
      volume: 139_129,
    };

    const opened = evaluateOrbSignals(iwm, [first]);
    assert.equal(opened.entries.length, 1);
    assert.equal(opened.entries[0].breakout_level, 292.84);
    assert.equal(opened.rangeState.fsm.phase, 'watching');
    assert.equal(opened.rangeState.fsm.breakout_level, null);
    assert.deepEqual(opened.rangeState.fsm.spent_levels, []);
    assert.deepEqual(opened.rangeState.fsm.repeat_blocks, ['PUT:292.84']);
    assert.equal(assignedEvents(opened.events).length, 1);

    const replay = evaluateOrbSignals(opened.rangeState, [later]);
    assert.equal(replay.entries.length, 0);
    assert.equal(assignedEvents(replay.events).length, 0);
    assert.ok(!replay.events.some((e) => e.type === GATE_REMOVED_ENTRY_REASON));
    assert.deepEqual(replay.rangeState.fsm.spent_levels, []);
    assert.deepEqual(replay.rangeState.fsm.repeat_blocks, ['PUT:292.84']);
    assert.equal(replay.rangeState.fsm.phase, 'watching');
  });

  it('already-spent ORB PUT level stays silent when still below the level', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const later = {
      time: '2026-09-09T13:10:00',
      open: 292.5,
      high: 292.7,
      low: 292.2,
      close: 292.4,
      volume: 80_000,
    };
    const result = evaluateOrbSignals(
      {
        rangeComplete: true,
        orHigh: 294.155,
        orLow: 292.84,
        symbol: 'IWM',
        tradeDate: '2026-09-09',
        fsm: {
          phase: 'watching',
          direction: null,
          breakout_level: null,
          breakout_candle: null,
          breakout_bar_time: null,
          entry_policy: null,
          spent_levels: ['PUT:292.84'],
        },
      },
      [later]
    );
    assert.equal(result.entries.length, 0);
    assert.equal(result.events.length, 0);
    assert.deepEqual(result.rangeState.fsm.spent_levels, ['PUT:292.84']);
  });
});

describe('Premarket bar-0 vs control entry timing', () => {
  it('control waits for a later quiet hold; bar0 enters on the breakout bar', () => {
    const breakout = quietCallBar('2026-09-01T09:35:00');
    const hold = quietCallBar('2026-09-01T09:40:00', 100.03);

    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    const control = evaluatePremarketSignals(pmState(), [breakout, hold]);
    assert.equal(control.entries.length, 1);
    assert.equal(control.entries[0].entry_policy, 'control');
    assert.equal(control.entries[0].confirmation_bar.time, hold.time);
    assert.equal(assignedEvents(control.events)[0].strategy, 'premarket');

    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const bar0 = evaluatePremarketSignals(pmState(), [breakout]);
    assert.equal(bar0.entries.length, 1);
    assert.equal(bar0.entries[0].entry_policy, 'bar0');
    assert.equal(bar0.entries[0].confirmation_bar.time, breakout.time);
  });

  it('bar0 PUT explosive breakout now enters and is tagged gate_removed_entry', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const breakout = {
      time: '2026-09-01T09:35:00',
      open: 98.8,
      high: 99.0,
      low: 97.2,
      close: 97.5,
      volume: 50_000,
    };
    const result = evaluatePremarketSignals(pmState(), [breakout]);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].gate_removed_entry, true);
    assert.equal(result.entries[0].direction, 'PUT');
    assert.ok(result.events.some((e) => e.type === GATE_REMOVED_ENTRY_REASON));
    assert.ok(!result.events.some((e) => e.type === CONFIRMATION_TOO_EXPLOSIVE_REASON));
  });

  it('bar0 does not re-signal the same Premarket PUT level on later bars (today\'s $292.62 loop)', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const iwm = {
      rangeComplete: true,
      pmHigh: 294.74,
      pmLow: 292.62,
      symbol: 'IWM',
      tradeDate: '2026-09-09',
      fsm: {
        phase: 'watching',
        direction: null,
        breakout_level: null,
        breakout_candle: null,
        breakout_bar_time: null,
        entry_policy: null,
      },
    };
    const first = {
      time: '2026-09-09T10:15:00',
      open: 292.75,
      high: 292.795,
      low: 292.07,
      close: 292.18,
      volume: 291_951,
    };
    const later = {
      time: '2026-09-09T10:20:00',
      open: 292.172,
      high: 292.28,
      low: 292.08,
      close: 292.10,
      volume: 270_368,
    };

    const opened = evaluatePremarketSignals(iwm, [first]);
    assert.equal(opened.entries.length, 1);
    assert.equal(opened.entries[0].breakout_level, 292.62);
    assert.deepEqual(opened.rangeState.fsm.spent_levels, []);
    assert.deepEqual(opened.rangeState.fsm.repeat_blocks, ['PUT:292.62']);
    assert.equal(assignedEvents(opened.events).length, 1);

    const replay = evaluatePremarketSignals(opened.rangeState, [later]);
    assert.equal(replay.entries.length, 0);
    assert.equal(assignedEvents(replay.events).length, 0);
    assert.ok(!replay.events.some((e) => e.type === GATE_REMOVED_ENTRY_REASON));
    assert.deepEqual(replay.rangeState.fsm.spent_levels, []);
    assert.deepEqual(replay.rangeState.fsm.repeat_blocks, ['PUT:292.62']);
  });

  it('already-spent Premarket PUT level stays silent when still below the level', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const later = {
      time: '2026-09-09T13:10:00',
      open: 292.4,
      high: 292.5,
      low: 292.1,
      close: 292.2,
      volume: 80_000,
    };
    const result = evaluatePremarketSignals(
      {
        rangeComplete: true,
        pmHigh: 294.74,
        pmLow: 292.62,
        symbol: 'IWM',
        tradeDate: '2026-09-09',
        fsm: {
          phase: 'watching',
          direction: null,
          breakout_level: null,
          breakout_candle: null,
          breakout_bar_time: null,
          entry_policy: null,
          spent_levels: ['PUT:292.62'],
        },
      },
      [later]
    );
    assert.equal(result.entries.length, 0);
    assert.equal(result.events.length, 0);
    assert.deepEqual(result.rangeState.fsm.spent_levels, ['PUT:292.62']);
  });
});

describe('ORB/Premarket suppression: repeat vs retest vs flash', () => {
  it('does not re-fire on consecutive still-beyond bars with no close outcome (0-fill / no-fill)', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const first = evaluateOrbSignals(orbState(), [quietCallBar('2026-09-01T10:00:00')]);
    assert.equal(first.entries.length, 1);
    assert.deepEqual(first.rangeState.fsm.repeat_blocks, ['CALL:100']);
    assert.deepEqual(first.rangeState.fsm.spent_levels, []);

    const again = evaluateOrbSignals(first.rangeState, [quietCallBar('2026-09-01T10:05:00', 100.05)]);
    assert.equal(again.entries.length, 0);
    assert.equal(assignedEvents(again.events).length, 0);
  });

  it('allows a genuine retest after price closes back through the level', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const opened = evaluateOrbSignals(orbState(), [quietCallBar('2026-09-01T10:00:00')]);
    const inside = evaluateOrbSignals(opened.rangeState, [
      {
        time: '2026-09-01T10:05:00',
        open: 100.02,
        high: 100.04,
        low: 99.9,
        close: 99.95,
        volume: 50_000,
      },
    ]);
    assert.equal(inside.entries.length, 0);
    assert.deepEqual(inside.rangeState.fsm.repeat_blocks, []);
    assert.deepEqual(inside.rangeState.fsm.spent_levels, []);

    const retest = evaluateOrbSignals(inside.rangeState, [quietCallBar('2026-09-01T10:10:00', 100.06)]);
    assert.equal(retest.entries.length, 1);
    assert.equal(retest.entries[0].direction, 'CALL');
    assert.deepEqual(retest.rangeState.fsm.repeat_blocks, ['CALL:100']);
  });

  it('pardons today\'s SPY CALL 1s flash stop and re-fires on the next beyond-level close', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const spy = {
      rangeComplete: true,
      orHigh: 758.74,
      orLow: 757.55,
      symbol: 'SPY',
      tradeDate: '2026-09-10',
      fsm: {
        phase: 'watching',
        direction: null,
        breakout_level: null,
        breakout_candle: null,
        breakout_bar_time: null,
        entry_policy: null,
      },
    };
    const bar1020 = {
      time: '2026-09-10T10:20:00',
      open: 758.02,
      high: 760.11,
      low: 757.95,
      close: 759.4,
      volume: 1_324_230,
    };
    const bar1025 = {
      time: '2026-09-10T10:25:00',
      open: 759.37,
      high: 759.875,
      low: 758.56,
      close: 758.71,
      volume: 1_036_346,
    };
    const bar1030 = {
      time: '2026-09-10T10:30:00',
      open: 758.715,
      high: 759.23,
      low: 758.645,
      close: 758.89,
      volume: 444_891,
    };
    const flash = {
      direction: 'CALL',
      breakout_level: 758.74,
      opened_at: '2026-09-10 14:25:21.750761+00',
      closed_at: '2026-09-10 14:25:22.753583+00',
      realized_pnl: -3,
    };

    const opened = evaluateOrbSignals(spy, [bar1020]);
    assert.equal(opened.entries.length, 1);
    assert.deepEqual(opened.rangeState.fsm.repeat_blocks, ['CALL:758.74']);

    const afterFlash = evaluateOrbSignals(opened.rangeState, [bar1025, bar1030], { closes: [flash] });
    assert.equal(afterFlash.entries.length, 1);
    assert.equal(afterFlash.entries[0].direction, 'CALL');
    assert.equal(afterFlash.entries[0].breakout_level, 758.74);
    assert.equal(afterFlash.entries[0].confirmation_bar.time, bar1030.time);
    assert.deepEqual(afterFlash.rangeState.fsm.spent_levels, []);
  });

  it('pardons today\'s IWM CALL 31s flash stop and re-fires while still above the OR high', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const iwm = {
      rangeComplete: true,
      orHigh: 288.8499,
      orLow: 287.67,
      symbol: 'IWM',
      tradeDate: '2026-09-10',
      fsm: {
        phase: 'watching',
        direction: null,
        breakout_level: null,
        breakout_candle: null,
        breakout_bar_time: null,
        entry_policy: null,
      },
    };
    const bar1020 = {
      time: '2026-09-10T10:20:00',
      open: 288.395,
      high: 289.735,
      low: 288.375,
      close: 289.545,
      volume: 658_586,
    };
    const bar1025 = {
      time: '2026-09-10T10:25:00',
      open: 289.5,
      high: 289.83,
      low: 289.21,
      close: 289.28,
      volume: 1_067_105,
    };
    const flash = {
      direction: 'CALL',
      breakout_level: 288.8499,
      opened_at: '2026-09-10 14:25:30.544069+00',
      closed_at: '2026-09-10 14:26:01.49654+00',
      realized_pnl: -2,
    };

    const opened = evaluateOrbSignals(iwm, [bar1020]);
    assert.equal(opened.entries.length, 1);
    assert.deepEqual(opened.rangeState.fsm.repeat_blocks, ['CALL:288.8499']);

    const again = evaluateOrbSignals(opened.rangeState, [bar1025], { closes: [flash] });
    assert.equal(again.entries.length, 1);
    assert.equal(again.entries[0].direction, 'CALL');
    assert.equal(again.entries[0].breakout_level, 288.8499);
    assert.deepEqual(again.rangeState.fsm.spent_levels, []);
  });

  it('keeps a genuine repeat silent after a meaningful-duration loss until a retest', () => {
    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const opened = evaluateOrbSignals(orbState(), [quietCallBar('2026-09-01T10:00:00')]);
    const stillAbove = evaluateOrbSignals(opened.rangeState, [quietCallBar('2026-09-01T10:05:00', 100.04)], {
      closes: [
        {
          direction: 'CALL',
          level: 100,
          holdMs: 90_000,
          realizedPnl: -15,
          closedAt: '2026-09-01T14:06:00Z',
        },
      ],
    });
    assert.equal(stillAbove.entries.length, 0);
    assert.equal(stillAbove.rangeState.fsm.spent_levels.includes('CALL:100'), true);

    const pulledBack = evaluateOrbSignals(stillAbove.rangeState, [
      {
        time: '2026-09-01T10:10:00',
        open: 100.02,
        high: 100.03,
        low: 99.8,
        close: 99.9,
        volume: 50_000,
      },
    ]);
    assert.deepEqual(pulledBack.rangeState.fsm.spent_levels, []);

    const retest = evaluateOrbSignals(pulledBack.rangeState, [quietCallBar('2026-09-01T10:15:00', 100.07)]);
    assert.equal(retest.entries.length, 1);
  });
});

function emaBar({ time, side, explosive = false, adx = 25 }) {
  const vwap = 100;
  const ema9 = side === 'above' ? 100.2 : 99.8;
  const ohlc = explosive
    ? { open: 100.2, high: 101.8, low: 99.9, close: 101.2, volume: 50_000 }
    : { open: 100.02, high: 100.06, low: 100.0, close: 100.04, volume: 50_000 };
  return {
    ...ohlc,
    time,
    vwap,
    ema9,
    adx,
    adx_ready: true,
    indicators_ready: true,
  };
}

describe('EMA/VWAP bar-0 vs control entry timing', () => {
  it('quiet cross enters on that bar for both arms', () => {
    const prior = emaBar({ time: '2026-09-01T11:00:00', side: 'below' });
    const cross = emaBar({ time: '2026-09-01T11:05:00', side: 'above' });

    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    const control = evaluateEmaVwapSignals('IWM', [prior, cross], { ema_side: 'below' });
    assert.equal(control.entries.length, 1);
    assert.equal(control.entries[0].entry_policy, 'control');
    assert.equal(control.entries[0].cross_candle.time, cross.time);

    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const bar0 = evaluateEmaVwapSignals('IWM', [prior, cross], { ema_side: 'below' });
    assert.equal(bar0.entries.length, 1);
    assert.equal(bar0.entries[0].entry_policy, 'bar0');
    assert.equal(bar0.entries[0].cross_candle.time, cross.time);
    assert.equal(assignedEvents(bar0.events)[0].strategy, 'emavwap');
  });

  it('explosive cross now enters on the cross bar and is tagged gate_removed_entry', () => {
    const prior = emaBar({ time: '2026-09-01T11:00:00', side: 'below' });
    const cross = emaBar({ time: '2026-09-01T11:05:00', side: 'above', explosive: true });
    const quiet = emaBar({ time: '2026-09-01T11:10:00', side: 'above' });

    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    const control = evaluateEmaVwapSignals('IWM', [prior, cross, quiet], { ema_side: 'below' });
    assert.equal(control.entries.length, 1);
    assert.equal(control.entries[0].entry_policy, 'control');
    assert.equal(control.entries[0].cross_candle.time, cross.time);
    assert.equal(control.entries[0].gate_removed_entry, true);
    assert.equal(control.entries[0].would_have_rejected_reason, CONFIRMATION_TOO_EXPLOSIVE_REASON);
    assert.ok(control.events.some((e) => e.type === GATE_REMOVED_ENTRY_REASON));
    assert.ok(!control.events.some((e) => e.type === CONFIRMATION_TOO_EXPLOSIVE_REASON));
    assert.equal(control.fsm.awaiting_quiet_confirm, null);

    setEntryPolicyAssigner(() => BAR0_ENTRY_POLICY);
    const bar0 = evaluateEmaVwapSignals('IWM', [prior, cross, quiet], { ema_side: 'below' });
    assert.equal(bar0.entries.length, 1);
    assert.equal(bar0.entries[0].entry_policy, 'bar0');
    assert.equal(bar0.entries[0].cross_candle.time, cross.time);
    assert.equal(bar0.entries[0].gate_removed_entry, true);
    assert.equal(bar0.fsm.awaiting_quiet_confirm, null);
    assert.ok(bar0.events.some((e) => e.type === GATE_REMOVED_ENTRY_REASON));
  });

  it('quiet EMA cross is not tagged gate_removed_entry', () => {
    const prior = emaBar({ time: '2026-09-01T11:00:00', side: 'below' });
    const cross = emaBar({ time: '2026-09-01T11:05:00', side: 'above' });
    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    const result = evaluateEmaVwapSignals('IWM', [prior, cross], { ema_side: 'below' });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].gate_removed_entry, false);
    assert.equal(result.entries[0].would_have_rejected_reason, null);
  });

  it('chop filter still rejects an explosive EMA cross', () => {
    const prior = emaBar({ time: '2026-09-01T11:00:00', side: 'below' });
    const cross = emaBar({ time: '2026-09-01T11:05:00', side: 'above', explosive: true, adx: 5 });
    setEntryPolicyAssigner(() => CONTROL_ENTRY_POLICY);
    const result = evaluateEmaVwapSignals('IWM', [prior, cross], { ema_side: 'below' });
    assert.equal(result.entries.length, 0);
    assert.ok(result.events.some((e) => e.type === 'chop_filter_rejected'));
  });
});

describe('production default is control (no coin flip)', () => {
  it('ORB waits for a confirming hold bar and stamps control', () => {
    const breakout = quietCallBar('2026-09-01T10:00:00');
    const hold = quietCallBar('2026-09-01T10:05:00', 100.03);
    const mid = evaluateOrbSignals(orbState(), [breakout]);
    assert.equal(mid.entries.length, 0);
    assert.equal(mid.rangeState.fsm.entry_policy, 'control');
    assert.equal(assignedEvents(mid.events)[0].entry_policy, 'control');
    const done = evaluateOrbSignals(mid.rangeState, [hold]);
    assert.equal(done.entries.length, 1);
    assert.equal(done.entries[0].entry_policy, 'control');
    assert.equal(done.entries[0].confirmation_bar.time, hold.time);
  });

  it('Premarket waits for a confirming hold bar and stamps control', () => {
    const breakout = quietCallBar('2026-09-01T09:35:00');
    const hold = quietCallBar('2026-09-01T09:40:00', 100.03);
    const result = evaluatePremarketSignals(pmState(), [breakout, hold]);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].entry_policy, 'control');
    assert.equal(result.entries[0].confirmation_bar.time, hold.time);
    assert.equal(assignedEvents(result.events)[0].entry_policy, 'control');
  });

  it('EMA/VWAP stamps control on the cross bar', () => {
    const prior = emaBar({ time: '2026-09-01T11:00:00', side: 'below' });
    const cross = emaBar({ time: '2026-09-01T11:05:00', side: 'above' });
    const result = evaluateEmaVwapSignals('IWM', [prior, cross], { ema_side: 'below' });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].entry_policy, 'control');
    assert.equal(assignedEvents(result.events)[0].entry_policy, 'control');
  });

  it('defaultAssign source is control-only and does not call randomInt', () => {
    const src = readFileSync(join(backendRoot, 'zeroDte/entryTimingPolicy.js'), 'utf8');
    assert.match(src, /function defaultAssign\(\) \{\s*return CONTROL_ENTRY_POLICY;/);
    assert.doesNotMatch(src, /randomInt/);
    assert.doesNotMatch(src, /function defaultAssign\(\) \{\s*return BAR0_ENTRY_POLICY;/);
  });
});

describe('A/B scope guards', () => {
  it('does not change confirmation-bar quality thresholds', () => {
    assert.equal(MAX_CONFIRM_RANGE_PCT, 0.0009);
    assert.equal(MAX_CONFIRM_OVERSHOOT_PCT, 0.0018);
    assert.equal(MAX_CONFIRM_VOLUME, 115_000);
  });

  it('executors stamp entry_policy on metadata and do not branch OTO/stop placement on the arm', () => {
    for (const rel of [
      'orb/orbExecutor.js',
      'premarketBreakout/premarketExecutor.js',
      'emaVwapCross/emaVwapExecutor.js',
    ]) {
      const src = readFileSync(join(backendRoot, rel), 'utf8');
      assert.match(src, /entry_policy:\s*entry\.entry_policy/);
      assert.match(src, /initialStop:\s*stopParams/);
      assert.doesNotMatch(src, /isBar0Policy/);
      assert.doesNotMatch(src, /BAR0_ENTRY_POLICY/);
      assert.doesNotMatch(src, /assignEntryPolicy/);
    }
  });

  it('ORB/Premarket/EMA no longer reject on quality.ok and all tag gate_removed_entry', () => {
    const orb = readFileSync(join(backendRoot, 'orb/orbSignalEngine.js'), 'utf8');
    const pm = readFileSync(join(backendRoot, 'premarketBreakout/premarketSignalEngine.js'), 'utf8');
    const ema = readFileSync(join(backendRoot, 'emaVwapCross/emaVwapSignalEngine.js'), 'utf8');
    assert.doesNotMatch(orb, /if\s*\(\s*!quality\.ok\s*\)/);
    assert.doesNotMatch(pm, /if\s*\(\s*!quality\.ok\s*\)/);
    assert.doesNotMatch(ema, /if\s*\(\s*!quality\.ok\s*\)/);
    assert.match(orb, /gate_removed_entry/);
    assert.match(pm, /gate_removed_entry/);
    assert.match(ema, /gate_removed_entry/);
  });

  it('does not introduce entry-policy branches into exits, stops, OTO, or strike selection', () => {
    const guarded = [
      'orb/orbPositionManager.js',
      'premarketBreakout/premarketPositionManager.js',
      'emaVwapCross/emaVwapPositionManager.js',
      'orb/orbStrikeSelector.js',
      'premarketBreakout/premarketStrikeSelector.js',
      'emaVwapCross/emaVwapStrikeSelector.js',
      'ladder/ladderExit.js',
      'ladder/ladderStopOrders.js',
      'ladder/otoEntryStop.js',
      'ladder/partialLockStopReplace.js',
      'zeroDte/confirmationBarQuality.js',
    ];
    for (const rel of guarded) {
      const src = readFileSync(join(backendRoot, rel), 'utf8');
      assert.doesNotMatch(
        src,
        /entry_policy|BAR0_ENTRY_POLICY|assignEntryPolicy/,
        `${rel} must not reference the A/B entry policy`
      );
    }
  });
});
