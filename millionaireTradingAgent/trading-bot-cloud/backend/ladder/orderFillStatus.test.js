import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bookedEntryQuantity,
  brokerStopFillIsConfirmed,
  closeFillIsConfirmed,
  closeReasonClaimsBreakoutSlot,
  entryHasBrokerLong,
  fillPollShouldReturn,
  hasConfirmedFillPrice,
  isBrokerOrderGoneError,
  isCancelConfirmed,
  isConfirmedCancelledStatus,
  isConfirmedRestingStop,
  normalizeOrderStatus,
  positionHasConfirmedBrokerLong,
  shouldBookConfirmedEntry,
  shouldInsertOpenPosition,
  stopQuantityFromStatus,
} from './orderFillStatus.js';

function livePartialTwoOfThree() {
  return {
    data: {
      status: 'Live',
      quantity: 3,
      legs: [
        {
          quantity: 3,
          'remaining-quantity': 1,
          fills: [{ quantity: 2, 'fill-price': 0.34 }],
        },
      ],
    },
  };
}

describe('normalizeOrderStatus fill quantity', () => {
  it('keeps fillQuantity as summed fills and does not treat a partial as filled', () => {
    const status = normalizeOrderStatus(livePartialTwoOfThree());
    assert.equal(status.fillQuantity, 2);
    assert.equal(status.requestedQuantity, 3);
    assert.equal(status.remainingQuantity, 1);
    assert.equal(status.isFilled, false);
    assert.equal(status.isPartialFill, true);
    assert.equal(status.isTerminal, false);
  });

  it('does not fall back fillQuantity to the requested size when there are no fills', () => {
    const status = normalizeOrderStatus({
      data: { status: 'Live', quantity: 3, legs: [{ quantity: 3, 'remaining-quantity': 3, fills: [] }] },
    });
    assert.equal(status.fillQuantity, 0);
    assert.equal(status.isFilled, false);
    assert.equal(status.isPartialFill, false);
  });

  it('treats cancelled-with-fills as a completed long (remainder locked)', () => {
    const status = normalizeOrderStatus({
      data: {
        status: 'Cancelled',
        quantity: 3,
        legs: [
          {
            quantity: 3,
            'remaining-quantity': 0,
            fills: [{ quantity: 2, 'fill-price': 0.34 }],
          },
        ],
      },
    });
    assert.equal(status.fillQuantity, 2);
    assert.equal(status.isFilled, true);
    assert.equal(status.isPartialFill, false);
    assert.equal(entryHasBrokerLong(status), true);
  });

  it('treats fully filled status as isFilled', () => {
    const status = normalizeOrderStatus({
      data: {
        status: 'Filled',
        quantity: 3,
        'average-fill-price': 0.34,
        legs: [
          {
            quantity: 3,
            'remaining-quantity': 0,
            fills: [
              { quantity: 1, 'fill-price': 0.33 },
              { quantity: 2, 'fill-price': 0.35 },
            ],
          },
        ],
      },
    });
    assert.equal(status.fillQuantity, 3);
    assert.equal(status.isFilled, true);
    assert.equal(status.isTerminal, true);
  });
});

describe('fill poll waits for a confirmed fill price', () => {
  it('does not stop on Filled before fills[] or average-fill-price land', () => {
    const status = normalizeOrderStatus({
      data: {
        status: 'Filled',
        quantity: 1,
        legs: [{ quantity: 1, 'remaining-quantity': 0, fills: [] }],
      },
    });
    assert.equal(status.isFilled, true);
    assert.equal(status.isTerminal, true);
    assert.equal(hasConfirmedFillPrice(status), false);
    assert.equal(fillPollShouldReturn(status), false);
  });

  it('stops once the fill price is present', () => {
    const status = normalizeOrderStatus({
      data: {
        status: 'Filled',
        quantity: 1,
        legs: [{ quantity: 1, 'remaining-quantity': 0, fills: [{ quantity: 1, price: '0.67' }] }],
      },
    });
    assert.equal(status.fillPrice, 0.67);
    assert.equal(hasConfirmedFillPrice(status), true);
    assert.equal(fillPollShouldReturn(status), true);
  });

  it('stops immediately on rejected / cancelled with no fill', () => {
    const rejected = normalizeOrderStatus({
      data: { status: 'Rejected', legs: [{ quantity: 1, 'remaining-quantity': 1, fills: [] }] },
    });
    assert.equal(fillPollShouldReturn(rejected), true);
  });
});

describe('bookedEntryQuantity', () => {
  it('books the actual fill when smaller than requested (partial-fill path)', () => {
    assert.equal(bookedEntryQuantity({ requestedQuantity: 3, fillQuantity: 2 }), 2);
  });

  it('books the full fill when it matches the request', () => {
    assert.equal(bookedEntryQuantity({ requestedQuantity: 3, fillQuantity: 3 }), 3);
  });

  it('books 0 when no fill has printed — never treats requested size as owned', () => {
    assert.equal(bookedEntryQuantity({ requestedQuantity: 3, fillQuantity: 0 }), 0);
    assert.equal(bookedEntryQuantity({ requestedQuantity: 3, fillQuantity: null }), 0);
    assert.equal(bookedEntryQuantity({ requestedQuantity: 1, fillQuantity: 0 }), 0);
  });
});

describe('zero-fill slot and insert gates', () => {
  it('does not claim the daily slot on unfilled-cancel reasons', () => {
    assert.equal(closeReasonClaimsBreakoutSlot('entry_unfilled_cancelled'), false);
    assert.equal(closeReasonClaimsBreakoutSlot('entry_never_filled'), false);
    assert.equal(closeReasonClaimsBreakoutSlot('hard_stop'), true);
    assert.equal(closeReasonClaimsBreakoutSlot('stop_loss'), true);
  });

  it('treats explicit fill_quantity 0 as no broker long; legacy rows as owned', () => {
    assert.equal(
      positionHasConfirmedBrokerLong({
        entry_metadata_json: JSON.stringify({ fill_quantity: 0, booked_quantity: 1 }),
      }),
      false
    );
    assert.equal(
      positionHasConfirmedBrokerLong({
        entry_metadata_json: JSON.stringify({ fill_quantity: 2, booked_quantity: 2 }),
      }),
      true
    );
    assert.equal(positionHasConfirmedBrokerLong({ entry_metadata_json: null }), true);
    assert.equal(positionHasConfirmedBrokerLong({}), true);
  });

  it('inserts OPEN only after a real fill; dry-run still inserts booked size', () => {
    assert.equal(
      shouldInsertOpenPosition({ fillQuantity: 0, bookedQuantity: 0 }),
      false
    );
    assert.equal(
      shouldInsertOpenPosition({ fillQuantity: 2, bookedQuantity: 2 }),
      true
    );
    assert.equal(
      shouldInsertOpenPosition({
        fillQuantity: 1,
        bookedQuantity: 1,
        dryRun: false,
      }),
      true
    );
    assert.equal(
      shouldInsertOpenPosition({
        fillQuantity: 1,
        bookedQuantity: 1,
        dryRun: true,
        simulated: true,
      }),
      true
    );
  });
});

describe('shouldBookConfirmedEntry', () => {
  it('refuses to book a live fill that has qty but no fill price', () => {
    assert.equal(
      shouldBookConfirmedEntry({
        fillQuantity: 1,
        bookedQuantity: 1,
        fillPrice: null,
      }),
      false
    );
  });

  it('books a live fill only when qty and fill price are both confirmed', () => {
    assert.equal(
      shouldBookConfirmedEntry({
        fillQuantity: 2,
        bookedQuantity: 2,
        fillPrice: 0.67,
      }),
      true
    );
  });

  it('still books a dry-run / simulated fill', () => {
    assert.equal(
      shouldBookConfirmedEntry({
        fillQuantity: 1,
        bookedQuantity: 1,
        fillPrice: 0.71,
        dryRun: true,
        simulated: true,
      }),
      true
    );
  });
});

describe('close and cancel confirmation helpers', () => {
  it('closeFillIsConfirmed requires filled plus a real price', () => {
    assert.equal(closeFillIsConfirmed({ filled: true, fillPrice: null }), false);
    assert.equal(closeFillIsConfirmed({ isFilled: true, fillPrice: 1.07 }), true);
    assert.equal(closeFillIsConfirmed({ filled: true, fillPrice: 0.01 }), true);
    assert.equal(closeFillIsConfirmed({ noBrokerPosition: true, filled: true, fillPrice: 1 }), false);
  });

  it('brokerStopFillIsConfirmed requires filled price and qty', () => {
    assert.equal(
      brokerStopFillIsConfirmed({ isFilled: true, fillPrice: null, fillQuantity: 1 }),
      false
    );
    assert.equal(
      brokerStopFillIsConfirmed({ isFilled: true, fillPrice: 0.66, fillQuantity: 0 }),
      false
    );
    assert.equal(
      brokerStopFillIsConfirmed({ isFilled: true, fillPrice: 0.66, fillQuantity: 1 }),
      true
    );
  });

  it('treats 404 and cancelled/gone as a confirmed cancel', () => {
    assert.equal(isBrokerOrderGoneError(new Error('Tastytrade /orders/1 failed: 404 not found')), true);
    assert.equal(isConfirmedCancelledStatus({ status: 'cancelled' }), true);
    assert.equal(isConfirmedCancelledStatus({ gone: true }), true);
    assert.equal(isConfirmedCancelledStatus({ status: 'live' }), false);
    assert.equal(isCancelConfirmed({ cancelled: true }), true);
    assert.equal(isCancelConfirmed({ cancelled: false, reason: 'cancel_unconfirmed' }), false);
    assert.equal(isConfirmedRestingStop({ status: 'live' }), true);
    assert.equal(isConfirmedRestingStop({ status: 'rejected' }), false);
  });
});

describe('stopQuantityFromStatus', () => {
  it('reads requested child size, not a missing fill fallback', () => {
    const status = normalizeOrderStatus({
      data: {
        status: 'Contingent',
        legs: [{ quantity: 3, 'remaining-quantity': 3, fills: [] }],
      },
    });
    assert.equal(stopQuantityFromStatus(status), 3);
  });
});

describe('normalizeOrderStatus stop trigger and reject reason', () => {
  it('exposes stop-trigger and [6079] reject-reason from the raw child order', () => {
    const status = normalizeOrderStatus({
      data: {
        status: 'Rejected',
        'stop-trigger': '0.71',
        'reject-reason': '[6079] Stop Price Invalid',
        legs: [{ quantity: 1, 'remaining-quantity': 1, fills: [] }],
      },
    });
    assert.equal(status.stopTrigger, 0.71);
    assert.equal(status.rejectReason, '[6079] Stop Price Invalid');
    assert.equal(status.status, 'rejected');
  });
});
