import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleLadderPositionMonitor,
  reconcileFilledBrokerStop,
} from './ladderExit.js';
import { createLadderBrokerStopHandlers } from './ladderStopOrders.js';
import { LADDER_CLOSE_REASON } from './ladderConfig.js';
import { ORB_HARD_STOP_PCT, ORB_STOP_LOSS_PCT } from '../orb/orbConfig.js';

const here = dirname(fileURLToPath(import.meta.url));

function readSrc(rel) {
  return readFileSync(join(here, rel), 'utf8');
}

/**
 * Real onStopFilled, with checkFill stubbed so the test does not call Tastytrade.
 * checkFill respects a cleared broker_stop_order_id so a second pass cannot rebook.
 */
function brokerStopForFill(fill, { fullClosePosition, onNotify, hardStopPct = ORB_HARD_STOP_PCT } = {}) {
  const handlers = createLadderBrokerStopHandlers({
    strategy: 'orb',
    environment: 'live',
    initialStopPct: ORB_STOP_LOSS_PCT,
    hardStopPct,
    updateBrokerStopState: async () => {},
    fullClosePosition,
    onNotify,
  });
  return {
    ...handlers,
    enabled: true,
    async checkFill(position) {
      if (!position?.broker_stop_order_id) return { filled: false };
      return {
        filled: true,
        fillPrice: fill.fillPrice,
        fillQuantity: fill.fillQuantity,
        pnlFrac: fill.pnlFrac,
      };
    },
  };
}

function openPosition(overrides = {}) {
  return {
    id: 280,
    ticker: 'IWM',
    direction: 'PUT',
    strike: 280,
    expiration: '2026-09-28',
    entry_premium: 1.1,
    contracts_open: 1,
    quantity: 1,
    entry_contracts: 1,
    exit_phase: 'INITIAL',
    mfe_pct: 0,
    mae_pct: 0,
    broker_stop_order_id: 'stop-iwm-280',
    ...overrides,
  };
}

describe('filled broker stop closes the DB position without a quote or another sell', () => {
  it('books the IWM-shaped stop fill at the broker price and stop_loss reason', async () => {
    const closes = [];
    const sells = [];
    const settles = [];
    const position = openPosition();
    const entry = position.entry_premium;
    const fillPrice = 0.86;
    const pnlFrac = (fillPrice - entry) / entry;
    assert.equal(ORB_STOP_LOSS_PCT, 0.2);
    assert.equal(ORB_HARD_STOP_PCT, 0.25);
    assert.ok(pnlFrac <= -ORB_STOP_LOSS_PCT);
    assert.ok(pnlFrac > -ORB_HARD_STOP_PCT);
    const brokerStop = brokerStopForFill(
      {
        fillPrice,
        fillQuantity: 1,
        pnlFrac: (fillPrice - entry) / entry,
      },
      {
        fullClosePosition: async (...args) => {
          closes.push(args);
        },
      }
    );

    const result = await handleLadderPositionMonitor(position, {
      currentPremium: undefined,
      isTimeStop: false,
      brokerStop,
      fullClosePosition: async () => {
        throw new Error('monitor must close through onStopFilled');
      },
      closeBrokerOrder: async () => {
        sells.push('sell');
        throw new Error('must not submit another sell');
      },
      flattenBrokerOrder: async () => {
        sells.push('flatten');
        throw new Error('must not submit another sell');
      },
      updateExcursion: async () => {
        throw new Error('must not require an option quote');
      },
      settleIfBrokerFlat: async () => {
        settles.push('broker_already_flat');
        return {
          settled: true,
          reason: 'broker_already_flat',
          exitPremium: fillPrice,
          pnlFrac: (fillPrice - entry) / entry,
        };
      },
    });

    assert.equal(result.brokerStopFill, true);
    assert.equal(result.reason, LADDER_CLOSE_REASON.STOP_LOSS);
    assert.equal(result.exitPremium, 0.86);
    assert.equal(closes.length, 1);
    assert.equal(closes[0][0], position.id);
    assert.equal(closes[0][1], 0.86);
    assert.equal(closes[0][3], LADDER_CLOSE_REASON.STOP_LOSS);
    assert.equal(closes[0][4], 1);
    assert.equal(position.broker_stop_order_id, null);
    assert.deepEqual(sells, []);
    assert.deepEqual(settles, []);
  });

  it('preserves a replacement-stop gain as trailing_stop at the broker fill (QQQ 1.06 shape)', async () => {
    const closes = [];
    const position = openPosition({
      id: 736,
      ticker: 'QQQ',
      direction: 'CALL',
      strike: 736,
      entry_premium: 0.9,
      broker_stop_order_id: 'stop-qqq-replacement',
    });
    const fillPrice = 1.06;
    const brokerStop = brokerStopForFill(
      {
        fillPrice,
        fillQuantity: 1,
        pnlFrac: (fillPrice - position.entry_premium) / position.entry_premium,
      },
      {
        fullClosePosition: async (...args) => {
          closes.push(args);
        },
      }
    );

    const result = await reconcileFilledBrokerStop(position, brokerStop);

    assert.equal(result.booked.brokerStopFill, true);
    assert.equal(result.booked.reason, LADDER_CLOSE_REASON.TRAILING_STOP);
    assert.equal(result.booked.exitPremium, 1.06);
    assert.equal(closes.length, 1);
    assert.equal(closes[0][1], 1.06);
    assert.equal(closes[0][3], LADDER_CLOSE_REASON.TRAILING_STOP);
  });

  it('does not create a second close when the same filled stop is seen again', async () => {
    const closes = [];
    const position = openPosition();
    const fillPrice = 0.86;
    const brokerStop = brokerStopForFill(
      {
        fillPrice,
        fillQuantity: 1,
        pnlFrac: (fillPrice - position.entry_premium) / position.entry_premium,
      },
      {
        fullClosePosition: async (...args) => {
          closes.push(args);
        },
      }
    );

    const first = await reconcileFilledBrokerStop(position, brokerStop);
    const second = await reconcileFilledBrokerStop(position, brokerStop);

    assert.equal(first.booked.reason, LADDER_CLOSE_REASON.STOP_LOSS);
    assert.equal(second.booked, null);
    assert.equal(closes.length, 1);
    assert.equal(closes[0][3], LADDER_CLOSE_REASON.STOP_LOSS);
  });

  it('does not relabel an identifiable stop as broker_already_flat while fill details are still landing', async () => {
    const closes = [];
    const settles = [];
    const position = openPosition();
    const result = await handleLadderPositionMonitor(position, {
      currentPremium: undefined,
      brokerStop: {
        enabled: true,
        async checkFill() {
          return { filled: false, awaitingFillDetails: true, status: { isFilled: true } };
        },
        async onStopFilled() {
          throw new Error('price is not confirmed yet');
        },
      },
      fullClosePosition: async (...args) => {
        closes.push(args);
      },
      closeBrokerOrder: async () => {
        throw new Error('must not submit another sell');
      },
      updateExcursion: async () => {
        throw new Error('must not require an option quote');
      },
      settleIfBrokerFlat: async () => {
        settles.push('broker_already_flat');
        return { settled: true, reason: 'broker_already_flat', exitPremium: 0.86, pnlFrac: -0.2 };
      },
    });

    assert.equal(result.reason, 'awaiting_stop_fill');
    assert.equal(result.awaitingStopFillDetails, true);
    assert.deepEqual(closes, []);
    assert.deepEqual(settles, []);
  });

  it('still books broker_already_flat when the broker is flat and the stop fill cannot be identified', async () => {
    const closes = [];
    const sells = [];
    const position = openPosition({ broker_stop_order_id: 'stop-cancelled' });
    let stopFilledCalled = false;
    const result = await handleLadderPositionMonitor(position, {
      currentPremium: 0.5,
      isTimeStop: true,
      updateExcursion: async () => {},
      partialCloseLeg: async () => {},
      fullClosePosition: async (...args) => {
        closes.push(args);
      },
      closeBrokerOrder: async () => {
        sells.push('sell');
        return { filled: false };
      },
      brokerStop: {
        enabled: true,
        async checkFill() {
          return { filled: false, status: { isTerminal: true, isFilled: false, status: 'cancelled' } };
        },
        async onStopFilled() {
          stopFilledCalled = true;
          throw new Error('stop did not fill');
        },
        async clearStopState(pos) {
          pos.broker_stop_order_id = null;
        },
      },
      settleIfBrokerFlat: async (pos) => {
        assert.equal(pos.broker_stop_order_id, null);
        closes.push([pos.id, 0.5, -50, 'broker_already_flat', 1]);
        return {
          settled: true,
          reason: 'broker_already_flat',
          exitPremium: 0.5,
          pnlFrac: -0.5,
        };
      },
    });

    assert.equal(stopFilledCalled, false);
    assert.equal(result.reason, 'broker_already_flat');
    assert.equal(result.brokerAlreadyFlat, true);
    assert.equal(result.exitPremium, 0.5);
    assert.equal(closes.length, 1);
    assert.equal(closes[0][3], 'broker_already_flat');
    assert.deepEqual(sells, []);
  });
});

describe('0DTE monitors reconcile the resting stop before any option quote', () => {
  it('checks broker_stop_order_id before the option quote and before broker-flat settlement', () => {
    for (const rel of [
      '../orb/orbPositionManager.js',
      '../premarketBreakout/premarketPositionManager.js',
      '../emaVwapCross/emaVwapPositionManager.js',
    ]) {
      const src = readSrc(rel);
      const stopAt = src.indexOf('await reconcileFilledBrokerStop');
      const quoteAt = src.indexOf('await getZeroDteOptionObservation');
      assert.ok(stopAt > 0, `${rel} must reconcile the resting stop`);
      assert.ok(quoteAt > stopAt, `${rel} must not require a quote before the stop check`);
    }

    const monitor = readSrc('ladderExit.js');
    const fn = monitor.slice(monitor.indexOf('export async function handleLadderPositionMonitor'));
    const stopAt = fn.indexOf('reconcileFilledBrokerStop');
    const settleAt = fn.indexOf('settleIfBrokerFlat(position)');
    assert.ok(stopAt > 0 && stopAt < settleAt);
    assert.equal(fn.includes('brokerStop.checkFill'), false);
  });
});
