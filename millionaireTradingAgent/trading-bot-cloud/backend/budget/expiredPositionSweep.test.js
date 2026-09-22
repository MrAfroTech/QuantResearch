import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  occForPosition,
  brokerQtyForPosition,
  extractCloseFillFromTransactions,
  pnlPctFromFill,
  decideExpiredSweepAction,
  EXPIRED_SWEEP_CLOSE_REASON,
} from './expiredPositionSweep.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('expiredPositionSweep confirmation helpers', () => {
  const position = {
    id: 9,
    ticker: 'IWM',
    direction: 'CALL',
    strike: 296,
    expiration: '2026-07-15',
    entry_premium: 0.6,
    quantity: 2,
  };

  it('matches broker qty by OCC, not ticker alone', () => {
    const occ = occForPosition(position);
    assert.match(occ.replace(/\s+/g, ''), /IWM260715C00296000/);
    assert.equal(
      brokerQtyForPosition([{ symbol: occ, quantity: 2 }], position),
      2
    );
    assert.equal(
      brokerQtyForPosition([{ symbol: 'IWM   260715C00297000', quantity: 4 }], position),
      0
    );
  });

  it('extracts a Sell-to-Close fill price and never invents intrinsic', () => {
    const occ = occForPosition(position);
    const fill = extractCloseFillFromTransactions(
      [
        {
          symbol: occ,
          action: 'Sell to Close',
          price: 0.12,
          'executed-at': '2026-07-15T20:00:00Z',
        },
      ],
      position
    );
    assert.equal(fill.fillPrice, 0.12);
    assert.equal(extractCloseFillFromTransactions([], position), null);
  });

  it('flattens when the broker still holds the long', () => {
    assert.deepEqual(decideExpiredSweepAction({ brokerQty: 2, closeFill: null }), {
      action: 'flatten',
      reason: 'broker_still_long',
    });
  });

  it('books a broker fill when already flat, and refuses calculated $0', () => {
    const book = decideExpiredSweepAction({
      brokerQty: 0,
      closeFill: { fillPrice: 0.08, source: 'broker_transaction' },
    });
    assert.equal(book.action, 'book_fill');
    assert.equal(book.closeFill.fillPrice, 0.08);

    const refuse = decideExpiredSweepAction({ brokerQty: 0, closeFill: null });
    assert.equal(refuse.action, 'leave_open');
    assert.equal(refuse.reason, 'broker_flat_no_confirmed_fill');
  });

  it('computes pnl from the confirmed fill, not intrinsic', () => {
    assert.equal(pnlPctFromFill(1, 0.5), -50);
    assert.equal(EXPIRED_SWEEP_CLOSE_REASON.BROKER_FILL, 'expired_sweep_broker_fill');
    assert.equal(EXPIRED_SWEEP_CLOSE_REASON.FLATTENED, 'expired_sweep_flatten');
  });

  it('source no longer computes intrinsic or writes CLOSE without a broker path', () => {
    const src = readFileSync(join(here, 'expiredPositionSweep.js'), 'utf8');
    assert.doesNotMatch(src, /intrinsicAtExpiry/);
    assert.doesNotMatch(src, /fetchUnderlyingClose/);
    assert.doesNotMatch(src, /expired_itm/);
    assert.doesNotMatch(src, /expired_worthless/);
    assert.match(src, /tastytradeGetOptionPositions/);
    assert.match(src, /syncFlattenUntilClosed/);
    assert.match(src, /closeFillIsConfirmed/);
    assert.match(src, /leave_open/);
    assert.doesNotMatch(src, /sql\.end\(/);
  });
});
