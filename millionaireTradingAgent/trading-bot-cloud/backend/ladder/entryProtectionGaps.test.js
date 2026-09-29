/**
 * Regression tests for the entry-protection gaps on baseline 13dab86.
 * These assert the required protection. They are not rewritten to match
 * today's bugs. A failure is the current production behavior.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeOptionOrder } from '../brokerageConnector.js';
import { buildBrokerStopOrderParams, createLadderBrokerStopHandlers, placeLadderBrokerStop, replaceLadderBrokerStop } from './ladderStopOrders.js';
import { handleLadderPositionMonitor, reconcileFilledBrokerStop, submitAndSettleFullClose } from './ladderExit.js';
import { LADDER_CLOSE_REASON } from './ladderConfig.js';
import { bookedEntryQuantity, positionHasConfirmedBrokerLong } from './orderFillStatus.js';
import { maybeSkipUnfilledOpenInsert } from './zeroFillEntry.js';
import {
  buildInitialStopRetryExtras,
  ensureInitialBrokerStopUntilProtected,
  kickInitialStopUntilProtected,
  resetInitialStopRetryStateForTests,
} from './initialStopRetry.js';
import { isFlattenRetryInFlight, resetFlattenUntilClosedStateForTests, shouldKickInitialStop } from './flattenUntilClosed.js';
import { PREMARKET_STOP_LOSS_PCT } from '../premarketBreakout/premarketConfig.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const EXECUTORS = [
  {
    strategy: 'premarket',
    file: 'backend/premarketBreakout/premarketExecutor.js',
    update: 'updatePremarketPositionBrokerStop',
    opens: 'getPremarketOpenPositions',
    close: 'closePremarketPosition',
    telegram: 'sendPremarketTradeClosedTelegram',
  },
  {
    strategy: 'orb',
    file: 'backend/orb/orbExecutor.js',
    update: 'updateOrbPositionBrokerStop',
    opens: 'getOrbOpenPositions',
    close: 'closeOrbPosition',
    telegram: 'sendOrbTradeClosedTelegram',
  },
  {
    strategy: 'emavwap',
    file: 'backend/emaVwapCross/emaVwapExecutor.js',
    update: 'updateEmaVwapPositionBrokerStop',
    opens: 'getEmaVwapOpenPositions',
    close: 'closeEmaVwapPosition',
    telegram: 'sendEmaVwapTradeClosedTelegram',
  },
];

const MONITORS = [
  'backend/premarketBreakout/premarketPositionManager.js',
  'backend/orb/orbPositionManager.js',
  'backend/emaVwapCross/emaVwapPositionManager.js',
];

const OCC = 'SPY   260929P00763000';
const EXPIRATION = '2026-09-29';
const TRIGGER_ID = 'BTO-TRIGGER';
const CHILD_ID = 'STOP-CHILD';

const script = {
  mode: 'idle',
  calls: [],
  deleted: new Set(),
  stopSeq: 0,
};

let realFetch;
let realSetTimeout;
let realDateNow;
let clock = 0;
let fastClock = false;

function jsonResponse(status, body) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return text ? JSON.parse(text) : null; },
  };
}

function orderBody({
  id,
  status = 'Live',
  action = 'Sell to Close',
  quantity = 1,
  remaining = quantity,
  fillPrice = null,
  stopTrigger = null,
}) {
  const fills = fillPrice == null ? [] : [{ 'fill-price': String(fillPrice), quantity: quantity - remaining }];
  return {
    data: {
      id,
      status,
      'stop-trigger': stopTrigger == null ? undefined : String(stopTrigger),
      legs: [{
        'instrument-type': 'Equity Option',
        symbol: OCC,
        action,
        quantity,
        'remaining-quantity': remaining,
        fills,
      }],
    },
  };
}

function chainBody() {
  return {
    data: {
      items: [{
        expirations: [{
          'expiration-date': EXPIRATION,
          strikes: [{
            'strike-price': 763,
            put: OCC,
            'put-bid': 0.98,
            'put-ask': 1.0,
          }],
        }],
      }],
    },
  };
}

function complexBody({ stopId = CHILD_ID, includeStop = true } = {}) {
  return {
    data: {
      'complex-order': {
        id: 'CX-1',
        type: 'OTO',
        'trigger-order': {
          id: TRIGGER_ID,
          'order-type': 'Limit',
          status: 'Filled',
          legs: [{
            'instrument-type': 'Equity Option',
            symbol: OCC,
            action: 'Buy to Open',
            quantity: 1,
            'remaining-quantity': 0,
            fills: [{ 'fill-price': '0.99', quantity: 1 }],
          }],
        },
        orders: includeStop
          ? [{ id: stopId, 'order-type': 'Stop', status: 'Live' }]
          : [],
      },
    },
  };
}

function record(entry) {
  script.calls.push(entry);
}

async function brokerFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const href = String(url);
  let body = null;
  if (options.body) {
    try { body = JSON.parse(options.body); } catch { body = options.body; }
  }

  if (href.includes('/oauth/token')) {
    record({ kind: 'oauth' });
    return jsonResponse(200, { access_token: 'test-access', expires_in: 900 });
  }
  if (href.includes('/option-chains/')) {
    record({ kind: 'chain' });
    return jsonResponse(200, chainBody());
  }
  if (href.includes('/positions')) {
    record({ kind: 'positions' });
    return jsonResponse(500, 'positions unavailable');
  }

  const orderMatch = href.match(/\/orders\/([^/?]+)$/);
  const orderId = orderMatch ? decodeURIComponent(orderMatch[1]) : null;

  if (method === 'DELETE' && orderId) {
    script.deleted.add(orderId);
    record({ kind: 'delete', id: orderId });
    return jsonResponse(204, null);
  }

  if (method === 'GET' && orderId) {
    record({ kind: 'get', id: orderId });
    if (script.mode === 'dead-404' && orderId === 'STOP-DEAD') {
      return jsonResponse(404, 'not found');
    }
    if (script.mode === 'dead-rejected' && orderId === 'STOP-DEAD') {
      return jsonResponse(200, orderBody({ id: orderId, status: 'Rejected', quantity: 1, remaining: 1 }));
    }
    if (script.mode === 'dead-cancelled' && orderId === 'STOP-DEAD') {
      return jsonResponse(200, orderBody({ id: orderId, status: 'Cancelled', quantity: 1, remaining: 1 }));
    }
    if (script.mode === 'get-fails' && String(orderId).startsWith('STOP-NEW')) {
      return jsonResponse(502, 'bad gateway');
    }
    if (orderId === TRIGGER_ID) {
      return jsonResponse(200, orderBody({
        id: orderId,
        status: 'Filled',
        action: 'Buy to Open',
        quantity: 1,
        remaining: 0,
        fillPrice: 0.99,
      }));
    }
    if (orderId === 'BTO-FALLBACK') {
      return jsonResponse(200, orderBody({
        id: orderId,
        status: 'Filled',
        action: 'Buy to Open',
        quantity: 1,
        remaining: 0,
        fillPrice: 1.11,
      }));
    }
    if (orderId === CHILD_ID) {
      if (script.deleted.has(CHILD_ID) && script.mode !== 'cancel-unconfirmed') {
        return jsonResponse(200, orderBody({ id: orderId, status: 'Cancelled', quantity: 1, remaining: 1, stopTrigger: 0.9 }));
      }
      if (script.mode === 'child-filled') {
        return jsonResponse(200, orderBody({
          id: orderId,
          status: 'Filled',
          quantity: 1,
          remaining: 0,
          fillPrice: 0.79,
          stopTrigger: 0.79,
        }));
      }
      const qty = script.mode === 'qty-mismatch' ? 3 : 1;
      return jsonResponse(200, orderBody({
        id: orderId,
        status: 'Live',
        quantity: qty,
        remaining: qty,
        stopTrigger: script.mode === 'cancel-unconfirmed' ? 0.9 : 0.79,
      }));
    }
    if (String(orderId).startsWith('STOP-NEW') || String(orderId).startsWith('STOP-')) {
      return jsonResponse(200, orderBody({
        id: orderId,
        status: 'Live',
        quantity: 1,
        remaining: 1,
        stopTrigger: 0.79,
      }));
    }
    return jsonResponse(200, orderBody({ id: orderId, status: 'Filled', action: 'Buy to Open', quantity: 1, remaining: 0, fillPrice: 0.99 }));
  }

  if (method === 'POST' && href.includes('/complex-orders')) {
    record({ kind: 'oto' });
    if (script.mode === 'missing-stop') return jsonResponse(200, complexBody({ includeStop: false }));
    return jsonResponse(200, complexBody());
  }

  if (method === 'POST' && /\/orders$/.test(href)) {
    const action = body?.legs?.[0]?.action || null;
    const orderType = body?.['order-type'] || null;
    script.stopSeq += 1;
    const id = action === 'Buy to Open' ? 'BTO-FALLBACK' : `STOP-NEW-${script.stopSeq}`;
    record({ kind: 'order', action, orderType, id });
    return jsonResponse(200, { data: { order: { id } } });
  }

  if (method === 'PUT' && orderId) {
    record({ kind: 'put', id: orderId });
    return jsonResponse(200, { data: { order: { id: orderId } } });
  }

  record({ kind: 'other', method, href });
  return jsonResponse(500, `unmocked ${method} ${href}`);
}

function installBroker(mode) {
  script.mode = mode;
  script.calls = [];
  script.deleted = new Set();
  script.stopSeq = 0;
  process.env.TASTYTRADE_SANDBOX_CLIENT_SECRET = 'test-secret';
  process.env.TASTYTRADE_SANDBOX_REFRESH_TOKEN = 'test-refresh';
  process.env.TASTYTRADE_ACCOUNT_NUMBER = '5WZ00000';
  process.env.TASTYTRADE_SANDBOX = 'true';
  delete process.env.BROKER_DRY_RUN;
  realFetch = global.fetch;
  global.fetch = brokerFetch;
}

function restoreBroker() {
  if (realFetch) global.fetch = realFetch;
  realFetch = null;
}

function enableFastClock() {
  clock = Date.now();
  realDateNow = Date.now;
  realSetTimeout = global.setTimeout;
  fastClock = true;
  Date.now = () => clock;
  global.setTimeout = (fn, ms, ...args) => {
    clock += Number(ms) || 0;
    return realSetTimeout(fn, 0, ...args);
  };
}

function disableFastClock() {
  if (!fastClock) return;
  Date.now = realDateNow;
  global.setTimeout = realSetTimeout;
  fastClock = false;
}

function buyPosts() {
  return script.calls.filter((c) => c.kind === 'order' && c.action === 'Buy to Open');
}

function stopPosts() {
  return script.calls.filter((c) => c.kind === 'order' && c.action === 'Sell to Close');
}

function stopParams() {
  return buildBrokerStopOrderParams({
    entry_premium: 0.99,
    quantity: 1,
    contracts_open: 1,
    exit_phase: 'LADDER:0',
    trail_peak_pnl_frac: 0,
  }, { initialStopPct: PREMARKET_STOP_LOSS_PCT });
}

async function submitEntry(strategy) {
  return placeOptionOrder({
    ticker: 'SPY',
    direction: 'PUT',
    strike: 763,
    expiration: EXPIRATION,
    quantity: 1,
    premium: 0.99,
    environment: 'paper',
    strategy,
    initialStop: stopParams(),
  });
}

function executorSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function handoffSlice(src) {
  const start = src.indexOf('if (order.stopOrderId && !order.stopAlignFailed)');
  const end = src.indexOf('\n    console.log(', start);
  assert.ok(start >= 0 && end > start, 'executor stop handoff not found');
  return src.slice(start, end);
}

async function runExecutorHandoff(spec, order, { position, stored, closes, kicks }) {
  const src = executorSource(spec.file);
  const slice = handoffSlice(src);
  const scope = {
    order,
    stopParams: stopParams(),
    positionId: position.id,
    brokerStop: position.brokerStop,
    openedPosition: position,
    environment: 'paper',
    kickInitialStopUntilProtected: (...args) => {
      const promise = kickInitialStopUntilProtected(...args);
      kicks.push(promise);
      return promise;
    },
    buildInitialStopRetryExtras,
    [spec.update]: async (_id, fields) => { stored.push(fields); },
    [spec.opens]: async () => [position],
    [spec.close]: async (...args) => { closes.push(args); },
    [spec.telegram]: async () => {},
  };
  const runner = new Function('scope', 'with (scope) { return (async () => {\n' + slice + '\n})(); }');
  await runner(scope);
  await Promise.all(kicks);
}

function openedPosition(id, orderId) {
  const position = {
    id,
    ticker: 'SPY',
    direction: 'PUT',
    strike: 763,
    expiration: EXPIRATION,
    entry_premium: 0.99,
    quantity: 1,
    contracts_open: 1,
    order_id: orderId,
    exit_phase: 'LADDER:0',
    trail_peak_pnl_frac: 0,
    broker_stop_order_id: null,
  };
  position.brokerStop = createLadderBrokerStopHandlers({
    strategy: 'premarket',
    environment: 'paper',
    initialStopPct: 0.2,
    hardStopPct: 0.25,
    updateBrokerStopState: async () => {},
    fullClosePosition: async () => {},
  });
  return position;
}

afterEach(() => {
  disableFastClock();
  restoreBroker();
  resetInitialStopRetryStateForTests();
  resetFlattenUntilClosedStateForTests();
});

describe('Test 1 — OTO fallback cannot create a second BUY', () => {
  for (const spec of EXECUTORS) {
    it(`${spec.strategy} keeps the filled OTO trigger and does not submit another Buy to Open`, async () => {
      installBroker('missing-stop');
      enableFastClock();
      const postsBefore = () => buyPosts();
      let order;
      try {
        order = await submitEntry(spec.strategy);
      } catch (err) {
        assert.fail(`placeOptionOrder threw instead of keeping the filled OTO entry: ${err.message}`);
      }
      const bookedQty = bookedEntryQuantity({
        requestedQuantity: 1,
        fillQuantity: order.fillQuantity,
      });
      const skip = await maybeSkipUnfilledOpenInsert({
        order,
        bookedQty,
        environment: 'paper',
        strategy: spec.strategy,
        ticker: 'SPY',
        direction: 'PUT',
        logEvent: async () => {},
        cancelOrder: async () => ({ cancelled: true }),
      });
      const stored = [];
      const closes = [];
      const kicks = [];
      const position = openedPosition(101 + EXECUTORS.indexOf(spec), order.orderId);
      if (!skip.skipped) {
        await runExecutorHandoff(spec, order, { position, stored, closes, kicks });
      }
      assert.equal(
        postsBefore().length,
        0,
        `${spec.strategy} submitted another Buy to Open after the OTO was accepted: ${JSON.stringify(script.calls)}`
      );
      assert.equal(skip.skipped, false, `${spec.strategy} did not book the filled OTO entry`);
      assert.equal(order.orderId, TRIGGER_ID, `booked order id ${order.orderId} is not the filled OTO trigger`);
      assert.equal(order.fillQuantity, 1);
      assert.equal(order.fillPrice, 0.99);
    });
  }
});

describe('Test 2 — child already filled cannot trigger another protective sell', () => {
  for (const spec of EXECUTORS) {
    it(`${spec.strategy} does not sell again and reconciles the filled child`, async () => {
      installBroker('child-filled');
      enableFastClock();
      const order = await submitEntry(spec.strategy);
      assert.equal(order.stopAlignReason, 'child_already_filled');
      const stored = [];
      const closes = [];
      const kicks = [];
      const position = openedPosition(201 + EXECUTORS.indexOf(spec), order.orderId);
      await runExecutorHandoff(spec, order, { position, stored, closes, kicks });
      assert.equal(
        stopPosts().length,
        0,
        `${spec.strategy} submitted ${stopPosts().length} protective sell(s) after child_already_filled: ${JSON.stringify(stopPosts())}`
      );
      assert.equal(
        script.calls.filter((c) => c.kind === 'order' && c.orderType !== 'Stop').length,
        0,
        `${spec.strategy} submitted a second Sell to Close`
      );
      assert.ok(
        closes.length >= 1,
        `${spec.strategy} left the filled child unreconciled (closes=${closes.length}, kicks=${kicks.length}, stored=${JSON.stringify(stored)})`
      );
    });
  }
});

describe('Test 3 — cancel unconfirmed cannot create a second stop', () => {
  for (const spec of EXECUTORS) {
    it(`${spec.strategy} keeps the live child when cancel is unconfirmed`, async () => {
      installBroker('cancel-unconfirmed');
      enableFastClock();
      const order = await submitEntry(spec.strategy);
      const stored = [];
      const closes = [];
      const kicks = [];
      const position = openedPosition(301 + EXECUTORS.indexOf(spec), order.orderId);
      await runExecutorHandoff(spec, order, { position, stored, closes, kicks });
      assert.equal(
        stopPosts().length,
        0,
        `${spec.strategy} submitted a second stop while cancel was unconfirmed: ${JSON.stringify(stopPosts())}; ` +
          `returnedStop=${order.stopOrderId} reason=${order.stopAlignReason} stored=${JSON.stringify(stored)}`
      );
      assert.equal(
        stored.at(-1)?.broker_stop_order_id,
        CHILD_ID,
        `${spec.strategy} discarded child ${CHILD_ID}; stored=${JSON.stringify(stored)} returnedStop=${order.stopOrderId}`
      );
    });
  }
});

describe('Test 4 — accepted stop with failed GET cannot create a duplicate stop', () => {
  it('OTO alignment does not submit another stop when the accepted stop GET fails', async () => {
    installBroker('get-fails');
    script.mode = 'qty-mismatch';
    enableFastClock();
    const getFails = script;
    getFails.mode = 'qty-mismatch';
    const orderPromise = (async () => {
      const original = global.fetch;
      global.fetch = async (url, options) => {
        const href = String(url);
        const method = String(options?.method || 'GET').toUpperCase();
        if (method === 'GET' && /\/orders\/STOP-NEW-/.test(href)) {
          script.mode = 'get-fails';
        }
        const res = await brokerFetch(url, options);
        if (method === 'GET' && /\/orders\/STOP-NEW-/.test(href)) {
          script.mode = 'qty-mismatch';
        }
        return res;
      };
      try {
        return await submitEntry('premarket');
      } finally {
        global.fetch = original;
      }
    })();
    const order = await orderPromise;
    assert.equal(
      stopPosts().length,
      1,
      `OTO alignment submitted ${stopPosts().length} stops after a successful POST whose GET failed; order=${JSON.stringify({ stopOrderId: order.stopOrderId, reason: order.stopAlignReason })} posts=${JSON.stringify(stopPosts())}`
    );
  });

  it('placeLadderBrokerStop does not submit another stop when the accepted stop GET fails', async () => {
    installBroker('get-fails');
    enableFastClock();
    const writes = [];
    const position = {
      id: 420,
      ticker: 'SPY',
      direction: 'PUT',
      strike: 763,
      expiration: EXPIRATION,
      entry_premium: 0.99,
      quantity: 1,
      contracts_open: 1,
      exit_phase: 'LADDER:0',
      broker_stop_order_id: null,
    };
    const once = await placeLadderBrokerStop(position, {
      strategy: 'premarket',
      environment: 'paper',
      initialStopPct: 0.2,
      updateBrokerStopState: async (_id, fields) => { writes.push(fields); },
    });
    const acceptedId = stopPosts()[0]?.id || null;
    const afterSinglePlace = stopPosts().length;

    const retryPosition = { ...position, id: 421, broker_stop_order_id: null };
    await ensureInitialBrokerStopUntilProtected(retryPosition, {
      strategy: 'premarket',
      environment: 'paper',
      placeStop: (row) => placeLadderBrokerStop(row, {
        strategy: 'premarket',
        environment: 'paper',
        initialStopPct: 0.2,
        updateBrokerStopState: async () => {},
      }),
      getOpenPosition: async () => (stopPosts().length >= 2 ? null : { ...retryPosition, broker_stop_order_id: null }),
      sleep: async () => {},
      now: () => clock,
      isBrokerStillLong: async () => true,
    });
    assert.equal(
      stopPosts().length,
      1,
      `stops posted=${stopPosts().length} (single placeLadderBrokerStop posted ${afterSinglePlace}); ` +
        `accepted=${acceptedId} retained=${writes[0]?.broker_stop_order_id || 'no'} ` +
        `placed=${once.placed} reason=${once.reason} writes=${JSON.stringify(writes)} ` +
        `posts=${JSON.stringify(stopPosts())}`
    );
  });
});

describe('Test 5 — hard stop must not race an active ratchet replacement', () => {
  it('does not submit a close while the ratchet PUT is still in flight', async () => {
    const position = {
      id: 120,
      ticker: 'SPY',
      direction: 'PUT',
      strike: 763,
      expiration: EXPIRATION,
      entry_premium: 0.99,
      quantity: 1,
      contracts_open: 1,
      exit_phase: 'LADDER:0',
      broker_stop_order_id: 'STOP-WORKING',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
    };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let putFinished = false;
    const orders = [];
    const replacePromise = replaceLadderBrokerStop(position, {
      strategy: 'premarket',
      environment: 'paper',
      initialStopPct: 0.2,
      stopPnlFrac: 0.03,
      replaceStopOrder: async () => {
        orders.push({ type: 'ratchet-put', id: 'STOP-WORKING' });
        await gate;
        putFinished = true;
        return { resting: true, orderId: 'STOP-REPLACED', stopTrigger: 1.02, replaced: true };
      },
      placeStop: async () => {
        orders.push({ type: 'second-stop' });
        return { placed: false, reason: 'must_not_place' };
      },
    });
    await Promise.resolve();
    try {
      await submitAndSettleFullClose({
        position,
        closeQty: 1,
        currentPremium: 0.7,
        pnlFrac: (0.7 - 0.99) / 0.99,
        intendedReason: LADDER_CLOSE_REASON.HARD_STOP,
        hardStopPct: 0.25,
        brokerStop: {
          enabled: true,
          async cancelStop(pos) {
            orders.push({ type: 'cancel', id: pos.broker_stop_order_id, putFinished });
            return { cancelled: false, reason: 'replace_in_flight' };
          },
        },
        closeBrokerOrder: async () => {
          orders.push({ type: 'hard-stop-stc', putFinished, stopId: position.broker_stop_order_id });
          return { orderId: 'STC-HARD', filled: true, fillPrice: 0.74 };
        },
        fullClosePosition: async () => { orders.push({ type: 'book' }); },
        updatePendingClose: async () => {},
      });
      const raced = orders.some((o) => o.type === 'hard-stop-stc') && putFinished === false;
      assert.equal(
        raced,
        false,
        `hard stop created a second close while the ratchet PUT was in flight: ${JSON.stringify(orders)} stopId=${position.broker_stop_order_id}`
      );
      assert.equal(position.broker_stop_order_id, 'STOP-WORKING');
    } finally {
      release();
      await replacePromise.catch(() => {});
    }
  });
});

describe('Test 6 — dead broker stop after restart must be detected', () => {
  for (const rel of MONITORS) {
    it(`${rel} runs shouldKickInitialStop before reconcileFilledBrokerStop`, () => {
      const src = executorSource(rel);
      const kick = src.indexOf('shouldKickInitialStop({');
      const recon = src.indexOf('reconcileFilledBrokerStop(position');
      assert.ok(kick > 0 && recon > kick, `${rel} does not kick before reconciling the stored stop`);
    });
  }

  for (const status of ['rejected', 'cancelled', '404']) {
    it(`a ${status} broker stop is not treated as protection`, async () => {
      installBroker(status === '404' ? 'dead-404' : `dead-${status}`);
      enableFastClock();
      const position = {
        id: 610,
        ticker: 'SPY',
        direction: 'PUT',
        strike: 763,
        expiration: EXPIRATION,
        entry_premium: 0.99,
        quantity: 1,
        contracts_open: 1,
        order_id: TRIGGER_ID,
        exit_phase: 'LADDER:0',
        mfe_pct: 0,
        mae_pct: 0,
        broker_stop_order_id: 'STOP-DEAD',
        broker_stop_trigger_price: 0.79,
        broker_stop_pnl_frac: -0.2,
        pending_close_reason: null,
        entry_metadata_json: JSON.stringify({ fill_quantity: 1 }),
      };
      const closes = [];
      const brokerStop = createLadderBrokerStopHandlers({
        strategy: 'premarket',
        environment: 'paper',
        initialStopPct: 0.2,
        hardStopPct: 0.25,
        updateBrokerStopState: async (_id, fields) => { Object.assign(position, fields); },
        fullClosePosition: async (_id, _px, _pct, reason) => { closes.push(reason); },
      });
      const kickStarted = shouldKickInitialStop({
        brokerStopOrderId: position.broker_stop_order_id,
        pendingCloseReason: position.pending_close_reason,
        isTimeStop: false,
        flattenInFlight: isFlattenRetryInFlight(position.id),
      }) && positionHasConfirmedBrokerLong(position);

      let reconcileError = null;
      try {
        await reconcileFilledBrokerStop(position, brokerStop);
      } catch (err) {
        reconcileError = err;
      }

      let ladderError = null;
      try {
        await handleLadderPositionMonitor(position, {
          currentPremium: 0.77,
          initialStopPct: 0.2,
          hardStopPct: 0.25,
          fullPositionExits: true,
          updateExcursion: async () => {},
          updateLadderState: async () => {},
          partialCloseLeg: async () => {},
          fullClosePosition: async (_id, _px, _pct, reason) => { closes.push(reason); },
          closeBrokerOrder: async (_pos, price) => ({ orderId: 'STC-SOFT', filled: true, fillPrice: price }),
          flattenBrokerOrder: async () => ({ filled: false }),
          brokerStop,
          updatePendingClose: async () => {},
          getOpenPosition: async () => null,
        });
      } catch (err) {
        ladderError = err;
      }

      assert.equal(
        position.broker_stop_order_id,
        null,
        `stored id ${position.broker_stop_order_id} still counted as protection after ${status} ` +
          `(kickStarted=${kickStarted} closes=${JSON.stringify(closes)} ` +
          `reconcile=${reconcileError?.message || 'ok'} ladder=${ladderError?.message || 'ok'})`
      );
      assert.ok(
        closes.includes(LADDER_CLOSE_REASON.STOP_LOSS),
        `−20% poll did not run after the ${status} stop was recognized; closes=${JSON.stringify(closes)}`
      );
    });
  }
});

describe('Test 7 — hard-stop cancel must be confirmed', () => {
  it('does not submit the hard-stop close when protective-stop cancel is unconfirmed', async () => {
    const position = {
      id: 70,
      ticker: 'SPY',
      direction: 'PUT',
      strike: 763,
      expiration: EXPIRATION,
      entry_premium: 0.99,
      quantity: 1,
      contracts_open: 1,
      exit_phase: 'LADDER:0',
      broker_stop_order_id: 'STOP-WORKING',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
    };
    let stcCalled = false;
    let stopIdAtClose = null;
    const cancel = { cancelled: false, reason: 'cancel_unconfirmed' };
    await submitAndSettleFullClose({
      position,
      closeQty: 1,
      currentPremium: 0.7,
      pnlFrac: (0.7 - 0.99) / 0.99,
      intendedReason: LADDER_CLOSE_REASON.HARD_STOP,
      hardStopPct: 0.25,
      brokerStop: {
        enabled: true,
        async cancelStop() { return cancel; },
      },
      closeBrokerOrder: async () => {
        stcCalled = true;
        stopIdAtClose = position.broker_stop_order_id;
        return { orderId: 'STC-HARD', filled: true, fillPrice: 0.74 };
      },
      fullClosePosition: async () => {},
      updatePendingClose: async () => {},
    });
    assert.equal(
      stcCalled,
      false,
      `hard-stop close was submitted while cancel was ${cancel.reason}; in-memory stop id at submit=${stopIdAtClose}; stored id now=${position.broker_stop_order_id}`
    );
    assert.equal(position.broker_stop_order_id, 'STOP-WORKING');
  });
});
