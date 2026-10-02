import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORB_ENTRIES_ENABLED,
  ORB_ENTRY_WINDOW_END,
  ORB_ENTRY_WINDOW_START,
  ORB_HARD_STOP_PCT,
  ORB_MAX_ENTRY_CONTRACTS,
  ORB_MIN_ENTRY_PREMIUM,
  ORB_PARTIAL_LOCK_ACTIVATION_MFE,
  ORB_STOP_LOSS_PCT,
} from '../orb/orbConfig.js';
import {
  PREMARKET_HARD_STOP_PCT,
  PREMARKET_HARD_STOP_TRIGGER,
  PREMARKET_MAX_ENTRY_CONTRACTS,
  PREMARKET_MIN_ENTRY_PREMIUM,
  PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
  PREMARKET_STOP_LOSS_PCT,
  computePremarketIvStopPcts,
} from '../premarketBreakout/premarketConfig.js';
import {
  EMA_VWAP_HARD_STOP_PCT,
  EMA_VWAP_MAX_ENTRY_CONTRACTS,
  EMA_VWAP_MIN_ENTRY_PREMIUM,
  EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE,
  EMA_VWAP_STOP_LOSS_PCT,
} from '../emaVwapCross/emaVwapConfig.js';
import {
  PARTIAL_LOCK_TRAIL_MAX_PCT,
  PARTIAL_LOCK_TRAIL_START_PCT,
  PARTIAL_LOCK_TRAIL_STEP_AFTER_50,
  PARTIAL_LOCK_TRAIL_STEP_THROUGH_48,
  evaluateSteppedPartialLockTrail,
  trailFloorFromPeak,
} from './partialLockTrailRungs.js';
import { buildBrokerStopOrderParams } from './ladderStopOrders.js';
import { reconcileFilledBrokerStop } from './ladderExit.js';
import { LADDER_CLOSE_REASON } from './ladderConfig.js';

describe('0DTE initial loss tolerance', () => {
  it('uses a 5.75% initial protective stop for Premarket, EMA/VWAP, and ORB', () => {
    assert.equal(PREMARKET_STOP_LOSS_PCT, 0.0575);
    assert.equal(EMA_VWAP_STOP_LOSS_PCT, 0.0575);
    assert.equal(ORB_STOP_LOSS_PCT, 0.0575);
    assert.equal(PREMARKET_STOP_LOSS_PCT, EMA_VWAP_STOP_LOSS_PCT);
    assert.equal(EMA_VWAP_STOP_LOSS_PCT, ORB_STOP_LOSS_PCT);
  });

  it('uses an 8.5% hard stop for Premarket, EMA/VWAP, and ORB', () => {
    assert.equal(PREMARKET_HARD_STOP_TRIGGER, 0.085);
    assert.equal(PREMARKET_HARD_STOP_PCT, 0.085);
    assert.equal(EMA_VWAP_HARD_STOP_PCT, 0.085);
    assert.equal(ORB_HARD_STOP_PCT, 0.085);
    const iv = computePremarketIvStopPcts(0.4);
    assert.equal(iv.softStopPct, 0.0575);
    assert.equal(iv.hardStopPct, 0.085);
    assert.equal(iv.ivMult, 1);
  });

  it('rests the broker stop at -5.75% of entry for every 0DTE strategy', () => {
    for (const initialStopPct of [
      PREMARKET_STOP_LOSS_PCT,
      EMA_VWAP_STOP_LOSS_PCT,
      ORB_STOP_LOSS_PCT,
    ]) {
      const params = buildBrokerStopOrderParams(
        {
          entry_premium: 1,
          quantity: 1,
          contracts_open: 1,
          exit_phase: 'LADDER:0',
        },
        { initialStopPct }
      );
      assert.equal(params.stopPnlFrac, -0.0575);
      assert.equal(params.stopTrigger, 0.94);
    }
  });
});

describe('0DTE profit ratchet floors', () => {
  it('arms at +3% on a breakeven floor, then locks +13.5%', () => {
    assert.equal(PARTIAL_LOCK_TRAIL_START_PCT, 0.03);
    assert.equal(PARTIAL_LOCK_TRAIL_STEP_THROUGH_48, 0.075);
    assert.equal(PARTIAL_LOCK_TRAIL_STEP_AFTER_50, 0.1);
    assert.equal(PARTIAL_LOCK_TRAIL_MAX_PCT, 10);
    assert.equal(ORB_PARTIAL_LOCK_ACTIVATION_MFE, 0.03);
    assert.equal(PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE, 0.03);
    assert.equal(EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE, 0.03);

    assert.equal(trailFloorFromPeak(0.029), null);
    assert.equal(trailFloorFromPeak(0.03), 0);
    assert.equal(trailFloorFromPeak(0.12), 0);
    assert.equal(trailFloorFromPeak(0.18), 0.135);
    assert.equal(trailFloorFromPeak(0.5), 0.425);
    assert.equal(trailFloorFromPeak(0.6), 0.585);

    const held = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.12,
      mfeFrac: 0.12,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(held.action, 'hold');
    assert.equal(held.trailFloor, 0);

    const closed = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.135,
      mfeFrac: 0.16,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(closed.action, 'close_all');
    assert.equal(closed.reason, 'partial_lock_trail');
    assert.equal(closed.trailFloor, 0.135);

    const hardOwns = evaluateSteppedPartialLockTrail({
      pnlFrac: -0.25,
      mfeFrac: 0.1,
      hardStopPct: 0.25,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(hardOwns.action, 'hold');
    assert.equal(hardOwns.inactiveReason, 'hard_stop_owns_exit');
  });
});

describe('entry rules and broker-stop reconciliation stay in place', () => {
  it('keeps 0DTE entry caps, premium floor, and window, with ORB entries enabled', () => {
    assert.equal(ORB_ENTRIES_ENABLED, true);
    assert.equal(ORB_MAX_ENTRY_CONTRACTS, 2);
    assert.equal(PREMARKET_MAX_ENTRY_CONTRACTS, 2);
    assert.equal(EMA_VWAP_MAX_ENTRY_CONTRACTS, 2);
    assert.equal(ORB_MIN_ENTRY_PREMIUM, 0.65);
    assert.equal(PREMARKET_MIN_ENTRY_PREMIUM, 0.65);
    assert.equal(EMA_VWAP_MIN_ENTRY_PREMIUM, 0.65);
    assert.deepEqual(ORB_ENTRY_WINDOW_START, { hour: 9, minute: 30 });
    assert.deepEqual(ORB_ENTRY_WINDOW_END, { hour: 15, minute: 5 });
  });

  it('books a filled protective stop once and does not submit another sell', async () => {
    const sells = [];
    const closes = [];
    const position = {
      id: 1,
      entry_premium: 1,
      contracts_open: 1,
      quantity: 1,
      broker_stop_order_id: 'stop-1',
    };
    const brokerStop = {
      enabled: true,
      async checkFill(pos) {
        if (!pos.broker_stop_order_id) return { filled: false };
        return { filled: true, fillPrice: 0.8, fillQuantity: 1, pnlFrac: -0.2 };
      },
      async onStopFilled(pos, fill) {
        closes.push([pos.id, fill.fillPrice, fill.pnlFrac]);
        pos.broker_stop_order_id = null;
        return {
          brokerStopFill: true,
          reason: LADDER_CLOSE_REASON.STOP_LOSS,
          exitPremium: fill.fillPrice,
        };
      },
      async cancelStop() {
        sells.push('cancel');
      },
    };

    const first = await reconcileFilledBrokerStop(position, brokerStop);
    const second = await reconcileFilledBrokerStop(position, brokerStop);

    assert.equal(first.booked.brokerStopFill, true);
    assert.equal(first.booked.reason, LADDER_CLOSE_REASON.STOP_LOSS);
    assert.equal(first.booked.exitPremium, 0.8);
    assert.equal(second.booked, null);
    assert.deepEqual(closes, [[1, 0.8, -0.2]]);
    assert.deepEqual(sells, []);
  });
});
