import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignOtoChildStopToFilledQty,
  bookedEntryPremium,
  fillBasedStopParams,
  finalizeOtoPartialFill,
  isPartialEntryFill,
  isStopPriceInvalidRejection,
  isOtoChildAlreadyDead,
  isCancelFailureBecauseOrderDead,
  restingStopIdAfterAlign,
} from './otoStopQuantity.js';
import { shouldAlertEntryFillQty } from './entryFillAlerts.js';

function stopStatus(qty, status = 'Live', extras = {}) {
  return {
    status: status.toLowerCase(),
    requestedQuantity: qty,
    remainingQuantity: qty,
    fillQuantity: 0,
    isFilled: false,
    ...extras,
  };
}

const noSleep = async () => {};

describe('alignOtoChildStopToFilledQty', () => {
  it('leaves the child alone when Tastytrade already matches filled qty', async () => {
    const calls = { cancel: 0, place: 0 };
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: 'stop-1',
      filledQuantity: 2,
      getStatus: async () => stopStatus(2),
      cancelOrder: async () => {
        calls.cancel += 1;
      },
      placeStop: async (qty) => {
        calls.place += 1;
        return { orderId: `new-${qty}` };
      },
    });
    assert.equal(result.replaced, false);
    assert.equal(result.aligned, true);
    assert.equal(result.brokerDidMatch, true);
    assert.equal(result.stopOrderId, 'stop-1');
    assert.equal(calls.cancel, 0);
    assert.equal(calls.place, 0);
  });

  it('replaces the child when it still has the requested 3 against a 2-lot fill', async () => {
    const placed = [];
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: 'stop-3',
      filledQuantity: 2,
      getStatus: async () => stopStatus(3, 'Contingent'),
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'stop-2' };
      },
    });
    assert.equal(result.replaced, true);
    assert.equal(result.aligned, true);
    assert.equal(result.brokerDidMatch, false);
    assert.equal(result.observedStopQty, 3);
    assert.equal(result.stopOrderId, 'stop-2');
    assert.deepEqual(placed, [2]);
  });

  it('does not treat a failed re-place as aligned, and does not keep the cancelled child id', async () => {
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: 'stop-3',
      filledQuantity: 2,
      getStatus: async () => stopStatus(3, 'Contingent'),
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async () => {
        throw new Error('insufficient buying power');
      },
      placeAttempts: 3,
      sleep: noSleep,
    });
    assert.equal(result.aligned, false);
    assert.equal(result.replaced, false);
    assert.equal(result.stopOrderId, null);
    assert.equal(result.nakedAfterCancel, true);
    assert.equal(result.previousStopOrderId, 'stop-3');
    assert.match(result.reason, /insufficient buying power/);
    assert.equal(restingStopIdAfterAlign({ aligned: result, otoStopOrderId: 'stop-3' }), null);
  });

  it('retries place after cancel, then succeeds (73da548-class)', async () => {
    let places = 0;
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: 'stop-3',
      filledQuantity: 2,
      getStatus: async () => stopStatus(3),
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async (qty) => {
        places += 1;
        if (places < 3) throw new Error('temporary broker error');
        return { orderId: `stop-${qty}` };
      },
      placeAttempts: 3,
      sleep: noSleep,
    });
    assert.equal(result.aligned, true);
    assert.equal(result.replaced, true);
    assert.equal(result.stopOrderId, 'stop-2');
    assert.equal(places, 3);
    assert.equal(result.attempt, 3);
  });

  it('leaves a resting child alone when qty and fill-based trigger both match', async () => {
    const calls = { cancel: 0, place: 0 };
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: 'stop-1',
      filledQuantity: 1,
      expectedTrigger: 0.66,
      getStatus: async () => stopStatus(1, 'Live', { stopTrigger: 0.66 }),
      cancelOrder: async () => {
        calls.cancel += 1;
      },
      placeStop: async () => {
        calls.place += 1;
        return { orderId: 'should-not-place' };
      },
    });
    assert.equal(result.reason, 'already_matched');
    assert.equal(result.replaced, false);
    assert.equal(calls.cancel, 0);
    assert.equal(calls.place, 0);
  });

  it('replaces a resting child whose trigger is still the selection quote (ORB SPY #85 class)', async () => {
    const placed = [];
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: '500372319',
      filledQuantity: 1,
      expectedTrigger: 0.66,
      getStatus: async () =>
        stopStatus(1, 'Live', { stopTrigger: 0.71 }),
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'fill-based-stop' };
      },
    });
    assert.equal(result.replaced, true);
    assert.equal(result.aligned, true);
    assert.equal(result.reason, 'trigger_mismatch');
    assert.equal(result.observedTrigger, 0.71);
    assert.equal(result.expectedTrigger, 0.66);
    assert.deepEqual(placed, [1]);
  });

  it('resubmits after [6079] Stop Price Invalid using the fill-based expected trigger', async () => {
    const placed = [];
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: '500372319',
      filledQuantity: 1,
      expectedTrigger: 0.66,
      getStatus: async () =>
        stopStatus(1, 'Rejected', {
          stopTrigger: 0.71,
          rejectReason: '[6079] Stop Price Invalid',
        }),
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'fill-based-stop' };
      },
    });
    assert.equal(result.replaced, true);
    assert.equal(result.aligned, true);
    assert.equal(result.reason, 'stop_price_invalid');
    assert.equal(result.brokerDidMatch, false);
    assert.deepEqual(placed, [1]);
  });

  it('corrects qty and trigger in a single replace on the same fill', async () => {
    const placed = [];
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: 'stop-3',
      filledQuantity: 2,
      expectedTrigger: 0.66,
      getStatus: async () =>
        stopStatus(3, 'Contingent', { stopTrigger: 0.71 }),
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'stop-2' };
      },
    });
    assert.equal(result.replaced, true);
    assert.equal(result.reason, 'qty_mismatch_or_not_resting');
    assert.deepEqual(placed, [2]);
    assert.equal(result.observedTrigger, 0.71);
    assert.equal(result.expectedTrigger, 0.66);
  });

  it('still replaces a non-6079 rejection without classifying it as stop_price_invalid', async () => {
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: 'stop-1',
      filledQuantity: 1,
      expectedTrigger: 0.66,
      getStatus: async () =>
        stopStatus(1, 'Rejected', {
          stopTrigger: 0.66,
          rejectReason: 'insufficient buying power',
        }),
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async () => ({ orderId: 'retry-stop' }),
    });
    assert.equal(result.replaced, true);
    assert.equal(result.reason, 'qty_mismatch_or_not_resting');
    assert.equal(isStopPriceInvalidRejection({ rejectReason: 'insufficient buying power' }), false);
  });

  it('clears the stop id when a 6079 replace still fails', async () => {
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: '500372319',
      filledQuantity: 1,
      expectedTrigger: 0.66,
      getStatus: async () =>
        stopStatus(1, 'Rejected', {
          stopTrigger: 0.71,
          rejectReason: '[6079] Stop Price Invalid',
        }),
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async () => {
        throw new Error('[6079] Stop Price Invalid');
      },
      placeAttempts: 3,
      sleep: noSleep,
    });
    assert.equal(result.aligned, false);
    assert.equal(result.stopOrderId, null);
    assert.equal(restingStopIdAfterAlign({ aligned: result, otoStopOrderId: '500372319' }), null);
  });

  it('does not place a second stop when child cancel is not confirmed', async () => {
    const placed = [];
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: 'stop-3',
      filledQuantity: 2,
      getStatus: async () => stopStatus(3, 'Contingent'),
      cancelOrder: async () => ({ cancelled: false, reason: 'cancel_unconfirmed' }),
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'should-not-place' };
      },
    });
    assert.equal(result.aligned, false);
    assert.equal(result.reason, 'cancel_unconfirmed');
    assert.equal(result.nakedAfterCancel, false);
    assert.equal(result.stopOrderId, 'stop-3');
    assert.deepEqual(placed, []);
  });

  it('places a fill-based stop when 6079 child is already rejected and cancel hits cannot_update_order (#88)', async () => {
    const placed = [];
    let cancels = 0;
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: '500760357',
      filledQuantity: 1,
      expectedTrigger: 1.1,
      getStatus: async () =>
        stopStatus(1, 'Rejected', {
          stopTrigger: 1.12,
          rejectReason: '[6079] Stop Price Invalid',
          isTerminal: true,
        }),
      cancelOrder: async () => {
        cancels += 1;
        return { cancelled: false, reason: 'cannot_update_order' };
      },
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'fill-based-stop' };
      },
    });
    assert.equal(isOtoChildAlreadyDead({ status: 'rejected', isFilled: false }), true);
    assert.equal(isCancelFailureBecauseOrderDead('cannot_update_order'), true);
    assert.equal(cancels, 0);
    assert.equal(result.replaced, true);
    assert.equal(result.aligned, true);
    assert.equal(result.reason, 'stop_price_invalid');
    assert.equal(result.stopOrderId, 'fill-based-stop');
    assert.deepEqual(placed, [1]);
  });

  it('places when cancel throws cannot_update_order even if GET did not classify rejected', async () => {
    const placed = [];
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: '500760357',
      filledQuantity: 1,
      expectedTrigger: 1.1,
      getStatus: async () => stopStatus(1, 'Unknown', { stopTrigger: 1.12 }),
      cancelOrder: async () => {
        throw new Error(
          'Tastytrade /orders/500760357 failed: 422 {"error":{"code":"cannot_update_order"}}'
        );
      },
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'fill-based-stop' };
      },
    });
    assert.equal(result.replaced, true);
    assert.equal(result.aligned, true);
    assert.deepEqual(placed, [1]);
  });

  it('does not place a second stop when the child already filled', async () => {
    const placed = [];
    const result = await alignOtoChildStopToFilledQty({
      stopOrderId: 'stop-filled',
      filledQuantity: 1,
      getStatus: async () => ({
        status: 'filled',
        isFilled: true,
        isTerminal: true,
        fillQuantity: 1,
        fillPrice: 1.03,
        requestedQuantity: 1,
        remainingQuantity: 0,
        stopTrigger: 1.1,
      }),
      cancelOrder: async () => ({ cancelled: false, reason: 'cannot_update_order' }),
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'should-not-place' };
      },
    });
    assert.equal(result.aligned, false);
    assert.equal(result.reason, 'child_already_filled');
    assert.equal(result.stopOrderId, null);
    assert.deepEqual(placed, []);
  });
});

describe('finalizeOtoPartialFill', () => {
  it('cancels the unfilled remainder then replaces a 3-lot child with 2', async () => {
    const cancelled = [];
    const placed = [];
    const result = await finalizeOtoPartialFill({
      triggerOrderId: 'entry-1',
      stopOrderId: 'stop-3',
      requestedQuantity: 3,
      fillStatus: {
        status: 'live',
        fillQuantity: 2,
        remainingQuantity: 1,
        isFilled: false,
        isPartialFill: true,
      },
      getStatus: async (id) => {
        if (id === 'stop-3') return stopStatus(3, 'Contingent');
        if (id === 'entry-1') {
          return {
            status: 'cancelled',
            fillQuantity: 2,
            remainingQuantity: 0,
            requestedQuantity: 3,
            isFilled: true,
          };
        }
        return { status: 'unknown' };
      },
      cancelOrder: async (id) => {
        cancelled.push(id);
        return { cancelled: true };
      },
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'stop-2' };
      },
    });

    assert.equal(result.cancelledRemainder, true);
    assert.equal(result.bookedQuantity, 2);
    assert.equal(result.observedStopQty, 3);
    assert.equal(result.brokerDidMatch, false);
    assert.equal(result.aligned.replaced, true);
    assert.equal(result.aligned.stopOrderId, 'stop-2');
    assert.ok(cancelled.includes('entry-1'));
    assert.deepEqual(placed, [2]);
  });

  it('does not cancel or replace the child when the trigger has not filled yet', async () => {
    const cancelled = [];
    const placed = [];
    const result = await finalizeOtoPartialFill({
      triggerOrderId: 'entry-1',
      stopOrderId: 'stop-3',
      requestedQuantity: 3,
      fillStatus: {
        status: 'live',
        fillQuantity: 0,
        remainingQuantity: 3,
        isFilled: false,
      },
      getStatus: async () => stopStatus(3, 'Contingent'),
      cancelOrder: async (id) => {
        cancelled.push(id);
      },
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: `new-${qty}` };
      },
    });
    assert.equal(result.bookedQuantity, 0);
    assert.equal(result.brokerDidMatch, false);
    assert.equal(result.aligned.reason, 'no_fill_yet');
    assert.equal(result.aligned.brokerDidMatch, false);
    assert.equal(result.aligned.stopOrderId, 'stop-3');
    assert.deepEqual(cancelled, []);
    assert.deepEqual(placed, []);
  });
});

describe('partial-fill alert gating', () => {
  it('alerts on a 2-of-3 book even when the stop already matched', () => {
    assert.equal(
      isPartialEntryFill({ requestedQuantity: 3, fillQuantity: 2, bookedQuantity: 2 }),
      true
    );
    assert.equal(
      shouldAlertEntryFillQty({
        requestedQuantity: 3,
        fillQuantity: 2,
        bookedQuantity: 2,
        stopAlignFailed: false,
      }),
      true
    );
  });

  it('alerts on stop-align failure even for a full fill', () => {
    assert.equal(
      shouldAlertEntryFillQty({
        requestedQuantity: 3,
        fillQuantity: 3,
        bookedQuantity: 3,
        stopAlignFailed: true,
      }),
      true
    );
  });

  it('does not alert a clean full fill', () => {
    assert.equal(
      shouldAlertEntryFillQty({
        requestedQuantity: 3,
        fillQuantity: 3,
        bookedQuantity: 3,
        stopAlignFailed: false,
      }),
      false
    );
  });
});

describe('restingStopIdAfterAlign', () => {
  it('clears the stop id after a failed replace so retry is not skipped', () => {
    assert.equal(
      restingStopIdAfterAlign({
        aligned: { aligned: false, stopOrderId: null },
        otoStopOrderId: 'stop-3',
      }),
      null
    );
  });

  it('keeps a successfully replaced stop id', () => {
    assert.equal(
      restingStopIdAfterAlign({
        aligned: { aligned: true, stopOrderId: 'stop-2' },
        otoStopOrderId: 'stop-3',
      }),
      'stop-2'
    );
  });
});

describe('fill-based stop trigger', () => {
  it('matches [6079] / Stop Price Invalid only', () => {
    assert.equal(isStopPriceInvalidRejection('[6079] Stop Price Invalid'), true);
    assert.equal(
      isStopPriceInvalidRejection({ rejectReason: '[6079] Stop Price Invalid' }),
      true
    );
    assert.equal(
      isStopPriceInvalidRejection({
        raw: { 'reject-reason': 'Stop Price Invalid' },
      }),
      true
    );
    assert.equal(isStopPriceInvalidRejection('insufficient buying power'), false);
    assert.equal(isStopPriceInvalidRejection({ rejectReason: 'order cancelled' }), false);
  });

  it('recomputes the ORB SPY #85 trigger from the $0.67 fill, not the $0.715 mid', () => {
    const params = fillBasedStopParams(
      { stopTrigger: 0.71, stopPnlFrac: -0.01, orderType: 'stop' },
      0.67
    );
    assert.equal(params.fromFill, true);
    assert.equal(params.stopTrigger, 0.66);
    assert.equal(bookedEntryPremium(0.67, 0.715), 0.67);
    assert.equal(bookedEntryPremium(null, 0.715), 0.715);
  });

  it('re-GETs the trigger when finalize is missing a fill price', async () => {
    const gets = [];
    const result = await finalizeOtoPartialFill({
      triggerOrderId: '500372318',
      stopOrderId: '500372319',
      requestedQuantity: 1,
      fillStatus: {
        status: 'filled',
        fillQuantity: 1,
        remainingQuantity: 0,
        fillPrice: null,
        isFilled: true,
      },
      fillPrice: null,
      stopPnlFrac: -0.01,
      getStatus: async (id) => {
        gets.push(id);
        if (id === '500372318') {
          return { status: 'filled', fillQuantity: 1, fillPrice: 0.67 };
        }
        return stopStatus(1, 'Live', { stopTrigger: 0.66 });
      },
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async () => ({ orderId: 'keep' }),
    });
    assert.ok(gets.includes('500372318'));
    assert.equal(result.fillStatus?.fillPrice, 0.67);
    assert.equal(result.expectedTrigger, 0.66);
  });

  it('replaces a full-fill child in finalize when the trigger is still the selection quote', async () => {
    const placed = [];
    const result = await finalizeOtoPartialFill({
      triggerOrderId: '500372318',
      stopOrderId: '500372319',
      requestedQuantity: 1,
      fillStatus: {
        status: 'filled',
        fillQuantity: 1,
        remainingQuantity: 0,
        fillPrice: 0.67,
        isFilled: true,
      },
      fillPrice: 0.67,
      stopPnlFrac: -0.01,
      getStatus: async (id) => {
        if (id === '500372319') {
          return stopStatus(1, 'Rejected', {
            stopTrigger: 0.71,
            rejectReason: '[6079] Stop Price Invalid',
          });
        }
        return { status: 'filled', fillQuantity: 1, fillPrice: 0.67 };
      },
      cancelOrder: async () => ({ cancelled: true }),
      placeStop: async (qty) => {
        placed.push(qty);
        return { orderId: 'fill-based-stop' };
      },
    });
    assert.equal(result.expectedTrigger, 0.66);
    assert.equal(result.brokerDidMatch, false);
    assert.equal(result.aligned.reason, 'stop_price_invalid');
    assert.equal(result.aligned.replaced, true);
    assert.deepEqual(placed, [1]);
    assert.equal(
      shouldAlertEntryFillQty({
        requestedQuantity: 1,
        fillQuantity: 1,
        bookedQuantity: 1,
        stopAlignFailed: false,
      }),
      false
    );
  });
});
