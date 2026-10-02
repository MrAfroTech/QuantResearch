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
  ORB_PARTIAL_LOCK_ACTIVATION_MFE,
  ORB_MAX_ENTRY_CONTRACTS,
  ORB_ENTRY_SIZING,
  ORB_ENTRIES_ENABLED,
  OUTSIDE_ENTRY_WINDOW_REASON,
  DAILY_PROFIT_HALT_REASON,
  ORB_SESSION_START,
  ORB_TIME_STOP,
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
import { isAtOrAfterTimeStop, isWithinOrbSession, minutesSinceMidnightEt } from './tradierTimesales.js';

const here = dirname(fileURLToPath(import.meta.url));

function withinOrbEntryWindow(date) {
  const mins = minutesSinceMidnightEt(date);
  const start = ORB_ENTRY_WINDOW_START.hour * 60 + ORB_ENTRY_WINDOW_START.minute;
  const end = ORB_ENTRY_WINDOW_END.hour * 60 + ORB_ENTRY_WINDOW_END.minute;
  return mins >= start && mins < end;
}

describe('ORB production entry/sizing constants', () => {
  it('entry window is 9:30 AM–3:05 PM ET exclusive end', () => {
    assert.deepEqual(ORB_ENTRY_WINDOW_START, { hour: 9, minute: 30 });
    assert.deepEqual(ORB_ENTRY_WINDOW_END, { hour: 15, minute: 5 });
    assert.deepEqual(ORB_SESSION_START, { hour: 9, minute: 30 });
    assert.deepEqual(ORB_TIME_STOP, { hour: 15, minute: 5 });
    assert.equal(OUTSIDE_ENTRY_WINDOW_REASON, 'outside_entry_window');
    assert.equal(DAILY_PROFIT_HALT_REASON, 'daily_profit_halt');
  });

  it('ORB session is 9:30:00 inclusive through 15:04:59 ET, cutoff at 15:05:00', () => {
    // 2026-03-16 is a Monday; America/New_York is EDT (UTC-4).
    const at92959 = new Date('2026-03-16T13:29:59.000Z');
    const at93000 = new Date('2026-03-16T13:30:00.000Z');
    const at150459 = new Date('2026-03-16T19:04:59.000Z');
    const at150500 = new Date('2026-03-16T19:05:00.000Z');

    assert.equal(isWithinOrbSession(at92959), false);
    assert.equal(withinOrbEntryWindow(at92959), false);
    assert.equal(isWithinOrbSession(at93000), true);
    assert.equal(withinOrbEntryWindow(at93000), true);
    assert.equal(isWithinOrbSession(at150459), true);
    assert.equal(withinOrbEntryWindow(at150459), true);
    assert.equal(isWithinOrbSession(at150500), false);
    assert.equal(withinOrbEntryWindow(at150500), false);
    assert.equal(isAtOrAfterTimeStop(at150459), false);
    assert.equal(isAtOrAfterTimeStop(at150500), true);
  });

  it('uses America/New_York across EST and EDT', () => {
    // 2026-01-15 Thursday, EST (UTC-5): 9:30 ET = 14:30Z, 15:05 ET = 20:05Z.
    const winterBefore = new Date('2026-01-15T14:29:59.000Z');
    const winterOpen = new Date('2026-01-15T14:30:00.000Z');
    const winterInside = new Date('2026-01-15T20:04:59.000Z');
    const winterCutoff = new Date('2026-01-15T20:05:00.000Z');
    assert.equal(isWithinOrbSession(winterBefore), false);
    assert.equal(isWithinOrbSession(winterOpen), true);
    assert.equal(isWithinOrbSession(winterInside), true);
    assert.equal(isWithinOrbSession(winterCutoff), false);

    // 2026-07-16 Thursday, EDT (UTC-4): 9:30 ET = 13:30Z, 15:05 ET = 19:05Z.
    const summerBefore = new Date('2026-07-16T13:29:59.000Z');
    const summerOpen = new Date('2026-07-16T13:30:00.000Z');
    const summerInside = new Date('2026-07-16T19:04:59.000Z');
    const summerCutoff = new Date('2026-07-16T19:05:00.000Z');
    assert.equal(withinOrbEntryWindow(summerBefore), false);
    assert.equal(withinOrbEntryWindow(summerOpen), true);
    assert.equal(withinOrbEntryWindow(summerInside), true);
    assert.equal(withinOrbEntryWindow(summerCutoff), false);
  });

  it('min premium floor is $0.65 and live cap is 100%', () => {
    assert.equal(ORB_MIN_ENTRY_PREMIUM, 0.65);
    assert.equal(ORB_LIVE_PER_TRADE_CAP_FRAC, 1);
    assert.equal(ORB_PARTIAL_LOCK_ACTIVATION_MFE, 0.03);
  });

  it('hard-caps ORB at 3 contracts even when max-affordable would allow more', () => {
    assert.equal(ORB_MAX_ENTRY_CONTRACTS, 3);
    assert.equal(ORB_ENTRY_SIZING.maxContracts, 3);
    assert.equal(ORB_ENTRY_SIZING.feePerContract, OPTION_OPENING_COMMISSION_PER_CONTRACT);

    // $500 / $35 = 14 max-affordable; ORB must still size 3.
    const orb = ladderPositionSize(500, 0.34, ORB_ENTRY_SIZING);
    assert.equal(orb.affordable, true);
    assert.equal(orb.quantity, 3);
    assert.equal(orb.entryContracts, 3);
    assert.equal(orb.totalCost, 105);
    // Capital below 3 contracts sizes only what it can pay for.
    assert.equal(ladderPositionSize(70, 0.34, ORB_ENTRY_SIZING).quantity, 2);
    assert.equal(ladderPositionSize(35, 0.34, ORB_ENTRY_SIZING).quantity, 1);

    const premarket = ladderPositionSize(500, 0.34, PREMARKET_ENTRY_SIZING);
    assert.equal(PREMARKET_MAX_ENTRY_CONTRACTS, 3);
    assert.equal(PREMARKET_ENTRY_SIZING.maxContracts, 3);
    assert.equal(premarket.quantity, 3);

    const ema = ladderPositionSize(500, 0.34, EMA_VWAP_ENTRY_SIZING);
    assert.equal(ema.quantity, 3);
    assert.equal(EMA_VWAP_ENTRY_SIZING.maxContracts, 3);
    assert.equal(ORB_PREMARKET_ENTRY_SIZING.maxContracts, Infinity);
  });

  it('skips ORB when even 1 contract is unaffordable (cap does not force a fill)', () => {
    const sizing = ladderPositionSize(34, 0.34, ORB_ENTRY_SIZING);
    assert.equal(sizing.quantity, 0);
    assert.equal(sizing.affordable, false);
  });

  it('allows ORB live and paper entry attempts', () => {
    assert.equal(ORB_ENTRIES_ENABLED, true);
    const orbExec = readFileSync(join(here, 'orbExecutor.js'), 'utf8');
    assert.match(orbExec, /ORB_ENTRIES_ENABLED/);
    assert.match(orbExec, /ORB_ENTRIES_DISABLED_REASON/);
  });

  it('wires the 3-contract override in orb, premarket, and emaVwap executors', () => {
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
