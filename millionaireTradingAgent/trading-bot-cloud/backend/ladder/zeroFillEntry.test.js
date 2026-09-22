import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maybeSkipUnfilledOpenInsert } from './zeroFillEntry.js';

describe('maybeSkipUnfilledOpenInsert', () => {
  it('does not skip a partial fill (2 of 3)', async () => {
    const cancelled = [];
    const result = await maybeSkipUnfilledOpenInsert({
      order: {
        orderId: '1422885',
        stopOrderId: '1422886',
        fillQuantity: 2,
        requestedQuantity: 3,
      },
      bookedQty: 2,
      environment: 'paper',
      strategy: 'orb',
      ticker: 'SPY',
      cancelOrder: async (id) => {
        cancelled.push(id);
      },
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(cancelled, []);
  });

  it('skips OPEN insert on zero fill, cancels working stop then entry, logs event', async () => {
    const cancelled = [];
    const events = [];
    const result = await maybeSkipUnfilledOpenInsert({
      order: {
        orderId: '1422885',
        stopOrderId: '1422886',
        fillQuantity: 0,
        requestedQuantity: 1,
      },
      bookedQty: 0,
      environment: 'paper',
      strategy: 'orb',
      ticker: 'SPY',
      direction: 'CALL',
      breakoutLevel: 769.2,
      confirmTags: { confirm_mode: '1m_experiment_THE3-4' },
      cancelOrder: async (id) => {
        cancelled.push(id);
      },
      logEvent: async (payload) => {
        events.push(payload);
      },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'entry_unfilled');
    assert.deepEqual(cancelled, ['1422886', '1422885']);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'entry_unfilled');
    assert.equal(events[0].details.fill_quantity, 0);
    assert.equal(events[0].details.booked_quantity, 0);
  });

  it('does not cancel dry-run orders', async () => {
    const cancelled = [];
    const result = await maybeSkipUnfilledOpenInsert({
      order: {
        orderId: 'DRYRUN-1',
        dryRun: true,
        simulated: true,
        fillQuantity: 1,
        requestedQuantity: 1,
      },
      bookedQty: 1,
      cancelOrder: async (id) => {
        cancelled.push(id);
      },
    });
    assert.equal(result.skipped, false);
    assert.deepEqual(cancelled, []);
  });
});
