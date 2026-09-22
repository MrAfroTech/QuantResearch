import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  EMA_VWAP_BAR_SETTLE_MS,
  isCompletedFiveMinuteBar,
  filterCompletedFiveMinuteBars,
  msUntilFiveMinuteBarSettle,
  waitForCompletedFiveMinuteBarSettle,
  selectEmaVwapEvaluationBars,
} from './emaVwapBarTiming.js';
import { computeSessionIndicators } from './emaVwapIndicators.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 2026-09-02 is EDT (UTC-4). Tradier 5-min `time` is ET wall clock. */
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

describe('EMA/VWAP completed 5-min bars', () => {
  it('does not treat a forming bar as complete at :00 + 13s (today’s IWM/QQQ poll)', () => {
    const bar = etBar('2026-09-02T11:25:00', 292.58);
    const poll = etNow('2026-09-02T11:25:00', 13_000);
    assert.equal(isCompletedFiveMinuteBar(bar, poll), false);
    assert.equal(isCompletedFiveMinuteBar(bar, etNow('2026-09-02T11:30:00', 14_000)), false);
    assert.equal(isCompletedFiveMinuteBar(bar, etNow('2026-09-02T11:30:00', 15_000)), true);
    assert.equal(isCompletedFiveMinuteBar(bar, etNow('2026-09-02T11:30:00', 16_000)), true);
  });

  it('the scan at 11:25:15 evaluates the 11:20 bar (just closed), not 11:25 (just opened)', () => {
    const bars = [
      etBar('2026-09-02T11:15:00', 293.0),
      etBar('2026-09-02T11:20:00', 292.9),
      etBar('2026-09-02T11:25:00', 292.58),
    ];
    const atFormingPoll = filterCompletedFiveMinuteBars(
      bars,
      etNow('2026-09-02T11:25:00', 15_000)
    ).map((b) => b.time);
    assert.deepEqual(atFormingPoll, [
      '2026-09-02T11:15:00',
      '2026-09-02T11:20:00',
    ]);

    const afterClose = filterCompletedFiveMinuteBars(
      bars,
      etNow('2026-09-02T11:30:00', 15_000)
    ).map((b) => b.time);
    assert.deepEqual(afterClose, [
      '2026-09-02T11:15:00',
      '2026-09-02T11:20:00',
      '2026-09-02T11:25:00',
    ]);
  });

  it('waits only until settle after the 5-min boundary, then not again', async () => {
    assert.equal(EMA_VWAP_BAR_SETTLE_MS, 15_000);
    assert.equal(msUntilFiveMinuteBarSettle(etNow('2026-09-02T11:30:00', 0)), 15_000);
    assert.equal(msUntilFiveMinuteBarSettle(etNow('2026-09-02T11:30:00', 15_000)), 0);
    assert.equal(msUntilFiveMinuteBarSettle(etNow('2026-09-02T11:25:00', 13_000)), 2_000);

    const slept = [];
    const waited = await waitForCompletedFiveMinuteBarSettle({
      now: etNow('2026-09-02T11:30:00', 5_000),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.equal(waited, 10_000);
    assert.deepEqual(slept, [10_000]);
  });

  it('does not evaluate forming-bar OHLC that would otherwise enter the signal loop', () => {
    const prior = [];
    for (let i = 0; i < 12; i++) {
      const mins = 9 * 60 + 30 + i * 5;
      const hh = String(Math.floor(mins / 60)).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      prior.push(etBar(`2026-09-02T${hh}:${mm}:00`, 293.4, { volume: 2000 }));
    }
    const bar1120 = etBar('2026-09-02T11:20:00', 293.2, { volume: 2000 });
    const formingDump = etBar('2026-09-02T11:25:00', 280.0, { volume: 9000 });
    const raw = [...prior, bar1120, formingDump];

    const unfiltered = computeSessionIndicators(raw);
    const dumpBar = unfiltered.find((b) => b.time === '2026-09-02T11:25:00');
    assert.equal(dumpBar.close, 280);
    assert.ok(dumpBar.indicators_ready);

    const tooEarly = selectEmaVwapEvaluationBars(raw, {
      lastProcessedTime: '2026-09-02T11:15:00',
      now: etNow('2026-09-02T11:25:00', 13_000),
    });
    assert.equal(
      tooEarly.some((b) => b.time === '2026-09-02T11:25:00'),
      false,
      '11:25 forming bar must not be evaluated at 11:25:13'
    );

    const formingEval = selectEmaVwapEvaluationBars(raw, {
      lastProcessedTime: '2026-09-02T11:15:00',
      now: etNow('2026-09-02T11:25:00', 15_000),
    });
    assert.deepEqual(formingEval.map((b) => b.time), ['2026-09-02T11:20:00']);

    const afterClose = selectEmaVwapEvaluationBars(raw, {
      lastProcessedTime: '2026-09-02T11:15:00',
      now: etNow('2026-09-02T11:30:00', 15_000),
    });
    assert.equal(afterClose.some((b) => b.time === '2026-09-02T11:25:00'), true);
  });

  it('evaluates a completed bar exactly once after close, then skips it', () => {
    const bars = [];
    for (let i = 0; i < 10; i++) {
      const mins = 9 * 60 + 30 + i * 5;
      const hh = String(Math.floor(mins / 60)).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      bars.push(etBar(`2026-09-02T${hh}:${mm}:00`, 708 + i * 0.1));
    }
    // 10:15 is index 9 (09:30 + 9*5).
    const first = selectEmaVwapEvaluationBars(bars, {
      lastProcessedTime: '2026-09-02T10:10:00',
      now: etNow('2026-09-02T10:20:00', 15_000),
    });
    assert.deepEqual(first.map((b) => b.time), ['2026-09-02T10:15:00']);

    const second = selectEmaVwapEvaluationBars(bars, {
      lastProcessedTime: first[0].time,
      now: etNow('2026-09-02T10:20:00', 16_000),
    });
    assert.deepEqual(second.map((b) => b.time), []);
  });

  it('scan waits for settle, then selects completed bars only', () => {
    const src = readFileSync(join(here, 'emaVwapExecutor.js'), 'utf8');
    const scan = src.slice(src.indexOf('export async function runEmaVwapScanAndExecute'));
    const waitIdx = scan.indexOf('waitForCompletedFiveMinuteBarSettle');
    const selectIdx = scan.indexOf('selectEmaVwapEvaluationBars');
    const fetchIdx = scan.indexOf('getFiveMinuteBars');
    assert.ok(waitIdx > 0 && waitIdx < fetchIdx, 'settle wait must run before fetching bars');
    assert.ok(fetchIdx > 0 && fetchIdx < selectIdx, 'fetch must run before completed-bar select');
    assert.match(scan, /persistUnderlyingBarsInBackground\(symbol, bars/);
    assert.doesNotMatch(scan, /await persistUnderlyingBars/);
    assert.match(scan, /selectEmaVwapEvaluationBars/);
    assert.doesNotMatch(
      scan,
      /const enriched = computeSessionIndicators\(sessionBars\)/
    );
  });
});
