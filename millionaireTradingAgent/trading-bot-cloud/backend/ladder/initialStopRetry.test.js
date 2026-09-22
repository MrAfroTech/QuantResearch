import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_FILL_WAIT_TIMEOUT_MS,
  UNPROTECTED_STOP_ALERT_AFTER_MS,
  ensureInitialBrokerStopUntilProtected,
  isEntryNotFilledStopConflict,
  nextStopRetryBackoffMs,
  resetInitialStopRetryStateForTests,
  waitForEntryOrderFill,
} from './initialStopRetry.js';

const IWM_REJECT =
  'Tastytrade /accounts/5WI91741/orders failed: 422 {"error":{"code":"preflight_check_failure","errors":[{"code":"illegal_buy_and_sell_on_same_symbol","message":"Cannot buy and sell against the same symbol."}]}}';

afterEach(() => {
  resetInitialStopRetryStateForTests();
});

function position(overrides = {}) {
  return {
    id: 74,
    ticker: 'IWM',
    direction: 'PUT',
    strike: 299,
    order_id: '498097304',
    broker_stop_order_id: null,
    ...overrides,
  };
}

describe('isEntryNotFilledStopConflict', () => {
  it('matches the live IWM #78 Tastytrade rejection', () => {
    assert.equal(isEntryNotFilledStopConflict(IWM_REJECT), true);
  });

  it('does not swallow unrelated rejections', () => {
    assert.equal(isEntryNotFilledStopConflict('insufficient buying power'), false);
    assert.equal(isEntryNotFilledStopConflict('Invalid stop trigger price'), false);
    assert.equal(isEntryNotFilledStopConflict(''), false);
  });
});

describe('nextStopRetryBackoffMs', () => {
  it('starts at 2s and caps at 30s', () => {
    assert.equal(nextStopRetryBackoffMs(1), 2_000);
    assert.equal(nextStopRetryBackoffMs(2), 4_000);
    assert.equal(nextStopRetryBackoffMs(3), 8_000);
    assert.equal(nextStopRetryBackoffMs(4), 16_000);
    assert.equal(nextStopRetryBackoffMs(5), 30_000);
    assert.equal(nextStopRetryBackoffMs(8), 30_000);
  });
});

describe('waitForEntryOrderFill', () => {
  it('treats PAPER ids as filled without polling', async () => {
    let polled = 0;
    const fill = await waitForEntryOrderFill('PAPER-1', {
      getStatus: async () => {
        polled += 1;
        return { isFilled: false };
      },
    });
    assert.equal(fill.skipped, true);
    assert.equal(fill.isFilled, true);
    assert.equal(polled, 0);
  });

  it('polls until filled within the 15s window', async () => {
    let n = 0;
    const fill = await waitForEntryOrderFill('498097304', {
      pollMs: 0,
      timeoutMs: ENTRY_FILL_WAIT_TIMEOUT_MS,
      sleep: async () => {},
      getStatus: async () => {
        n += 1;
        return n < 3
          ? { isFilled: false, isTerminal: false, status: 'live' }
          : { isFilled: true, isTerminal: true, status: 'filled' };
      },
    });
    assert.equal(fill.isFilled, true);
    assert.equal(n, 3);
  });
});

describe('ensureInitialBrokerStopUntilProtected', () => {
  it('IWM #78 path: conflict → wait for fill → place succeeds', async () => {
    let places = 0;
    let fillCalls = 0;
    const sleeps = [];
    const result = await ensureInitialBrokerStopUntilProtected(position(), {
      strategy: 'orb',
      placeStop: async () => {
        places += 1;
        if (places === 1) return { placed: false, reason: IWM_REJECT };
        return { placed: true, orderId: 'stop-1' };
      },
      waitForFill: async () => {
        fillCalls += 1;
        return { isFilled: true, isTerminal: true, status: 'filled' };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      getOpenPosition: async () =>
        position({ broker_stop_order_id: places >= 2 ? 'stop-1' : null }),
    });
    assert.equal(result.placed, true);
    assert.equal(places, 2);
    assert.equal(fillCalls, 1);
    assert.deepEqual(sleeps, []);
  });

  it('does not wait for fill on unrelated rejection; backs off then retries', async () => {
    let places = 0;
    let fillCalls = 0;
    const sleeps = [];
    const result = await ensureInitialBrokerStopUntilProtected(position(), {
      strategy: 'premarket',
      placeStop: async () => {
        places += 1;
        if (places === 1) return { placed: false, reason: 'broker unavailable' };
        return { placed: true, orderId: 'stop-2' };
      },
      waitForFill: async () => {
        fillCalls += 1;
        return { isFilled: true };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      getOpenPosition: async () => position({ broker_stop_order_id: places >= 2 ? 'stop-2' : null }),
    });
    assert.equal(result.placed, true);
    assert.equal(fillCalls, 0);
    assert.deepEqual(sleeps, [2_000]);
  });

  it('keeps polling fill across chunks without extra place until BTO fills', async () => {
    let places = 0;
    let fillCalls = 0;
    const result = await ensureInitialBrokerStopUntilProtected(position(), {
      strategy: 'orb',
      placeStop: async () => {
        places += 1;
        if (places === 1) return { placed: false, reason: IWM_REJECT };
        return { placed: true, orderId: 'stop-3' };
      },
      waitForFill: async () => {
        fillCalls += 1;
        if (fillCalls < 3) return { isFilled: false, isTerminal: false, status: 'live' };
        return { isFilled: true, isTerminal: true, status: 'filled' };
      },
      sleep: async () => {},
      getOpenPosition: async () => position({ broker_stop_order_id: places >= 2 ? 'stop-3' : null }),
    });
    assert.equal(result.placed, true);
    assert.equal(places, 2);
    assert.equal(fillCalls, 3);
  });

  it('retries with no attempt cap until the stop rests', async () => {
    let places = 0;
    const result = await ensureInitialBrokerStopUntilProtected(position(), {
      strategy: 'orb',
      placeStop: async () => {
        places += 1;
        if (places < 6) return { placed: false, reason: 'temporary broker error' };
        return { placed: true, orderId: 'stop-6' };
      },
      waitForFill: async () => ({ isFilled: true }),
      sleep: async () => {},
      getOpenPosition: async () => position({ broker_stop_order_id: places >= 6 ? 'stop-6' : null }),
    });
    assert.equal(result.placed, true);
    assert.equal(places, 6);
    assert.equal(result.attempt, 6);
  });

  it('stops retrying when the position is closed by another path', async () => {
    let places = 0;
    let open = true;
    const result = await ensureInitialBrokerStopUntilProtected(position(), {
      strategy: 'orb',
      placeStop: async () => {
        places += 1;
        return { placed: false, reason: 'temporary broker error' };
      },
      waitForFill: async () => ({ isFilled: false }),
      sleep: async () => {
        open = false;
      },
      getOpenPosition: async () => (open ? position() : null),
    });
    assert.equal(result.placed, false);
    assert.equal(result.reason, 'position_closed');
    assert.equal(places, 1);
  });

  it('fires THE3-2 alert when a failure is already past grace', async () => {
    const alerts = [];
    let places = 0;
    let t = 0;
    await ensureInitialBrokerStopUntilProtected(position(), {
      strategy: 'premarket',
      now: () => t,
      placeStop: async () => {
        places += 1;
        if (places === 1) {
          t = 60_000;
          return { placed: false, reason: 'temporary broker error' };
        }
        return { placed: true, orderId: 'stop-alert2' };
      },
      waitForFill: async () => ({ isFilled: true }),
      sleep: async () => {},
      getOpenPosition: async () =>
        position({ broker_stop_order_id: places >= 2 ? 'stop-alert2' : null }),
      onUnprotectedAlert: async (info) => {
        alerts.push(info);
      },
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].attempt, 1);
    assert.ok(alerts[0].elapsedMs >= UNPROTECTED_STOP_ALERT_AFTER_MS);
  });

  it('stops retrying once the broker is already flat', async () => {
    let places = 0;
    let settled = 0;
    const result = await ensureInitialBrokerStopUntilProtected(position(), {
      strategy: 'orb',
      placeStop: async () => {
        places += 1;
        return { placed: false, reason: 'tif_no_stop_market_gtc_options' };
      },
      isBrokerStillLong: async () => false,
      onBrokerAlreadyFlat: async () => {
        settled += 1;
      },
      sleep: async () => {},
      getOpenPosition: async () => position(),
    });
    assert.equal(result.placed, false);
    assert.equal(result.reason, 'broker_already_flat');
    assert.equal(result.brokerFlat, true);
    assert.equal(places, 1);
    assert.equal(settled, 1);
  });

  it('keeps retrying when broker long lookup fails (null)', async () => {
    let places = 0;
    const result = await ensureInitialBrokerStopUntilProtected(position(), {
      strategy: 'orb',
      placeStop: async () => {
        places += 1;
        if (places < 3) return { placed: false, reason: 'temporary broker error' };
        return { placed: true, orderId: 's' };
      },
      isBrokerStillLong: async () => null,
      sleep: async () => {},
      getOpenPosition: async () =>
        position({ broker_stop_order_id: places >= 3 ? 's' : null }),
    });
    assert.equal(result.placed, true);
    assert.equal(places, 3);
  });

  it('does not treat qty-0 as flat during illegal_buy_and_sell fill wait', async () => {
    let places = 0;
    let flatChecks = 0;
    const result = await ensureInitialBrokerStopUntilProtected(position(), {
      strategy: 'orb',
      placeStop: async () => {
        places += 1;
        if (places === 1) return { placed: false, reason: IWM_REJECT };
        return { placed: true, orderId: 'stop-after-fill' };
      },
      isBrokerStillLong: async () => {
        flatChecks += 1;
        return false;
      },
      onBrokerAlreadyFlat: async () => {
        throw new Error('should not settle during entry-fill wait');
      },
      waitForFill: async () => ({ isFilled: true, isTerminal: true, status: 'filled' }),
      sleep: async () => {},
      getOpenPosition: async () =>
        position({ broker_stop_order_id: places >= 2 ? 'stop-after-fill' : null }),
    });
    assert.equal(result.placed, true);
    assert.equal(places, 2);
    assert.equal(flatChecks, 0);
  });

  it('dedupes in-flight loops for the same position', async () => {
    let places = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const extras = {
      strategy: 'orb',
      placeStop: async () => {
        places += 1;
        await gate;
        return { placed: true, orderId: 'stop-dup' };
      },
      waitForFill: async () => ({ isFilled: true }),
      sleep: async () => {},
      getOpenPosition: async () => position({ broker_stop_order_id: null }),
    };
    const a = ensureInitialBrokerStopUntilProtected(position(), extras);
    const b = ensureInitialBrokerStopUntilProtected(position(), extras);
    assert.equal(a, b);
    release();
    await a;
    assert.equal(places, 1);
  });
});
