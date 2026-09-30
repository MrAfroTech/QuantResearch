import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createLadderBrokerStopHandlers,
  resolveBrokerStopCloseReason,
  replaceLadderBrokerStop,
  POSITION_UNPROTECTED_NO_RESTING_STOP,
} from './ladderStopOrders.js';
import { isBrokerDryRun, replaceOptionStopOrder } from '../brokerageConnector.js';
import { LADDER_CLOSE_REASON } from './ladderConfig.js';
import { ORB_HARD_STOP_PCT, ORB_STOP_LOSS_PCT } from '../orb/orbConfig.js';
import {
  PREMARKET_HARD_STOP_TRIGGER,
  PREMARKET_STOP_LOSS_PCT,
} from '../premarketBreakout/premarketConfig.js';
import {
  EMA_VWAP_HARD_STOP_PCT,
  EMA_VWAP_STOP_LOSS_PCT,
} from '../emaVwapCross/emaVwapConfig.js';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ladderStopOrders.js'), 'utf8');
const connectorSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../brokerageConnector.js'),
  'utf8'
);

describe('resolveBrokerStopCloseReason', () => {
  it('reclassifies broker soft fills past hard-stop as hard_stop (trade-52 shape)', () => {
    // Soft broker resting at -12%, fill -12.43%, Premarket hard 8.5%.
    const reason = resolveBrokerStopCloseReason(-0.1243, 0.085);
    assert.equal(reason, LADDER_CLOSE_REASON.HARD_STOP);
  });

  it('keeps stop_loss when fill is past soft but still above hard', () => {
    // e.g. soft 12% would not fill here; if a shallow negative stop fill arrives above hard.
    const reason = resolveBrokerStopCloseReason(-0.05, 0.085);
    assert.equal(reason, LADDER_CLOSE_REASON.STOP_LOSS);
  });

  it('keeps stop_loss at exactly the boundary just above hard', () => {
    const reason = resolveBrokerStopCloseReason(-0.0849, 0.085);
    assert.equal(reason, LADDER_CLOSE_REASON.STOP_LOSS);
  });

  it('attributes hard_stop at exactly the hard threshold', () => {
    const reason = resolveBrokerStopCloseReason(-0.085, 0.085);
    assert.equal(reason, LADDER_CLOSE_REASON.HARD_STOP);
  });

  it('does not reclassify when hardStopPct is omitted', () => {
    assert.equal(resolveBrokerStopCloseReason(-0.1243, null), LADDER_CLOSE_REASON.STOP_LOSS);
    assert.equal(resolveBrokerStopCloseReason(0.2, null), LADDER_CLOSE_REASON.TRAILING_STOP);
  });

  it('keeps an 8% fill as stop_loss and a 13.5% fill as hard_stop for every 0DTE strategy', () => {
    for (const soft of [ORB_STOP_LOSS_PCT, PREMARKET_STOP_LOSS_PCT, EMA_VWAP_STOP_LOSS_PCT]) {
      assert.equal(soft, 0.08);
    }
    for (const hard of [ORB_HARD_STOP_PCT, PREMARKET_HARD_STOP_TRIGGER, EMA_VWAP_HARD_STOP_PCT]) {
      assert.equal(hard, 0.135);
      assert.equal(resolveBrokerStopCloseReason(-0.08, hard), LADDER_CLOSE_REASON.STOP_LOSS);
      assert.equal(resolveBrokerStopCloseReason(-0.135, hard), LADDER_CLOSE_REASON.HARD_STOP);
      assert.equal(resolveBrokerStopCloseReason(-0.02, hard), LADDER_CLOSE_REASON.STOP_LOSS);
      assert.equal(resolveBrokerStopCloseReason(-0.0175, hard), LADDER_CLOSE_REASON.STOP_LOSS);
      assert.equal(resolveBrokerStopCloseReason(-0.01, hard), LADDER_CLOSE_REASON.STOP_LOSS);
    }
  });
});

describe('onStopFilled requires confirmed fill price and quantity', () => {
  it('does not close when fill price is missing', async () => {
    const closed = [];
    const handlers = createLadderBrokerStopHandlers({
      strategy: 'orb',
      environment: 'paper',
      initialStopPct: 0.01,
      fullClosePosition: async (...args) => {
        closed.push(args);
      },
    });
    const result = await handlers.onStopFilled(
      { id: 1, entry_premium: 0.71, contracts_open: 1, quantity: 1 },
      { fillPrice: null, fillQuantity: 1, pnlFrac: -0.01 }
    );
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'stop_fill_unconfirmed');
    assert.deepEqual(closed, []);
  });

  it('closes at the confirmed fill qty and price, not contracts_open', async () => {
    const closed = [];
    const handlers = createLadderBrokerStopHandlers({
      strategy: 'orb',
      environment: 'paper',
      initialStopPct: 0.01,
      fullClosePosition: async (...args) => {
        closed.push(args);
      },
    });
    const result = await handlers.onStopFilled(
      { id: 2, entry_premium: 1, contracts_open: 3, quantity: 3 },
      { fillPrice: 0.88, fillQuantity: 2, pnlFrac: -0.12 }
    );
    assert.equal(result.brokerStopFill, true);
    assert.equal(result.exitPremium, 0.88);
    assert.equal(result.contractsClosed, 2);
    assert.equal(closed[0][1], 0.88);
    assert.equal(closed[0][4], 2);
  });
});

describe('replaceLadderBrokerStop prefers atomic PUT', () => {
  function pos(overrides = {}) {
    return {
      id: 83,
      ticker: 'SPY',
      direction: 'CALL',
      entry_premium: 0.915,
      quantity: 1,
      contracts_open: 1,
      broker_stop_order_id: '499954177',
      broker_stop_trigger_price: 0.91,
      broker_stop_pnl_frac: -0.0175,
      ...overrides,
    };
  }

  it('PUT-replaces the live stop and never cancels when the new order rests', async () => {
    const calls = [];
    const position = pos();
    const result = await replaceLadderBrokerStop(position, {
      strategy: 'orb',
      environment: 'live',
      initialStopPct: 0.0175,
      stopPnlFrac: 0.038,
      replaceStopOrder: async (_p, args) => {
        calls.push(['put', args.existingOrderId, args.stopTrigger]);
        return {
          orderId: 'new-1',
          resting: true,
          replaced: true,
          stopTrigger: args.stopTrigger,
        };
      },
      cancelStop: async () => {
        calls.push(['cancel']);
        return { cancelled: true };
      },
      placeStop: async () => {
        calls.push(['place']);
        return { placed: false, reason: 'should_not_place' };
      },
      verifyTerminated: async () => {
        calls.push(['verify']);
        return { terminated: true };
      },
    });
    assert.equal(result.placed, true);
    assert.equal(result.replaced, true);
    assert.equal(position.broker_stop_order_id, 'new-1');
    assert.deepEqual(calls.map((c) => c[0]), ['put']);
  });

  it('keeps the working stop when PUT is not confirmed and does not sell again', async () => {
    const calls = [];
    const position = pos();
    const result = await replaceLadderBrokerStop(position, {
      strategy: 'orb',
      environment: 'live',
      initialStopPct: 0.0175,
      stopPnlFrac: 0.038,
      replaceStopOrder: async () => {
        calls.push('put');
        assert.equal(position.broker_stop_order_id, '499954177');
        return { resting: false, reason: 'not_resting' };
      },
      cancelStop: async () => {
        calls.push('cancel');
        return { cancelled: true };
      },
      verifyTerminated: async () => {
        calls.push('verify');
        return { terminated: true };
      },
      placeStop: async () => {
        calls.push('place');
        return { placed: true, orderId: 'bad' };
      },
    });
    assert.equal(result.placed, false);
    assert.equal(result.reason, 'not_resting');
    assert.equal(result.keptPriorStop, true);
    assert.equal(result.unprotected, false);
    assert.equal(position.broker_stop_order_id, '499954177');
    assert.equal(position.broker_stop_trigger_price, 0.91);
    assert.deepEqual(calls, ['put']);
  });

  it('does not mark a working stop unprotected when place would fail', async () => {
    const position = pos();
    const result = await replaceLadderBrokerStop(position, {
      strategy: 'orb',
      environment: 'live',
      initialStopPct: 0.0175,
      stopPnlFrac: 0.038,
      replaceStopOrder: async () => ({ resting: false, reason: 'put_fail' }),
      cancelStop: async () => {
        position.broker_stop_order_id = null;
        return { cancelled: true };
      },
      placeStop: async () => ({ placed: false, reason: 'uncovered' }),
    });
    assert.equal(result.placed, false);
    assert.equal(result.unprotected, false);
    assert.equal(result.keptPriorStop, true);
    assert.notEqual(result.reason, POSITION_UNPROTECTED_NO_RESTING_STOP);
    assert.equal(position.broker_stop_order_id, '499954177');
    assert.equal(position.broker_stop_pnl_frac, -0.0175);
  });

  it('adopts the replacement only after it is confirmed resting', async () => {
    const calls = [];
    const position = pos({
      id: 120,
      direction: 'PUT',
      entry_premium: 0.99,
      broker_stop_order_id: '510288226',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
    });
    const result = await replaceLadderBrokerStop(position, {
      strategy: 'premarket',
      environment: 'live',
      initialStopPct: 0.2,
      stopPnlFrac: 0.03,
      replaceStopOrder: async (_p, args) => {
        calls.push(['put', args.existingOrderId, args.stopTrigger]);
        assert.equal(position.broker_stop_order_id, '510288226');
        assert.equal(position.broker_stop_trigger_price, 0.79);
        return {
          orderId: '510288999',
          resting: true,
          replaced: true,
          stopTrigger: args.stopTrigger,
        };
      },
      cancelStop: async () => {
        calls.push(['cancel']);
        throw new Error('must not cancel a confirmed replacement');
      },
      placeStop: async () => {
        calls.push(['place']);
        throw new Error('must not submit a second sell');
      },
    });
    assert.equal(result.placed, true);
    assert.equal(result.replaced, true);
    assert.equal(result.stopTrigger, 1.02);
    assert.equal(position.broker_stop_order_id, '510288999');
    assert.equal(position.broker_stop_trigger_price, 1.02);
    assert.deepEqual(calls, [['put', '510288226', 1.02]]);
  });

  it('keeps the $0.79 stop when OAuth invalid_grant rejects the ratchet replace', async () => {
    const calls = [];
    const oauthError = new Error(
      'Tastytrade OAuth token refresh failed: 400 {"error_code":"invalid_grant","error_description":"Grant revoked"}'
    );
    const position = pos({
      id: 120,
      ticker: 'SPY',
      direction: 'PUT',
      entry_premium: 0.99,
      broker_stop_order_id: '510288226',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
    });
    const result = await replaceLadderBrokerStop(position, {
      strategy: 'premarket',
      environment: 'live',
      initialStopPct: 0.2,
      stopPnlFrac: 0.03,
      replaceStopOrder: async (_p, args) => {
        calls.push(['put', args.stopTrigger]);
        assert.equal(position.broker_stop_order_id, '510288226');
        throw oauthError;
      },
      cancelStop: async () => {
        calls.push(['cancel']);
        return { cancelled: true };
      },
      placeStop: async () => {
        calls.push(['place']);
        return { placed: true, orderId: 'second-sell' };
      },
      closePosition: async () => {
        calls.push(['market-sell']);
      },
    });
    assert.equal(result.placed, false);
    assert.equal(result.keptPriorStop, true);
    assert.equal(result.unprotected, false);
    assert.match(result.reason, /invalid_grant/);
    assert.match(result.reason, /Grant revoked/);
    assert.equal(position.broker_stop_order_id, '510288226');
    assert.equal(position.broker_stop_trigger_price, 0.79);
    assert.equal(position.broker_stop_pnl_frac, -0.2);
    assert.equal(result.stopTrigger, 0.79);
    assert.equal(result.stopPnlFrac, -0.2);
    assert.deepEqual(calls, [['put', 1.02]]);
  });

  it('wires PUT replace and does not cancel a working stop before confirmation', () => {
    assert.match(connectorSrc, /method: 'PUT'/);
    assert.match(connectorSrc, /tastytradeReplaceStopOrderWithCredentials/);
    assert.match(connectorSrc, /includeLegs: false/);
    assert.match(connectorSrc, /export function isBrokerDryRun\(/);
    const replaceFn = src.slice(
      src.indexOf('export async function replaceLadderBrokerStop'),
      src.indexOf('export async function checkLadderBrokerStopFill')
    );
    assert.match(replaceFn, /replaceStopOrder/);
    assert.match(replaceFn, /keeping prior protective stop/);
    assert.doesNotMatch(replaceFn, /cancelStop/);
    assert.doesNotMatch(replaceFn, /cancel-verify-place/);
    const putIdx = replaceFn.indexOf('replaceStopOrder');
    const adoptIdx = replaceFn.indexOf('applyPlacedStopToPosition');
    assert.ok(putIdx > 0 && adoptIdx > putIdx);
  });
});

describe('isBrokerDryRun', () => {
  it('resolves without throwing and dry-run replaces do not call the broker', async () => {
    const previous = process.env.BROKER_DRY_RUN;
    try {
      delete process.env.BROKER_DRY_RUN;
      assert.equal(typeof isBrokerDryRun, 'function');
      assert.doesNotThrow(() => isBrokerDryRun());
      assert.equal(isBrokerDryRun(), false);

      const dryId = await replaceOptionStopOrder(
        { quantity: 1 },
        {
          existingOrderId: 'DRYRUN-STOP-120',
          quantity: 1,
          stopTrigger: 1.02,
          environment: 'live',
          strategy: 'premarket',
        }
      );
      assert.equal(dryId.dryRun, true);
      assert.equal(dryId.resting, true);
      assert.equal(dryId.replaced, true);
      assert.equal(dryId.stopTrigger, 1.02);
      assert.match(dryId.orderId, /^DRYRUN-STOP-/);

      process.env.BROKER_DRY_RUN = 'true';
      assert.equal(isBrokerDryRun(), true);
      const flagged = await replaceOptionStopOrder(
        { quantity: 1 },
        {
          existingOrderId: '510288226',
          quantity: 1,
          stopTrigger: 1.02,
          environment: 'live',
          strategy: 'premarket',
        }
      );
      assert.equal(flagged.dryRun, true);
      assert.equal(flagged.resting, true);
      assert.equal(flagged.replacesOrderId, '510288226');
    } finally {
      if (previous === undefined) delete process.env.BROKER_DRY_RUN;
      else process.env.BROKER_DRY_RUN = previous;
    }
  });
});
