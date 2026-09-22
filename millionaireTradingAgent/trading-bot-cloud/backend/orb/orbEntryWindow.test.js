import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ORB_ENTRY_WINDOW_START,
  ORB_ENTRY_WINDOW_END,
  ORB_MIN_ENTRY_PREMIUM,
  ORB_LIVE_PER_TRADE_CAP_FRAC,
  ORB_PARTIAL_LOCK_TRAIL_DIVISOR,
  ORB_MAX_ENTRY_CONTRACTS,
  ORB_ENTRY_SIZING,
  ORB_ENTRIES_ENABLED,
  OUTSIDE_ENTRY_WINDOW_REASON,
  DAILY_PROFIT_HALT_REASON,
} from './orbConfig.js';
import { ORB_PREMARKET_ENTRY_SIZING, ladderPositionSize } from '../ladder/ladderSizing.js';
import { EMA_VWAP_ENTRY_SIZING } from '../emaVwapCross/emaVwapConfig.js';
import { PREMARKET_ENTRY_SIZING, PREMARKET_MAX_ENTRY_CONTRACTS } from '../premarketBreakout/premarketConfig.js';
import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from '../ladder/ladderConfig.js';
import {
  PREMARKET_SESSION_START,
  PREMARKET_TIME_STOP,
  OUTSIDE_ENTRY_WINDOW_REASON as PM_OUTSIDE,
} from '../premarketBreakout/premarketConfig.js';
import { isWithinPremarketSession } from '../premarketBreakout/premarketRangeState.js';
import { minutesSinceMidnightEt } from './tradierTimesales.js';

const here = dirname(fileURLToPath(import.meta.url));

function withinOrbEntryWindow(date) {
  const mins = minutesSinceMidnightEt(date);
  const start = ORB_ENTRY_WINDOW_START.hour * 60 + ORB_ENTRY_WINDOW_START.minute;
  const end = ORB_ENTRY_WINDOW_END.hour * 60 + ORB_ENTRY_WINDOW_END.minute;
  return mins >= start && mins < end;
}

describe('ORB production entry/sizing constants', () => {
  it('entry window is 9:30–11:00 ET exclusive end', () => {
    assert.deepEqual(ORB_ENTRY_WINDOW_START, { hour: 9, minute: 30 });
    assert.deepEqual(ORB_ENTRY_WINDOW_END, { hour: 11, minute: 0 });
    assert.equal(OUTSIDE_ENTRY_WINDOW_REASON, 'outside_entry_window');
    assert.equal(DAILY_PROFIT_HALT_REASON, 'daily_profit_halt');
  });

  it('ORB minutes helper matches 9:30 inclusive / 11:00 exclusive', () => {
    // Construct UTC instants that map to known ET wall times on a fixed weekday.
    // 2026-03-16 is a Monday; America/New_York is EDT (UTC-4).
    const at930 = new Date('2026-03-16T13:30:00.000Z'); // 9:30 ET
    const at1059 = new Date('2026-03-16T14:59:00.000Z'); // 10:59 ET
    const at1100 = new Date('2026-03-16T15:00:00.000Z'); // 11:00 ET
    const at929 = new Date('2026-03-16T13:29:00.000Z'); // 9:29 ET
    assert.equal(withinOrbEntryWindow(at930), true);
    assert.equal(withinOrbEntryWindow(at1059), true);
    assert.equal(withinOrbEntryWindow(at1100), false);
    assert.equal(withinOrbEntryWindow(at929), false);
  });

  it('min premium floor is $0.85 and live cap is 80%', () => {
    assert.equal(ORB_MIN_ENTRY_PREMIUM, 0.85);
    assert.equal(ORB_LIVE_PER_TRADE_CAP_FRAC, 0.8);
    assert.equal(ORB_PARTIAL_LOCK_TRAIL_DIVISOR, 1.3);
  });

  it('hard-caps ORB at 1 contract even when max-affordable would allow more', () => {
    assert.equal(ORB_MAX_ENTRY_CONTRACTS, 1);
    assert.equal(ORB_ENTRY_SIZING.maxContracts, 1);
    assert.equal(ORB_ENTRY_SIZING.feePerContract, OPTION_OPENING_COMMISSION_PER_CONTRACT);

    // $500 / $35 = 14 max-affordable; ORB must still size 1.
    const orb = ladderPositionSize(500, 0.34, ORB_ENTRY_SIZING);
    assert.equal(orb.affordable, true);
    assert.equal(orb.quantity, 1);
    assert.equal(orb.entryContracts, 1);
    assert.equal(orb.totalCost, 35);

    const premarket = ladderPositionSize(500, 0.34, PREMARKET_ENTRY_SIZING);
    assert.equal(PREMARKET_MAX_ENTRY_CONTRACTS, 1);
    assert.equal(PREMARKET_ENTRY_SIZING.maxContracts, 1);
    assert.equal(premarket.quantity, 1);

    const ema = ladderPositionSize(500, 0.34, EMA_VWAP_ENTRY_SIZING);
    assert.equal(ema.quantity, 1);
    assert.equal(EMA_VWAP_ENTRY_SIZING.maxContracts, 1);
    assert.equal(ORB_PREMARKET_ENTRY_SIZING.maxContracts, Infinity);
  });

  it('skips ORB when even 1 contract is unaffordable (cap does not force a fill)', () => {
    const sizing = ladderPositionSize(34, 0.34, ORB_ENTRY_SIZING);
    assert.equal(sizing.quantity, 0);
    assert.equal(sizing.affordable, false);
  });

  it('disables ORB live and paper entry attempts', () => {
    assert.equal(ORB_ENTRIES_ENABLED, false);
    const orbExec = readFileSync(join(here, 'orbExecutor.js'), 'utf8');
    assert.match(orbExec, /ORB_ENTRIES_ENABLED/);
    assert.match(orbExec, /ORB_ENTRIES_DISABLED_REASON/);
  });

  it('wires the 1-contract override in orb, premarket, and emaVwap executors', () => {
    const orbExec = readFileSync(join(here, 'orbExecutor.js'), 'utf8');
    const pmExec = readFileSync(join(here, '../premarketBreakout/premarketExecutor.js'), 'utf8');
    const emaExec = readFileSync(join(here, '../emaVwapCross/emaVwapExecutor.js'), 'utf8');

    assert.match(orbExec, /ORB_ENTRY_SIZING/);
    assert.doesNotMatch(orbExec, /ORB_PREMARKET_ENTRY_SIZING/);
    assert.match(pmExec, /PREMARKET_ENTRY_SIZING/);
    assert.doesNotMatch(pmExec, /ORB_PREMARKET_ENTRY_SIZING/);
    assert.doesNotMatch(pmExec, /ORB_ENTRY_SIZING/);
    assert.match(emaExec, /EMA_VWAP_ENTRY_SIZING/);
    assert.doesNotMatch(emaExec, /ORB_ENTRY_SIZING/);
  });
});

describe('Premarket session entry boundary', () => {
  it('has no noon start gate — entries from open through 3:05 PM ET stop', () => {
    assert.deepEqual(PREMARKET_SESSION_START, { hour: 9, minute: 30 });
    assert.deepEqual(PREMARKET_TIME_STOP, { hour: 15, minute: 5 });
    assert.equal(PM_OUTSIDE, 'outside_entry_window');

    // 2026-03-16 Monday EDT (UTC-4)
    const at930 = new Date('2026-03-16T13:30:00.000Z'); // 9:30 ET — allowed
    const at1059 = new Date('2026-03-16T14:59:00.000Z'); // 10:59 ET — allowed (was blocked by noon gate)
    const at1200 = new Date('2026-03-16T16:00:00.000Z'); // 12:00 ET — allowed
    const at1504 = new Date('2026-03-16T19:04:00.000Z'); // 3:04 ET — allowed
    const at1505 = new Date('2026-03-16T19:05:00.000Z'); // 3:05 ET — time-stop
    const at929 = new Date('2026-03-16T13:29:00.000Z'); // 9:29 ET — before open

    assert.equal(isWithinPremarketSession(at930), true);
    assert.equal(isWithinPremarketSession(at1059), true);
    assert.equal(isWithinPremarketSession(at1200), true);
    assert.equal(isWithinPremarketSession(at1504), true);
    assert.equal(isWithinPremarketSession(at1505), false);
    assert.equal(isWithinPremarketSession(at929), false);
  });
});
