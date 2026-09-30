/**
 * Production-path concurrency for one strategy:positionId stop book.
 * These call the real kick, ratchet, reconcile, and loss-exit functions.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLadderBrokerStopHandlers, placeLadderBrokerStop, replaceLadderBrokerStop } from './ladderStopOrders.js';
import { handleLadderPositionMonitor, reconcileFilledBrokerStop, submitAndSettleFullClose } from './ladderExit.js';
import { ensureInitialBrokerStopUntilProtected, resetInitialStopRetryStateForTests } from './initialStopRetry.js';
import {
  STOP_STATE,
  beginInitialStop,
  beginStopReplace,
  endInitialStop,
  finishStopReplace,
  forgetUnconfirmedStop,
  isBrokerStopMutationInFlight,
  isCancelInFlight,
  isExitRequested,
  isInitialStopInFlight,
  isReplaceInFlight,
  lookupUnconfirmedStop,
  releaseStopBookIfIdle,
  rememberUnconfirmedStop,
  requestStopExit,
} from './stopBook.js';

const OCC = 'SPY   260929P00763000';
const EXPIRATION = '2026-09-29';
const releases = [];
const leaks = [];
let realFetch = null;
const envKeys = [
  'TASTYTRADE_SANDBOX_CLIENT_SECRET',
  'TASTYTRADE_SANDBOX_REFRESH_TOKEN',
  'TASTYTRADE_ACCOUNT_NUMBER',
  'TASTYTRADE_SANDBOX',
  'BROKER_DRY_RUN',
];
const savedEnv = new Map();

function openPosition(overrides = {}) {
  return {
    id: 5,
    ticker: 'SPY',
    direction: 'PUT',
    strike: 763,
    expiration: EXPIRATION,
    option_symbol: OCC,
    entry_premium: 0.99,
    quantity: 1,
    contracts_open: 1,
    exit_phase: 'LADDER:0',
    mfe_pct: 0,
    mae_pct: 0,
    trail_peak_pnl_frac: 0,
    broker_stop_order_id: null,
    broker_stop_trigger_price: null,
    broker_stop_pnl_frac: null,
    pending_close_reason: null,
    entry_metadata_json: JSON.stringify({ fill_quantity: 1 }),
    ...overrides,
  };
}

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  const finish = () => release();
  releases.push(finish);
  return { promise, release: finish };
}

async function flushUntil(predicate) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.equal(predicate(), true);
}

function withDeadline(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadlocked`)), 1000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function monitorArgs(position, { currentPremium, orders, strategy }) {
  return {
    currentPremium,
    initialStopPct: 0.2,
    hardStopPct: 0.25,
    fullPositionExits: true,
    strategy,
    updateExcursion: async () => {},
    updateLadderState: async () => {},
    partialCloseLeg: async () => {},
    fullClosePosition: async (_id, _px, _pct, reason) => {
      orders.push({ type: 'book', reason });
    },
    closeBrokerOrder: async () => {
      orders.push({ type: 'stc' });
      return { orderId: 'STC-LOSS', filled: true, fillPrice: currentPremium };
    },
    flattenBrokerOrder: async () => {
      orders.push({ type: 'flatten' });
      return { filled: false };
    },
    brokerStop: {
      enabled: true,
      strategy,
      async checkFill() {
        return { filled: false };
      },
      async cancelStop() {
        orders.push({ type: 'cancel', id: position.broker_stop_order_id });
        return { cancelled: false, reason: 'stop_mutation_in_flight' };
      },
    },
    updatePendingClose: async () => {},
    getOpenPosition: async () => ({ ...position }),
  };
}

async function lossWhileInitialStopInFlight(position, premium) {
  const orders = [];
  const held = gate();
  let postStarted = false;
  const kick = ensureInitialBrokerStopUntilProtected(position, {
    strategy: 'premarket',
    environment: 'paper',
    placeStop: async () => {
      postStarted = true;
      await held.promise;
      return {
        placed: true,
        orderId: 'STOP-INITIAL',
        resting: true,
        stopTrigger: 0.79,
        stopPnlFrac: -0.2,
      };
    },
    getOpenPosition: async () => ({ ...position, broker_stop_order_id: null }),
    sleep: async () => {},
  });
  leaks.push(kick);
  assert.equal(isInitialStopInFlight('premarket', position.id), true);
  await flushUntil(() => postStarted);
  const result = await withDeadline(
    handleLadderPositionMonitor(position, monitorArgs(position, {
      currentPremium: premium,
      orders,
      strategy: 'premarket',
    })),
    'loss exit'
  );
  assert.equal(orders.some((order) => order.type === 'stc' || order.type === 'flatten' || order.type === 'book'), false);
  assert.equal(isExitRequested('premarket', position.id), true);
  assert.equal(isInitialStopInFlight('premarket', position.id), true);
  assert.equal(isReplaceInFlight('premarket', position.id), false);
  assert.equal(isCancelInFlight('premarket', position.id), false);
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'stop_mutation_in_flight');
  held.release();
  await kick;
  return { orders, result };
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(leaks.splice(0).map((pending) => Promise.resolve(pending).catch(() => {})));
  resetInitialStopRetryStateForTests();
  if (realFetch) {
    global.fetch = realFetch;
    realFetch = null;
  }
  for (const key of envKeys) {
    if (savedEnv.has(key)) {
      const value = savedEnv.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
  savedEnv.clear();
});

describe('Test A — initial-stop POST in flight, then −25% hard stop', () => {
  it('sets exit ownership and does not sell or wait', async () => {
    await lossWhileInitialStopInFlight(openPosition({ id: 801 }), 0.7);
  });
});

describe('Test B — initial-stop POST in flight, then −20% loss exit', () => {
  it('sets exit ownership and does not sell or wait', async () => {
    await lossWhileInitialStopInFlight(openPosition({ id: 802 }), 0.79);
  });
});

describe('Test C — premarket and ORB positions do not share stop-book state', () => {
  it('keeps exit and replace flags on the exact strategy:positionId', () => {
    requestStopExit('premarket', 5);
    assert.equal(beginStopReplace('orb', 5), true);
    assert.equal(beginStopReplace('premarket', 15), true);

    assert.equal(isExitRequested('premarket', 5), true);
    assert.equal(isReplaceInFlight('premarket', 5), false);
    assert.equal(isExitRequested('orb', 5), false);
    assert.equal(isReplaceInFlight('orb', 5), true);
    assert.equal(isExitRequested('premarket', 15), false);
    assert.equal(isReplaceInFlight('premarket', 15), true);
    assert.equal(isInitialStopInFlight('orb', 5), false);
    assert.equal(isCancelInFlight('premarket', 5), false);

    finishStopReplace('orb', 5);
    finishStopReplace('premarket', 15);
  });
});

describe('Test D — stop-book cleanup waits until the position is flat and idle', () => {
  it('keeps the record while a mutation is in flight, then removes it once idle', () => {
    assert.equal(beginInitialStop('premarket', 8), true);
    assert.equal(releaseStopBookIfIdle('premarket', 8), false);
    assert.equal(isInitialStopInFlight('premarket', 8), true);

    endInitialStop('premarket', 8);
    assert.equal(isInitialStopInFlight('premarket', 8), false);
    assert.equal(isReplaceInFlight('premarket', 8), false);
    assert.equal(isCancelInFlight('premarket', 8), false);
    assert.equal(isBrokerStopMutationInFlight('premarket', 8), false);

    assert.equal(releaseStopBookIfIdle('premarket', 8), true);
    assert.equal(isInitialStopInFlight('premarket', 8), false);
    assert.equal(releaseStopBookIfIdle('premarket', 8), false);
  });
});

describe('Test E — a ratchet after exitRequested makes no broker mutation', () => {
  it('does not PUT an existing stop or POST when there is no prior id', async () => {
    requestStopExit('premarket', 900);
    const calls = [];
    const broker = {
      environment: 'paper',
      initialStopPct: 0.2,
      stopPnlFrac: 0.03,
      replaceStopOrder: async () => {
        calls.push('put');
        return { resting: true, orderId: 'STOP-NEW', replaced: true };
      },
      placeStop: async () => {
        calls.push('post');
        return { placed: true, orderId: 'STOP-NEW', resting: true };
      },
    };

    const withStop = openPosition({
      id: 900,
      broker_stop_order_id: 'STOP-OLD',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
    });
    const replaced = await replaceLadderBrokerStop(withStop, {
      strategy: 'premarket',
      ...broker,
    });
    assert.equal(replaced.reason, 'exit_requested');
    assert.equal(withStop.broker_stop_order_id, 'STOP-OLD');

    const withoutStop = openPosition({ id: 900, broker_stop_order_id: null });
    const posted = await replaceLadderBrokerStop(withoutStop, {
      strategy: 'premarket',
      ...broker,
    });
    assert.equal(posted.reason, 'exit_requested');
    assert.equal(withoutStop.broker_stop_order_id, null);
    assert.deepEqual(calls, []);
  });
});

describe('Test F — no-prior-id POST does not adopt after an exit', () => {
  async function blockNoPriorPost(position) {
    const orders = [];
    const held = gate();
    let postStarted = false;
    const writes = [];
    const replacePromise = replaceLadderBrokerStop(position, {
      strategy: 'premarket',
      environment: 'paper',
      initialStopPct: 0.2,
      stopPnlFrac: 0.03,
      updateBrokerStopState: async (_id, fields) => {
        writes.push({ ...fields });
        Object.assign(position, fields);
      },
      replaceStopOrder: async () => {
        orders.push({ type: 'put' });
        return { resting: true, orderId: 'STOP-PUT' };
      },
      placeStop: async (row, opts) => {
        postStarted = true;
        await held.promise;
        const orderId = 'STOP-NEW';
        row.broker_stop_order_id = orderId;
        row.broker_stop_trigger_price = 1.02;
        row.broker_stop_pnl_frac = 0.03;
        if (opts.updateBrokerStopState) {
          await opts.updateBrokerStopState(row.id, {
            broker_stop_order_id: orderId,
            broker_stop_trigger_price: 1.02,
            broker_stop_pnl_frac: 0.03,
          });
        }
        return {
          placed: true,
          orderId,
          resting: true,
          stopTrigger: 1.02,
          stopPnlFrac: 0.03,
        };
      },
    });
    leaks.push(replacePromise);
    await flushUntil(() => postStarted && isReplaceInFlight('premarket', position.id));
    const during = await withDeadline(
      handleLadderPositionMonitor(position, monitorArgs(position, {
        currentPremium: 0.7,
        orders,
        strategy: 'premarket',
      })),
      'hard stop during POST'
    );
    assert.equal(isReplaceInFlight('premarket', position.id), true);
    assert.equal(isExitRequested('premarket', position.id), true);
    assert.equal(during.deferred, true);
    assert.equal(orders.some((order) => order.type === 'stc' || order.type === 'cancel'), false);
    held.release();
    const replaced = await replacePromise;
    return { orders, writes, replaced };
  }

  it('leaves the new id unadopted and lets reconciliation classify UNKNOWN', async () => {
    const position = openPosition({ id: 860, broker_stop_order_id: null });
    const { writes, replaced } = await blockNoPriorPost(position);
    assert.equal(replaced.adopted, false);
    assert.equal(replaced.reason, 'exit_requested_during_replace');
    assert.equal(position.broker_stop_order_id, null);
    assert.equal(writes.at(-1)?.broker_stop_order_id ?? null, null);
    const pending = lookupUnconfirmedStop('premarket', position);
    assert.equal(pending?.orderId, 'STOP-NEW');
    assert.equal(pending?.state, STOP_STATE.PLACED_UNCONFIRMED);

    const seen = [];
    const brokerStop = {
      enabled: true,
      strategy: 'premarket',
      async checkFill(row) {
        seen.push(row.broker_stop_order_id);
        return { filled: false, unknown: true, stopProtectionState: STOP_STATE.UNKNOWN };
      },
      async cancelStop() {
        seen.push('cancel');
        return { cancelled: true };
      },
    };
    const reconciled = await reconcileFilledBrokerStop(position, brokerStop);
    assert.equal(reconciled.unknown, true);
    assert.deepEqual(seen, ['STOP-NEW']);
    assert.equal(position.broker_stop_order_id, null);
    assert.equal(lookupUnconfirmedStop('premarket', position)?.state, STOP_STATE.UNKNOWN);

    const orders = [];
    const again = await handleLadderPositionMonitor(position, {
      ...monitorArgs(position, { currentPremium: 0.7, orders, strategy: 'premarket' }),
      brokerStop,
    });
    assert.equal(again.reason, 'stop_status_unknown');
    assert.equal(orders.some((order) => order.type === 'stc'), false);
    assert.equal(position.broker_stop_order_id, null);
    assert.equal(seen.includes('cancel'), false);
  });

  it('keeps a resting broker order only after reconciliation reads it', async () => {
    const position = openPosition({ id: 861, broker_stop_order_id: null });
    const writes = [];
    position.broker_stop_order_id = null;
    const { replaced } = await blockNoPriorPost(position);
    assert.equal(replaced.adopted, false);
    assert.equal(position.broker_stop_order_id, null);

    const seen = [];
    const brokerStop = {
      enabled: true,
      strategy: 'premarket',
      async checkFill(row) {
        seen.push(row.broker_stop_order_id);
        return { filled: false, status: { isTerminal: false, isFilled: false, status: 'live' } };
      },
      async noteReconciledStop(row) {
        writes.push(row.broker_stop_order_id);
      },
      async cancelStop() {
        seen.push(`cancel:${rowId(position)}`);
        return { cancelled: false, reason: 'cancel_unconfirmed' };
      },
    };
    await reconcileFilledBrokerStop(position, brokerStop);
    assert.deepEqual(seen, ['STOP-NEW']);
    assert.equal(position.broker_stop_order_id, 'STOP-NEW');
    assert.deepEqual(writes, ['STOP-NEW']);
    assert.equal(lookupUnconfirmedStop('premarket', position), null);

    const orders = [];
    const follow = await handleLadderPositionMonitor(position, {
      ...monitorArgs(position, { currentPremium: 0.7, orders, strategy: 'premarket' }),
      brokerStop: {
        ...brokerStop,
        async checkFill() {
          return { filled: false, status: { isTerminal: false, isFilled: false, status: 'live' } };
        },
      },
    });
    assert.equal(follow.deferred, true);
    assert.equal(orders.some((order) => order.type === 'stc'), false);
    assert.equal(position.broker_stop_order_id, 'STOP-NEW');
  });
});

function rowId(position) {
  return position.broker_stop_order_id;
}

describe('Test G — same option contract, different strategy positions', () => {
  it('does not inherit or erase another position unconfirmed stop', async () => {
    delete process.env.TASTYTRADE_SANDBOX_CLIENT_SECRET;
    delete process.env.TASTYTRADE_SANDBOX_REFRESH_TOKEN;
    delete process.env.TASTYTRADE_ACCOUNT_NUMBER;
    const contract = {
      ticker: 'SPY',
      direction: 'PUT',
      strike: 763,
      expiration: EXPIRATION,
      option_symbol: OCC,
    };
    const premarket = openPosition({ ...contract, id: 5 });
    const orb = openPosition({ ...contract, id: 5 });
    rememberUnconfirmedStop('premarket', premarket, 'STOP-PRE', STOP_STATE.PLACED_UNCONFIRMED);

    assert.equal(lookupUnconfirmedStop('orb', orb), null);
    assert.equal(lookupUnconfirmedStop('premarket', premarket)?.orderId, 'STOP-PRE');

    const writes = [];
    const placed = await placeLadderBrokerStop(orb, {
      strategy: 'orb',
      environment: 'paper',
      initialStopPct: 0.2,
      updateBrokerStopState: async (_id, fields) => {
        writes.push(fields.broker_stop_order_id);
      },
    });
    assert.equal(placed.placed, true);
    assert.equal(String(placed.orderId).startsWith('PAPER-STOP-'), true);
    assert.equal(writes.includes('STOP-PRE'), false);
    assert.equal(lookupUnconfirmedStop('premarket', premarket)?.orderId, 'STOP-PRE');
    assert.notEqual(lookupUnconfirmedStop('orb', orb)?.orderId, 'STOP-PRE');

    rememberUnconfirmedStop('orb', orb, 'STOP-ORB', STOP_STATE.UNKNOWN);
    forgetUnconfirmedStop('premarket', premarket, 'STOP-PRE');
    assert.equal(lookupUnconfirmedStop('premarket', premarket), null);
    assert.equal(lookupUnconfirmedStop('orb', orb)?.orderId, 'STOP-ORB');
    assert.equal(lookupUnconfirmedStop('orb', orb)?.state, STOP_STATE.UNKNOWN);
  });
});

function jsonResponse(status, body) {
  const text = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return text ? JSON.parse(text) : null; },
  };
}

function orderBody(id, status) {
  return {
    data: {
      id,
      status,
      'stop-trigger': '0.79',
      legs: [{
        'instrument-type': 'Equity Option',
        symbol: OCC,
        action: 'Sell to Close',
        quantity: 1,
        'remaining-quantity': status === 'Filled' ? 0 : 1,
        fills: status === 'Filled' ? [{ 'fill-price': '0.79', quantity: 1 }] : [],
      }],
    },
  };
}

function installOrderFetch(statusFor) {
  for (const key of envKeys) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  process.env.TASTYTRADE_SANDBOX_CLIENT_SECRET = 'test-secret';
  process.env.TASTYTRADE_SANDBOX_REFRESH_TOKEN = 'test-refresh';
  process.env.TASTYTRADE_ACCOUNT_NUMBER = '5WZ00000';
  process.env.TASTYTRADE_SANDBOX = 'true';
  delete process.env.BROKER_DRY_RUN;
  const calls = [];
  realFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    const href = String(url);
    calls.push({ method, href });
    if (href.includes('/oauth/token')) {
      return jsonResponse(200, { access_token: 'test-access', expires_in: 900 });
    }
    const orderMatch = href.match(/\/orders\/([^/?]+)$/);
    if (method === 'GET' && orderMatch) {
      const id = decodeURIComponent(orderMatch[1]);
      const outcome = statusFor(id);
      if (outcome === 502) return jsonResponse(502, 'bad gateway');
      if (outcome === 404) return jsonResponse(404, 'not found');
      return jsonResponse(200, orderBody(id, 'Live'));
    }
    if (method === 'POST' && /\/orders$/.test(href)) {
      return jsonResponse(200, { data: { order: { id: 'STOP-DUPLICATE' } } });
    }
    return jsonResponse(500, `unmocked ${method} ${href}`);
  };
  return calls;
}

function orderGets(calls, id) {
  return calls.filter((call) => call.method === 'GET' && call.href.includes(`/orders/${id}`));
}

function orderPosts(calls) {
  return calls.filter((call) => call.method === 'POST' && /\/orders$/.test(call.href));
}

async function restartMonitor(position, statusFor) {
  const calls = installOrderFetch(statusFor);
  const closes = [];
  const sells = [];
  const brokerStop = createLadderBrokerStopHandlers({
    strategy: 'premarket',
    environment: 'paper',
    initialStopPct: 0.2,
    hardStopPct: 0.25,
    updateBrokerStopState: async (_id, fields) => {
      Object.assign(position, fields);
    },
    fullClosePosition: async (_id, _px, _pct, reason) => {
      closes.push(reason);
    },
  });
  const result = await handleLadderPositionMonitor(position, {
    currentPremium: position.currentPremium,
    initialStopPct: 0.2,
    hardStopPct: 0.25,
    fullPositionExits: true,
    strategy: 'premarket',
    updateExcursion: async () => {},
    updateLadderState: async () => {},
    partialCloseLeg: async () => {},
    fullClosePosition: async (_id, _px, _pct, reason) => {
      closes.push(reason);
    },
    closeBrokerOrder: async (_pos, price) => {
      sells.push(price);
      return { orderId: 'STC-RESTART', filled: true, fillPrice: price };
    },
    flattenBrokerOrder: async () => ({ filled: false }),
    brokerStop,
    updatePendingClose: async () => {},
    getOpenPosition: async () => null,
  });
  return { calls, closes, sells, result, brokerStop };
}

describe('Test H — stored stop GET 502 blocks the loss exit', () => {
  it('does not sell, clear, or post another stop', async () => {
    const position = openPosition({
      id: 870,
      broker_stop_order_id: 'STOP-502',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
      currentPremium: 0.7,
    });
    const { calls, closes, sells, result } = await restartMonitor(position, (id) => (
      id === 'STOP-502' ? 502 : 200
    ));
    assert.equal(orderGets(calls, 'STOP-502').length >= 1, true);
    assert.equal(sells.length, 0);
    assert.deepEqual(closes, []);
    assert.equal(result.reason, 'stop_status_unknown');
    assert.equal(position.broker_stop_order_id, 'STOP-502');
    assert.equal(lookupUnconfirmedStop('premarket', position)?.state, STOP_STATE.UNKNOWN);
    assert.deepEqual(orderPosts(calls), []);

    const before = orderPosts(calls).length;
    const retry = await placeLadderBrokerStop(position, {
      strategy: 'premarket',
      environment: 'paper',
      initialStopPct: 0.2,
      updateBrokerStopState: async () => {},
    });
    assert.equal(retry.reason, 'stop_status_unconfirmed');
    assert.equal(retry.orderId, 'STOP-502');
    assert.equal(orderPosts(calls).length, before);
    assert.equal(position.broker_stop_order_id, 'STOP-502');
  });
});

describe('Test I — restart reconciles a persisted stop id before trusting it', () => {
  it('GETs a resting stop and does not sell the −20% poll underneath it', async () => {
    const position = openPosition({
      id: 881,
      broker_stop_order_id: 'STOP-REST',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
      currentPremium: 0.79,
    });
    const { calls, sells, closes, result } = await restartMonitor(position, () => 200);
    assert.equal(orderGets(calls, 'STOP-REST').length >= 1, true);
    assert.equal(position.broker_stop_order_id, 'STOP-REST');
    assert.equal(sells.length, 0);
    assert.deepEqual(closes, []);
    assert.equal(result.reason, undefined);
    assert.equal(lookupUnconfirmedStop('premarket', position), null);
  });

  it('GETs a 404, clears the id, and then allows the −20% sell', async () => {
    const position = openPosition({
      id: 882,
      broker_stop_order_id: 'STOP-GONE',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
      currentPremium: 0.79,
    });
    const { calls, sells, closes } = await restartMonitor(position, (id) => (
      id === 'STOP-GONE' ? 404 : 200
    ));
    assert.equal(orderGets(calls, 'STOP-GONE').length >= 1, true);
    assert.equal(position.broker_stop_order_id, null);
    assert.equal(sells.length >= 1, true);
    assert.equal(closes.includes('stop_loss'), true);
    assert.equal(lookupUnconfirmedStop('premarket', position), null);
  });

  it('GETs a 502 and leaves the stop unresolved', async () => {
    const position = openPosition({
      id: 883,
      broker_stop_order_id: 'STOP-UNKNOWN',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
      currentPremium: 0.7,
    });
    const { calls, sells, closes, result } = await restartMonitor(position, (id) => (
      id === 'STOP-UNKNOWN' ? 502 : 200
    ));
    assert.equal(orderGets(calls, 'STOP-UNKNOWN').length >= 1, true);
    assert.equal(sells.length, 0);
    assert.deepEqual(closes, []);
    assert.equal(result.reason, 'stop_status_unknown');
    assert.equal(position.broker_stop_order_id, 'STOP-UNKNOWN');
    assert.equal(lookupUnconfirmedStop('premarket', position)?.state, STOP_STATE.UNKNOWN);
    assert.deepEqual(orderPosts(calls), []);
  });
});

describe('partial_lock_trail uses the same exit ownership', () => {
  it('defers while the initial stop POST is in flight', async () => {
    const position = openPosition({ id: 890 });
    const held = gate();
    let postStarted = false;
    const orders = [];
    const kick = ensureInitialBrokerStopUntilProtected(position, {
      strategy: 'premarket',
      environment: 'paper',
      placeStop: async () => {
        postStarted = true;
        await held.promise;
        return { placed: true, orderId: 'STOP-INITIAL', resting: true };
      },
      getOpenPosition: async () => ({ ...position, broker_stop_order_id: null }),
      sleep: async () => {},
    });
    leaks.push(kick);
    await flushUntil(() => postStarted);
    const result = await withDeadline(submitAndSettleFullClose({
      position,
      strategy: 'premarket',
      closeQty: 1,
      currentPremium: 1.2,
      pnlFrac: (1.2 - 0.99) / 0.99,
      intendedReason: 'partial_lock_trail',
      brokerStop: {
        enabled: true,
        strategy: 'premarket',
        async cancelStop() {
          orders.push('cancel');
          return { cancelled: true };
        },
      },
      closeBrokerOrder: async () => {
        orders.push('stc');
        return { orderId: 'STC-TRAIL', filled: true, fillPrice: 1.2 };
      },
      fullClosePosition: async () => {
        orders.push('book');
      },
      updatePendingClose: async () => {},
    }), 'partial lock');
    assert.equal(result.deferred, true);
    assert.equal(result.reason, 'stop_mutation_in_flight');
    assert.equal(isExitRequested('premarket', position.id), true);
    assert.equal(isInitialStopInFlight('premarket', position.id), true);
    assert.deepEqual(orders, []);
    held.release();
    await kick;
  });

  it('does not let an in-flight ratchet PUT adopt, and blocks the next ratchet', async () => {
    const position = openPosition({
      id: 891,
      broker_stop_order_id: 'STOP-WORKING',
      broker_stop_trigger_price: 0.79,
      broker_stop_pnl_frac: -0.2,
    });
    const held = gate();
    const calls = [];
    let putStarted = false;
    const replacePromise = replaceLadderBrokerStop(position, {
      strategy: 'premarket',
      environment: 'paper',
      initialStopPct: 0.2,
      stopPnlFrac: 0.03,
      replaceStopOrder: async () => {
        putStarted = true;
        calls.push('put');
        await held.promise;
        return { resting: true, orderId: 'STOP-REPLACED', stopTrigger: 1.02, replaced: true };
      },
      placeStop: async () => {
        calls.push('post');
        return { placed: true, orderId: 'STOP-POST' };
      },
    });
    leaks.push(replacePromise);
    await flushUntil(() => putStarted);
    const orders = [];
    const closed = await withDeadline(submitAndSettleFullClose({
      position,
      strategy: 'premarket',
      closeQty: 1,
      currentPremium: 1.2,
      pnlFrac: (1.2 - 0.99) / 0.99,
      intendedReason: 'partial_lock_trail',
      brokerStop: {
        enabled: true,
        strategy: 'premarket',
        async cancelStop() {
          orders.push('cancel');
          return { cancelled: true };
        },
      },
      closeBrokerOrder: async () => {
        orders.push('stc');
        return { orderId: 'STC-TRAIL', filled: true, fillPrice: 1.2 };
      },
      fullClosePosition: async () => {
        orders.push('book');
      },
      updatePendingClose: async () => {},
    }), 'partial lock during PUT');
    assert.equal(closed.deferred, true);
    assert.equal(isExitRequested('premarket', 891), true);
    assert.equal(isReplaceInFlight('premarket', 891), true);
    assert.deepEqual(orders, []);
    held.release();
    const replaced = await replacePromise;
    assert.equal(replaced.reason, 'exit_requested_during_replace');
    assert.equal(position.broker_stop_order_id, 'STOP-WORKING');
    const again = await replaceLadderBrokerStop(position, {
      strategy: 'premarket',
      environment: 'paper',
      initialStopPct: 0.2,
      stopPnlFrac: 0.1,
      replaceStopOrder: async () => {
        calls.push('put-again');
        return { resting: true, orderId: 'STOP-AGAIN' };
      },
      placeStop: async () => {
        calls.push('post-again');
        return { placed: true, orderId: 'STOP-AGAIN' };
      },
    });
    assert.equal(again.reason, 'exit_requested');
    assert.deepEqual(calls, ['put']);
    assert.equal(position.broker_stop_order_id, 'STOP-WORKING');
  });
});
