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
import { LADDER_CLOSE_REASON } from './ladderConfig.js';

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

  it('unchanged without hardStopPct (ORB/EMA default)', () => {
    assert.equal(resolveBrokerStopCloseReason(-0.1243, null), LADDER_CLOSE_REASON.STOP_LOSS);
    assert.equal(resolveBrokerStopCloseReason(0.2, null), LADDER_CLOSE_REASON.TRAILING_STOP);
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

  it('falls back to cancel-verify-place and refuses to POST while the old stop is still working', async () => {
    const calls = [];
    const result = await replaceLadderBrokerStop(pos(), {
      strategy: 'orb',
      environment: 'live',
      initialStopPct: 0.0175,
      stopPnlFrac: 0.038,
      replaceStopOrder: async () => {
        calls.push('put');
        return { resting: false, reason: 'not_resting' };
      },
      cancelStop: async () => {
        calls.push('cancel');
        return { cancelled: true };
      },
      verifyTerminated: async () => {
        calls.push('verify');
        return { terminated: false, reason: 'still_working' };
      },
      placeStop: async () => {
        calls.push('place');
        return { placed: true, orderId: 'bad' };
      },
    });
    assert.equal(result.placed, false);
    assert.equal(result.reason, 'still_working');
    assert.deepEqual(calls, ['put', 'cancel', 'verify']);
  });

  it('writes position_unprotected_no_resting_stop when place and restore both fail', async () => {
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
      verifyTerminated: async () => ({ terminated: true }),
      placeStop: async () => ({ placed: false, reason: 'uncovered' }),
    });
    assert.equal(result.placed, false);
    assert.equal(result.unprotected, true);
    assert.equal(result.reason, POSITION_UNPROTECTED_NO_RESTING_STOP);
    assert.equal(position.broker_stop_order_id, null);
  });

  it('wires PUT /accounts/{id}/orders/{orderId} without a prior DELETE', () => {
    assert.match(connectorSrc, /method: 'PUT'/);
    assert.match(connectorSrc, /tastytradeReplaceStopOrderWithCredentials/);
    assert.match(connectorSrc, /includeLegs: false/);
    const replaceFn = src.slice(src.indexOf('export async function replaceLadderBrokerStop'));
    const putIdx = replaceFn.indexOf('replaceStopOrder');
    const cancelIdx = replaceFn.indexOf('cancelStop(position');
    assert.ok(putIdx > 0 && putIdx < cancelIdx, 'PUT replace must run before cancel fallback');
  });
});
