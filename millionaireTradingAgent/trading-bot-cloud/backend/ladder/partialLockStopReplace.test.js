import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARTIAL_LOCK_STOP_REPLACE_FAILED,
  attemptPartialLockStopReplace,
  ensurePartialLockBrokerStopRaised,
  isPartialLockFloorResting,
  resetPartialLockStopReplaceStateForTests,
  shouldArmPartialLockBrokerStop,
  syncPartialLockBrokerStopWithRetry,
} from './partialLockStopReplace.js';
import { nextStopRetryBackoffMs } from './initialStopRetry.js';

afterEach(() => {
  resetPartialLockStopReplaceStateForTests();
});

function position(overrides = {}) {
  return {
    id: 63,
    ticker: 'IWM',
    entry_premium: 0.735,
    broker_stop_order_id: '498758838',
    broker_stop_trigger_price: 0.72,
    broker_stop_pnl_frac: -0.0225,
    ...overrides,
  };
}

describe('isPartialLockFloorResting', () => {
  it('detects peak/2 floor already on the resting stop', () => {
    assert.equal(
      isPartialLockFloorResting({ broker_stop_pnl_frac: 0.0306 }, 0.0306),
      true
    );
    assert.equal(
      isPartialLockFloorResting({ broker_stop_pnl_frac: -0.0225 }, 0.0306),
      false
    );
  });
});

describe('shouldArmPartialLockBrokerStop', () => {
  it('arms on activated hold, not on hard-stop ownership or below activation', () => {
    assert.equal(
      shouldArmPartialLockBrokerStop({
        action: 'hold',
        peakMfe: 0.0612,
        trailFloor: 0.0306,
      }),
      true
    );
    assert.equal(
      shouldArmPartialLockBrokerStop({
        action: 'hold',
        inactiveReason: 'hard_stop_owns_exit',
        peakMfe: 0.0612,
      }),
      false
    );
    assert.equal(
      shouldArmPartialLockBrokerStop({
        action: 'hold',
        inactiveReason: 'below_activation',
        peakMfe: 0.02,
      }),
      false
    );
    assert.equal(
      shouldArmPartialLockBrokerStop({
        action: 'close_all',
        trailFloor: 0.03,
        peakMfe: 0.06,
      }),
      false
    );
  });
});

describe('attemptPartialLockStopReplace', () => {
  it('logs success via onSuccess and mutates position stop fields', async () => {
    const pos = position();
    const events = [];
    const result = await attemptPartialLockStopReplace(pos, {
      strategy: 'premarket',
      trailFloor: 0.0306,
      peakMfe: 0.0612,
      shouldRaise: () => ({
        raise: true,
        desiredTrigger: 0.76,
        currentTrigger: 0.72,
      }),
      replaceStop: async () => ({
        placed: true,
        orderId: 'new-1',
        stopTrigger: 0.76,
        stopPnlFrac: 0.0306,
      }),
      onSuccess: async (payload) => {
        events.push(['ok', payload.newOrderId]);
      },
    });
    assert.equal(result.placed, true);
    assert.equal(pos.broker_stop_order_id, 'new-1');
    assert.equal(pos.broker_stop_pnl_frac, 0.0306);
    assert.deepEqual(events, [['ok', 'new-1']]);
  });

  it('writes failure callback with reason — never silent', async () => {
    const failures = [];
    const result = await attemptPartialLockStopReplace(position(), {
      strategy: 'premarket',
      trailFloor: 0.0306,
      peakMfe: 0.0612,
      shouldRaise: () => ({
        raise: true,
        desiredTrigger: 0.76,
        currentTrigger: 0.72,
      }),
      replaceStop: async () => ({ placed: false, reason: 'broker_reject' }),
      onFailure: async (payload) => {
        failures.push(payload);
      },
    });
    assert.equal(result.placed, false);
    assert.equal(result.reason, 'broker_reject');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason, 'broker_reject');
    assert.equal(PARTIAL_LOCK_STOP_REPLACE_FAILED, 'partial_lock_stop_replace_failed');
  });
});

describe('ensurePartialLockBrokerStopRaised', () => {
  it('retries with e1311e9 backoff until place succeeds', async () => {
    let places = 0;
    const sleeps = [];
    const failures = [];
    const result = await ensurePartialLockBrokerStopRaised(position(), {
      strategy: 'premarket',
      trailFloor: 0.0306,
      peakMfe: 0.0612,
      shouldRaise: (pos) => ({
        raise: !isPartialLockFloorResting(pos, 0.0306),
        desiredTrigger: 0.76,
        currentTrigger: pos.broker_stop_trigger_price,
      }),
      replaceStop: async () => {
        places += 1;
        if (places < 3) return { placed: false, reason: 'transient' };
        return {
          placed: true,
          orderId: 'raised',
          stopTrigger: 0.76,
          stopPnlFrac: 0.0306,
        };
      },
      getOpenPosition: async () => position(),
      onFailure: async (p) => {
        failures.push(p.reason);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(result.placed, true);
    assert.equal(places, 3);
    assert.deepEqual(failures, ['transient', 'transient']);
    assert.deepEqual(sleeps, [nextStopRetryBackoffMs(1), nextStopRetryBackoffMs(2)]);
  });

  it('skips replaceStop when the broker is already flat — no failure log, no retry', async () => {
    let places = 0;
    const failures = [];
    const settlements = [];
    const result = await ensurePartialLockBrokerStopRaised(position(), {
      strategy: 'orb',
      trailFloor: 0.03,
      peakMfe: 0.06,
      shouldRaise: () => ({ raise: true, desiredTrigger: 1, currentTrigger: 0.9 }),
      replaceStop: async () => {
        places += 1;
        return { placed: false, reason: 'cannot_update_order' };
      },
      getOpenPosition: async () => position(),
      isBrokerStillLong: async () => false,
      onBrokerAlreadyFlat: async (payload) => {
        settlements.push(payload.position.id);
      },
      onFailure: async (p) => {
        failures.push(p.reason);
      },
      sleep: async () => {},
    });
    assert.equal(result.placed, false);
    assert.equal(result.reason, 'broker_already_flat');
    assert.equal(result.brokerFlat, true);
    assert.equal(places, 0);
    assert.deepEqual(failures, []);
    assert.deepEqual(settlements, [63]);
  });

  it('still replaces when the broker confirms the position is long', async () => {
    let places = 0;
    const result = await ensurePartialLockBrokerStopRaised(position(), {
      strategy: 'orb',
      trailFloor: 0.03,
      peakMfe: 0.06,
      shouldRaise: () => ({ raise: true, desiredTrigger: 1, currentTrigger: 0.9 }),
      replaceStop: async () => {
        places += 1;
        return {
          placed: true,
          orderId: 'raised',
          stopTrigger: 0.76,
          stopPnlFrac: 0.03,
        };
      },
      getOpenPosition: async () => position(),
      isBrokerStillLong: async () => true,
      sleep: async () => {},
    });
    assert.equal(result.placed, true);
    assert.equal(places, 1);
  });

  it('a later higher floor is a new replace loop — attempt restarts at 1, not blocked by the first lock', async () => {
    const pos = position({
      broker_stop_trigger_price: 1.73,
      broker_stop_pnl_frac: 0.0466,
    });
    const attempts = [];
    const first = await ensurePartialLockBrokerStopRaised(pos, {
      strategy: 'premarket',
      trailFloor: 0.0466,
      peakMfe: 0.0606,
      shouldRaise: () => ({ raise: false }),
      replaceStop: async () => ({ placed: false, reason: 'unused' }),
      getOpenPosition: async () => pos,
      sleep: async () => {},
    });
    assert.equal(first.alreadyRaised, true);

    const second = await ensurePartialLockBrokerStopRaised(pos, {
      strategy: 'premarket',
      trailFloor: 0.0723,
      peakMfe: 0.0939,
      shouldRaise: () => ({
        raise: true,
        desiredTrigger: 1.77,
        currentTrigger: 1.73,
      }),
      replaceStop: async () => ({
        placed: true,
        orderId: '506-next',
        stopTrigger: 1.77,
        stopPnlFrac: 0.0723,
      }),
      getOpenPosition: async () => pos,
      onSuccess: async (payload) => {
        attempts.push(payload.attempt);
      },
      sleep: async () => {},
    });
    assert.equal(second.placed, true);
    assert.equal(second.attempt, 1);
    assert.deepEqual(attempts, [1]);
  });

  it('fail-opens to replaceStop when live qty lookup returns null', async () => {
    let places = 0;
    const result = await ensurePartialLockBrokerStopRaised(position(), {
      strategy: 'orb',
      trailFloor: 0.03,
      peakMfe: 0.06,
      shouldRaise: () => ({ raise: true, desiredTrigger: 1, currentTrigger: 0.9 }),
      replaceStop: async () => {
        places += 1;
        return {
          placed: true,
          orderId: 'raised',
          stopTrigger: 0.76,
          stopPnlFrac: 0.03,
        };
      },
      getOpenPosition: async () => position(),
      isBrokerStillLong: async () => null,
      sleep: async () => {},
    });
    assert.equal(result.placed, true);
    assert.equal(places, 1);
  });

  it('stops when the position is no longer open', async () => {
    let places = 0;
    let open = true;
    const result = await ensurePartialLockBrokerStopRaised(position(), {
      strategy: 'orb',
      trailFloor: 0.03,
      peakMfe: 0.06,
      shouldRaise: () => ({ raise: true, desiredTrigger: 1, currentTrigger: 0.9 }),
      replaceStop: async () => {
        places += 1;
        open = false;
        return { placed: false, reason: 'transient' };
      },
      getOpenPosition: async () => (open ? position() : null),
      onFailure: async () => {},
      sleep: async () => {},
    });
    assert.equal(result.placed, false);
    assert.equal(result.reason, 'position_closed');
    assert.equal(places, 1);
  });
});

describe('syncPartialLockBrokerStopWithRetry', () => {
  it('kicks background retry after inline attempts exhaust', async () => {
    let places = 0;
    const pos = position();
    const openRow = () => ({
      ...pos,
      broker_stop_order_id: pos.broker_stop_order_id,
      broker_stop_trigger_price: pos.broker_stop_trigger_price,
      broker_stop_pnl_frac: pos.broker_stop_pnl_frac,
    });

    const inline = await syncPartialLockBrokerStopWithRetry(pos, {
      strategy: 'premarket',
      trailFloor: 0.0306,
      peakMfe: 0.0612,
      inlineAttempts: 2,
      shouldRaise: (p) => ({
        raise: !isPartialLockFloorResting(p, 0.0306),
        desiredTrigger: 0.76,
        currentTrigger: p.broker_stop_trigger_price,
      }),
      replaceStop: async () => {
        places += 1;
        if (places < 4) return { placed: false, reason: 'transient' };
        const ok = {
          placed: true,
          orderId: 'bg-ok',
          stopTrigger: 0.76,
          stopPnlFrac: 0.0306,
        };
        pos.broker_stop_order_id = ok.orderId;
        pos.broker_stop_trigger_price = ok.stopTrigger;
        pos.broker_stop_pnl_frac = ok.stopPnlFrac;
        return ok;
      },
      getOpenPosition: async () => openRow(),
      onFailure: async () => {},
      sleep: async () => {},
    });

    assert.equal(inline.placed, false);
    assert.equal(inline.backgroundRetry, true);
    assert.ok(places >= 2);

    // Background loop shares the same inFlight key after inline clears — poll until raised.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && pos.broker_stop_order_id !== 'bg-ok') {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(pos.broker_stop_order_id, 'bg-ok');
  });

  it('does not background-retry when the broker is already flat', async () => {
    let places = 0;
    const inline = await syncPartialLockBrokerStopWithRetry(position(), {
      strategy: 'orb',
      trailFloor: 0.03,
      peakMfe: 0.06,
      inlineAttempts: 2,
      shouldRaise: () => ({ raise: true, desiredTrigger: 1, currentTrigger: 0.9 }),
      replaceStop: async () => {
        places += 1;
        return { placed: false, reason: 'cannot_update_order' };
      },
      getOpenPosition: async () => position(),
      isBrokerStillLong: async () => false,
      onFailure: async () => {},
      sleep: async () => {},
    });
    assert.equal(inline.placed, false);
    assert.equal(inline.reason, 'broker_already_flat');
    assert.equal(inline.backgroundRetry, undefined);
    assert.equal(places, 0);
  });
});
