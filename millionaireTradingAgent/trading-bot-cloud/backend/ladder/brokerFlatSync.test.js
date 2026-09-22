import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { settleDbOpenIfBrokerFlat, pnlFracFromPremiums } from './brokerFlatSync.js';

const position = {
  id: 88,
  ticker: 'SPY',
  direction: 'PUT',
  strike: 765,
  expiration: '2026-08-31',
  entry_premium: 1.11,
  contracts_open: 1,
  quantity: 1,
};

describe('settleDbOpenIfBrokerFlat', () => {
  it('books the STC print when the broker is already flat', async () => {
    const closes = [];
    const result = await settleDbOpenIfBrokerFlat(position, {
      getLiveQuantity: async () => 0,
      findCloseFill: async () => ({ price: 1.03, orderId: '500761200' }),
      fullClosePosition: async (...args) => {
        closes.push(args);
      },
    });
    assert.equal(result.settled, true);
    assert.equal(result.reason, 'broker_already_flat');
    assert.equal(result.exitPremium, 1.03);
    assert.equal(closes[0][1], 1.03);
    assert.equal(closes[0][3], 'broker_already_flat');
    assert.ok(Math.abs(closes[0][2] - pnlFracFromPremiums(1.11, 1.03) * 100) < 1e-6);
  });

  it('does not book a close when qty is 0 but no STC print exists (positions lag)', async () => {
    const closes = [];
    const result = await settleDbOpenIfBrokerFlat(position, {
      getLiveQuantity: async () => 0,
      findCloseFill: async () => null,
      fullClosePosition: async (...args) => {
        closes.push(args);
      },
    });
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'broker_flat_no_stc_fill');
    assert.deepEqual(closes, []);
  });

  it('leaves the row alone while the broker is still long', async () => {
    const result = await settleDbOpenIfBrokerFlat(position, {
      getLiveQuantity: async () => 1,
      findCloseFill: async () => ({ price: 1.03 }),
      fullClosePosition: async () => {
        throw new Error('should not close');
      },
    });
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'broker_still_long');
  });

  it('keeps retrying protection when the qty lookup fails', async () => {
    const result = await settleDbOpenIfBrokerFlat(position, {
      getLiveQuantity: async () => null,
      findCloseFill: async () => ({ price: 1.03 }),
      fullClosePosition: async () => {
        throw new Error('should not close');
      },
    });
    assert.equal(result.settled, false);
    assert.equal(result.reason, 'broker_lookup_failed');
  });
});
