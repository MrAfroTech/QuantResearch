import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLASH_STOP_MAX_HOLD_MS,
  evaluateSameDayReentry,
} from './entryReentryGate.js';
import { isFlashStopHold } from './zeroDte/spentBreakoutLevel.js';

const TRADE_DATE = '2026-09-15';

/** Production ORB QQQ PUT 2026-09-15 — closed in 41s at −$4. */
const QQQ_FLASH_PUT = {
  id: 116,
  ticker: 'QQQ',
  direction: 'PUT',
  opened_at: '2026-09-15 14:15:20.447122+00',
  closed_at: '2026-09-15 14:16:01.777805+00',
  realized_pnl: -4,
  close_reason: 'broker_already_flat',
  entry_premium: 1.34,
  exit_premium: 1.32,
  quantity: 2,
};

function withHold(openedAt, closedAt, extra = {}) {
  return {
    id: extra.id ?? 1,
    opened_at: openedAt,
    closed_at: closedAt,
    realized_pnl: extra.realized_pnl ?? -10,
    close_reason: extra.close_reason ?? 'stop_loss',
    entry_premium: extra.entry_premium ?? 1,
    exit_premium: extra.exit_premium ?? 0.5,
    quantity: extra.quantity ?? 1,
  };
}

describe('same-day reentry flash-loss exception', () => {
  it('uses the 60s flash-pardon threshold', () => {
    assert.equal(FLASH_STOP_MAX_HOLD_MS, 60_000);
    assert.equal(isFlashStopHold(41_330), true);
    assert.equal(isFlashStopHold(59_999), true);
    assert.equal(isFlashStopHold(60_000), false);
  });

  it('does not block after today\'s QQQ PUT 41s flash close', () => {
    const gate = evaluateSameDayReentry({
      rows: [QQQ_FLASH_PUT],
      tradeDate: TRADE_DATE,
    });
    assert.equal(gate.blocked, false);
    assert.equal(gate.reason, null);
    assert.equal(gate.lastOutcome, null);
  });

  it('still blocks a genuine sustained loss (≥ 60s)', () => {
    const sustained = withHold(
      '2026-09-15 14:15:20.447122+00',
      '2026-09-15 14:16:20.447122+00',
      { realized_pnl: -4, close_reason: 'stop_loss' }
    );
    const gate = evaluateSameDayReentry({
      rows: [sustained],
      tradeDate: TRADE_DATE,
    });
    assert.equal(gate.blocked, true);
    assert.equal(gate.reason, 'same_day_loss_block');
    assert.equal(gate.lastOutcome, 'loss');
    assert.equal(gate.lastPnl, -4);
  });

  it('skips a flash loss and still blocks on a later-listed sustained loss from today', () => {
    const sustained = withHold(
      '2026-09-15 13:00:00+00',
      '2026-09-15 13:05:00+00',
      { id: 90, realized_pnl: -12 }
    );
    const gate = evaluateSameDayReentry({
      rows: [QQQ_FLASH_PUT, sustained],
      tradeDate: TRADE_DATE,
    });
    assert.equal(gate.blocked, true);
    assert.equal(gate.lastPnl, -12);
  });

  it('skips a flash loss and allows when the prior real outcome today was a win', () => {
    const win = withHold(
      '2026-09-15 13:00:00+00',
      '2026-09-15 13:05:00+00',
      { id: 91, realized_pnl: 8, close_reason: 'target' }
    );
    const gate = evaluateSameDayReentry({
      rows: [QQQ_FLASH_PUT, win],
      tradeDate: TRADE_DATE,
    });
    assert.equal(gate.blocked, false);
    assert.equal(gate.lastOutcome, 'win');
    assert.equal(gate.lastPnl, 8);
  });

  it('treats unknown hold duration on a loss as a qualifying same-day block', () => {
    const unknown = {
      id: 2,
      opened_at: null,
      closed_at: '2026-09-15 14:16:01.777805+00',
      realized_pnl: -4,
      close_reason: 'stop_loss',
    };
    const gate = evaluateSameDayReentry({
      rows: [unknown],
      tradeDate: TRADE_DATE,
    });
    assert.equal(gate.blocked, true);
    assert.equal(gate.reason, 'same_day_loss_block');
  });

  it('applies the same flash exception for premarket and emavwap rows', () => {
    for (const id of [201, 301]) {
      const gate = evaluateSameDayReentry({
        rows: [{ ...QQQ_FLASH_PUT, id }],
        tradeDate: TRADE_DATE,
      });
      assert.equal(gate.blocked, false, `id=${id}`);
    }
  });
});
