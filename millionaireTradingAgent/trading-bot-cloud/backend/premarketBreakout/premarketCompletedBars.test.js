import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COMPLETED_BAR_SETTLE_MS,
  isCompletedBar,
  filterCompletedBars,
  msUntilBarSettle,
  waitForCompletedBarSettle,
  selectCompletedNewBars,
} from '../zeroDte/completedBarTiming.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 2026-09-02 is EDT (UTC-4). Tradier bar `time` is ET wall clock. */
function etBar(timeEt, close, extra = {}) {
  const utc = new Date(`${timeEt}-04:00`);
  return {
    time: timeEt,
    timestamp: Math.floor(utc.getTime() / 1000),
    open: extra.open ?? close,
    high: extra.high ?? close,
    low: extra.low ?? close,
    close,
    volume: extra.volume ?? 1000,
  };
}

function etNow(timeEt, extraMs = 0) {
  return new Date(new Date(`${timeEt}-04:00`).getTime() + extraMs);
}

describe('Premarket completed bars (5-min + THE3-4 1-min)', () => {
  it('does not treat a forming 5-min bar as complete at :00 + 13s', () => {
    const bar = etBar('2026-09-02T09:35:00', 580.12);
    assert.equal(
      isCompletedBar(bar, { now: etNow('2026-09-02T09:35:00', 13_000), intervalMinutes: 5 }),
      false
    );
    assert.equal(
      isCompletedBar(bar, { now: etNow('2026-09-02T09:40:00', 14_000), intervalMinutes: 5 }),
      false
    );
    assert.equal(
      isCompletedBar(bar, { now: etNow('2026-09-02T09:40:00', 15_000), intervalMinutes: 5 }),
      true
    );
  });

  it('does not treat a forming 1-min THE3-4 bar as complete at :00 + 13s', () => {
    const bar = etBar('2026-09-02T09:35:00', 580.12);
    assert.equal(
      isCompletedBar(bar, { now: etNow('2026-09-02T09:35:00', 13_000), intervalMinutes: 1 }),
      false
    );
    assert.equal(
      isCompletedBar(bar, { now: etNow('2026-09-02T09:36:00', 14_000), intervalMinutes: 1 }),
      false
    );
    assert.equal(
      isCompletedBar(bar, { now: etNow('2026-09-02T09:36:00', 15_000), intervalMinutes: 1 }),
      true
    );
  });

  it('the 5-min scan at 09:35:15 evaluates the 09:30 bar, not 09:35 (just opened)', () => {
    const bars = [
      etBar('2026-09-02T09:25:00', 579.8),
      etBar('2026-09-02T09:30:00', 580.0),
      etBar('2026-09-02T09:35:00', 580.12),
    ];
    const atFormingPoll = filterCompletedBars(bars, {
      now: etNow('2026-09-02T09:35:00', 15_000),
      intervalMinutes: 5,
    }).map((b) => b.time);
    assert.deepEqual(atFormingPoll, [
      '2026-09-02T09:25:00',
      '2026-09-02T09:30:00',
    ]);
  });

  it('the 1-min scan at 09:35:15 evaluates the 09:34 bar, not 09:35 (just opened)', () => {
    const bars = [
      etBar('2026-09-02T09:33:00', 579.8),
      etBar('2026-09-02T09:34:00', 580.0),
      etBar('2026-09-02T09:35:00', 580.12),
    ];
    const atFormingPoll = filterCompletedBars(bars, {
      now: etNow('2026-09-02T09:35:00', 15_000),
      intervalMinutes: 1,
    }).map((b) => b.time);
    assert.deepEqual(atFormingPoll, [
      '2026-09-02T09:33:00',
      '2026-09-02T09:34:00',
    ]);
  });

  it('uses the same 15s settle for 5-min and 1-min', async () => {
    assert.equal(COMPLETED_BAR_SETTLE_MS, 15_000);
    assert.equal(msUntilBarSettle(etNow('2026-09-02T09:40:00', 0), 5), 15_000);
    assert.equal(msUntilBarSettle(etNow('2026-09-02T09:36:00', 0), 1), 15_000);

    const slept = [];
    const waited = await waitForCompletedBarSettle({
      now: etNow('2026-09-02T09:40:00', 5_000),
      intervalMinutes: 5,
      label: 'Premarket',
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.equal(waited, 10_000);
    assert.deepEqual(slept, [10_000]);
  });

  it('never evaluates a forming bar; evaluates a completed bar exactly once', () => {
    const bars = [
      etBar('2026-09-02T09:25:00', 579.8),
      etBar('2026-09-02T09:30:00', 580.0),
      etBar('2026-09-02T09:35:00', 572.0, { volume: 200_000, high: 581, low: 572 }),
    ];

    const tooEarly = selectCompletedNewBars(bars, {
      lastProcessedTime: '2026-09-02T09:25:00',
      now: etNow('2026-09-02T09:35:00', 13_000),
      intervalMinutes: 5,
    });
    assert.equal(
      tooEarly.some((b) => b.time === '2026-09-02T09:35:00'),
      false,
      '09:35 forming bar must not be evaluated at 09:35:13'
    );

    const afterSettle = selectCompletedNewBars(bars, {
      lastProcessedTime: '2026-09-02T09:25:00',
      now: etNow('2026-09-02T09:35:00', 15_000),
      intervalMinutes: 5,
    });
    assert.deepEqual(afterSettle.map((b) => b.time), ['2026-09-02T09:30:00']);

    const first = selectCompletedNewBars(bars, {
      lastProcessedTime: '2026-09-02T09:30:00',
      now: etNow('2026-09-02T09:40:00', 15_000),
      intervalMinutes: 5,
    });
    assert.deepEqual(first.map((b) => b.time), ['2026-09-02T09:35:00']);

    const second = selectCompletedNewBars(bars, {
      lastProcessedTime: first[0].time,
      now: etNow('2026-09-02T09:40:00', 16_000),
      intervalMinutes: 5,
    });
    assert.deepEqual(second.map((b) => b.time), []);
  });

  it('scan waits for settle, then filters completed bars before range/FSM', () => {
    const src = readFileSync(join(here, 'premarketExecutor.js'), 'utf8');
    const scan = src.slice(src.indexOf('export async function runPremarketScanAndExecute'));
    const waitIdx = scan.indexOf('waitForCompletedBarSettle');
    const fetchIdx = Math.max(
      scan.indexOf('getExtendedFiveMinuteBars'),
      scan.indexOf('getExtendedOneMinuteBars')
    );
    const filterIdx = scan.indexOf('filterCompletedBars');
    const rangeIdx = scan.indexOf('updatePremarketRange');
    const evalIdx = scan.indexOf('evaluateWithCatchUp');
    assert.ok(waitIdx > 0 && waitIdx < fetchIdx, 'settle wait must run before fetching bars');
    assert.ok(fetchIdx > 0 && fetchIdx < filterIdx, 'fetch must run before completed-bar filter');
    assert.match(scan, /persistUnderlyingBarsInBackground\(symbol, bars/);
    assert.doesNotMatch(scan, /await persistUnderlyingBars/);
    assert.ok(filterIdx > 0 && filterIdx < rangeIdx, 'completed filter must run before premarket-range update');
    assert.ok(rangeIdx > 0 && rangeIdx < evalIdx, 'range/FSM must see completed bars only');
    assert.match(scan, /updatePremarketRange\(symbol, completedBars/);
    assert.match(scan, /getPostOpenBars\(completedBars\)/);

    const engine = readFileSync(join(here, 'premarketSignalEngine.js'), 'utf8');
    assert.match(engine, /must pass only completed bars/);
    assert.doesNotMatch(engine, /isCompletedBar|filterCompletedBars|waitForCompletedBarSettle/);
  });
});
