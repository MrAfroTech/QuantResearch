import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureFlattenUntilClosed,
  isFlattenRetryInFlight,
  resetFlattenUntilClosedStateForTests,
  shouldKickInitialStop,
  syncFlattenUntilClosed,
} from './flattenUntilClosed.js';
import { LADDER_CLOSE_REASON } from './ladderConfig.js';

afterEach(() => {
  resetFlattenUntilClosedStateForTests();
});

const noSleep = async () => {};

function position(overrides = {}) {
  return { id: 88, ticker: 'QQQ', contracts_open: 3, ...overrides };
}

describe('shouldKickInitialStop', () => {
  it('kicks when the position is open, unprotected, and not flattening', () => {
    assert.equal(
      shouldKickInitialStop({
        brokerStopOrderId: null,
        pendingCloseReason: LADDER_CLOSE_REASON.PROFIT_TARGET,
        isTimeStop: false,
      }),
      true
    );
  });

  it('does not kick while a flatten retry is in flight or it is time-stop', () => {
    assert.equal(
      shouldKickInitialStop({
        brokerStopOrderId: null,
        isTimeStop: true,
      }),
      false
    );
    assert.equal(
      shouldKickInitialStop({
        brokerStopOrderId: null,
        flattenInFlight: true,
      }),
      false
    );
    assert.equal(
      shouldKickInitialStop({
        brokerStopOrderId: null,
        pendingCloseReason: LADDER_CLOSE_REASON.HARD_STOP,
      }),
      false
    );
    assert.equal(
      shouldKickInitialStop({
        brokerStopOrderId: 'stop-1',
        pendingCloseReason: LADDER_CLOSE_REASON.PROFIT_TARGET,
      }),
      false
    );
  });
});

describe('ensureFlattenUntilClosed', () => {
  it('retries until the flatten fills — no attempt ceiling', async () => {
    let attempts = 0;
    const result = await ensureFlattenUntilClosed(position(), {
      flattenPrice: 0.01,
      closeQty: 3,
      sleep: noSleep,
      flattenBrokerOrder: async () => {
        attempts += 1;
        if (attempts < 5) return { filled: false, orderId: `flat-${attempts}` };
        return { filled: true, fillPrice: 0.01, orderId: 'flat-5' };
      },
    });
    assert.equal(result.filled, true);
    assert.equal(result.attempt, 5);
    assert.equal(attempts, 5);
    assert.equal(isFlattenRetryInFlight(88), false);
  });

  it('stops when the DB row is no longer OPEN, even if flatten never filled', async () => {
    let open = true;
    const result = await ensureFlattenUntilClosed(position(), {
      flattenPrice: 0.01,
      closeQty: 1,
      sleep: noSleep,
      getOpenPosition: async () => (open ? position() : null),
      flattenBrokerOrder: async () => {
        open = false;
        return { filled: false, orderId: 'flat-1' };
      },
    });
    assert.equal(result.filled, false);
    assert.equal(result.reason, 'position_closed');
  });

  it('treats noBrokerPosition as closed', async () => {
    const result = await ensureFlattenUntilClosed(position(), {
      flattenPrice: 0.01,
      closeQty: 1,
      flattenBrokerOrder: async () => ({
        filled: false,
        noBrokerPosition: true,
        reason: 'entry_unfilled_cancelled',
      }),
    });
    assert.equal(result.noBrokerPosition, true);
    assert.equal(result.attempt, 1);
  });

  it('dedupes in-flight loops per position', async () => {
    let started = 0;
    const extras = {
      flattenPrice: 0.01,
      closeQty: 1,
      sleep: noSleep,
      flattenBrokerOrder: async () => {
        started += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { filled: true, fillPrice: 0.01 };
      },
    };
    const a = ensureFlattenUntilClosed(position(), extras);
    const b = ensureFlattenUntilClosed(position(), extras);
    assert.equal(a, b);
    await a;
    assert.equal(started, 1);
  });
});

describe('syncFlattenUntilClosed', () => {
  it('returns an inline fill without starting a background loop', async () => {
    const result = await syncFlattenUntilClosed(position(), {
      flattenPrice: 0.01,
      closeQty: 1,
      sleep: noSleep,
      flattenBrokerOrder: async () => ({ filled: true, fillPrice: 0.01 }),
    });
    assert.equal(result.filled, true);
    assert.equal(result.backgroundRetry, undefined);
  });

  it('continues in the background after the inline wave without a fill ceiling', async () => {
    let attempts = 0;
    let settled = 0;
    const result = await syncFlattenUntilClosed(position(), {
      flattenPrice: 0.01,
      closeQty: 1,
      sleep: noSleep,
      inlineAttempts: 2,
      flattenBrokerOrder: async () => {
        attempts += 1;
        if (attempts < 4) return { filled: false, orderId: `flat-${attempts}` };
        return { filled: true, fillPrice: 0.01, orderId: 'flat-4' };
      },
      settleFilled: async () => {
        settled += 1;
      },
    });
    assert.equal(result.backgroundRetry, true);
    assert.equal(result.exhausted, true);
    assert.equal(result.filled, false);

    await new Promise((r) => setTimeout(r, 50));
    assert.ok(attempts >= 4);
    assert.equal(settled, 1);
  });
});
