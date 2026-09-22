/**
 * After an OTO trigger fill, inspect the child stop and replace it when
 * quantity or trigger price does not match the actual fill.
 *
 * Tastytrade's API does not document auto-resizing the OTO child when the
 * trigger partially fills. The child is submitted at place time with the
 * requested quantity and a stop trigger computed from the pre-trade quote
 * (see buildOtoEntryStopBody). A worse fill can leave that trigger already
 * breached — Tastytrade rejects `[6079] Stop Price Invalid` and the book is
 * naked. We GET the child after the fill and correct qty and/or price with
 * cancel + independent stop at filled size and fill-based trigger.
 */

import { nextStopRetryBackoffMs } from './initialStopRetry.js';
import { computeStopLimitPrice, computeStopTriggerPrice } from './ladderConfig.js';
import {
  bookedEntryQuantity,
  isBrokerOrderGoneError,
  isCancelConfirmed,
  isRestingStopStatus,
  stopQuantityFromStatus,
} from './orderFillStatus.js';

/** Same inline wave as 73da548 partial-lock replace (2s+4s+8s). */
export const OTO_STOP_ALIGN_INLINE_ATTEMPTS = 3;

export const PARTIAL_FILL_BOOKED = 'partial_fill_booked';
export const OTO_STOP_ALIGN_FAILED = 'oto_stop_align_failed';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeGetStatus(getStatus, orderId) {
  if (!orderId || typeof getStatus !== 'function') return null;
  try {
    return await getStatus(orderId);
  } catch (err) {
    return { error: String(err?.message || err), status: 'error' };
  }
}

export function isPartialEntryFill({ requestedQuantity, fillQuantity, bookedQuantity } = {}) {
  const requested = Math.floor(Number(requestedQuantity));
  const filled = Math.floor(Number(fillQuantity));
  const booked = Math.floor(Number(bookedQuantity));
  return filled >= 1 && booked >= 1 && requested > booked;
}

/** Book the broker fill premium when present; otherwise the selection quote. */
export function bookedEntryPremium(fillPrice, fallbackPremium) {
  const fill = Number(fillPrice);
  if (Number.isFinite(fill) && fill > 0) return fill;
  const fallback = Number(fallbackPremium);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

/**
 * Tastytrade `[6079] Stop Price Invalid` — child trigger is already through
 * the market (typically computed from the pre-trade mid, then fill printed worse).
 * Do not treat other reject codes as this case.
 */
export function isStopPriceInvalidRejection(statusOrReason) {
  const chunks = [];
  if (statusOrReason == null) return false;
  if (typeof statusOrReason === 'string' || typeof statusOrReason === 'number') {
    chunks.push(String(statusOrReason));
  } else if (typeof statusOrReason === 'object') {
    chunks.push(
      statusOrReason.rejectReason,
      statusOrReason.reason,
      statusOrReason.error,
      statusOrReason.status,
      statusOrReason.raw?.['reject-reason'],
      statusOrReason.raw?.reject_reason,
      statusOrReason.raw?.['cancel-reason']
    );
  }
  const text = chunks.filter((v) => v != null && v !== '').join(' ');
  return /\[6079\]|stop price invalid/i.test(text);
}

export function stopTriggerFromStatus(status) {
  const n = Number(status?.stopTrigger ?? status?.raw?.['stop-trigger'] ?? status?.raw?.stop_trigger);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function stopTriggersMatch(observed, expected) {
  const a = Number(observed);
  const b = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.round(a * 100) === Math.round(b * 100);
}

/**
 * Child is already terminal with no fill — cancel is impossible, not "resisting".
 * Rejected / cancelled / expired / gone: place a fresh fill-based stop.
 * Filled: do NOT place (the stop already closed the long).
 * Lookup failure: not proven dead.
 */
export function isOtoChildAlreadyDead(status) {
  if (!status || status.error) return false;
  if (status.isFilled) return false;
  if (status.gone) return true;
  const s = String(status.status || '').toLowerCase();
  return ['rejected', 'cancelled', 'canceled', 'expired'].includes(s);
}

/** Tastytrade `cannot_update_order` / 404 — the order is not in a cancellable state. */
export function isCancelFailureBecauseOrderDead(cancelErrorOrResult) {
  if (cancelErrorOrResult == null) return false;
  if (isBrokerOrderGoneError(cancelErrorOrResult)) return true;
  const msg = [
    cancelErrorOrResult?.reason,
    cancelErrorOrResult?.error,
    cancelErrorOrResult?.message,
    typeof cancelErrorOrResult === 'string' ? cancelErrorOrResult : null,
  ]
    .filter((v) => v != null && v !== '')
    .join(' ');
  if (!msg) return false;
  if (isBrokerOrderGoneError(msg)) return true;
  return /cannot_update_order|cannot update order/i.test(msg);
}

export function expectedStopTriggerFromFill(fillPrice, stopPnlFrac) {
  return computeStopTriggerPrice(fillPrice, stopPnlFrac);
}

/**
 * Independent stop params after the entry fill is known.
 * Falls back to the pre-trade selection trigger only when fill price is missing.
 */
export function fillBasedStopParams(initialStop, fillPrice) {
  const fillPx = Number(fillPrice);
  const stopPnlFrac = Number(initialStop?.stopPnlFrac);
  const fallback = {
    stopTrigger: initialStop?.stopTrigger ?? null,
    limitPrice: initialStop?.limitPrice ?? null,
    orderType: initialStop?.orderType ?? null,
    fromFill: false,
  };
  if (!(Number.isFinite(fillPx) && fillPx > 0 && Number.isFinite(stopPnlFrac))) {
    return fallback;
  }
  const stopTrigger = computeStopTriggerPrice(fillPx, stopPnlFrac);
  if (!(Number(stopTrigger) > 0)) return fallback;
  const orderType = initialStop?.orderType ?? null;
  const isStopLimit = String(orderType || '').toLowerCase() === 'stop_limit';
  return {
    stopTrigger,
    limitPrice: isStopLimit ? computeStopLimitPrice(stopTrigger) : (initialStop?.limitPrice ?? null),
    orderType,
    fromFill: true,
  };
}

function replaceReasonAfterInspect({ rejectedInvalid, qtyAndResting, triggerOk }) {
  if (rejectedInvalid) return 'stop_price_invalid';
  if (qtyAndResting && !triggerOk) return 'trigger_mismatch';
  return 'qty_mismatch_or_not_resting';
}

/**
 * Never keep a stale/cancelled OTO child id after a failed align.
 * Failed align → null so the executor kicks the unprotected-stop retry loop.
 */
export function restingStopIdAfterAlign({ aligned, otoStopOrderId } = {}) {
  if (aligned?.aligned) return aligned.stopOrderId || otoStopOrderId || null;
  return null;
}

export async function alignOtoChildStopToFilledQty({
  stopOrderId,
  filledQuantity,
  expectedTrigger = null,
  getStatus,
  cancelOrder,
  placeStop,
  placeAttempts = OTO_STOP_ALIGN_INLINE_ATTEMPTS,
  sleep = defaultSleep,
}) {
  const filled = Math.floor(Number(filledQuantity));
  const expected =
    Number(expectedTrigger) > 0 ? Math.round(Number(expectedTrigger) * 100) / 100 : null;
  if (!(filled >= 1)) {
    return {
      aligned: false,
      replaced: false,
      reason: 'no_filled_quantity',
      stopOrderId: stopOrderId || null,
      observedStopQty: null,
      observedTrigger: null,
      expectedTrigger: expected,
      brokerDidMatch: false,
      filledQuantity: filled,
      nakedAfterCancel: false,
    };
  }

  const stopStatus = await safeGetStatus(getStatus, stopOrderId);
  const observedStopQty = stopQuantityFromStatus(stopStatus);
  const observedTrigger = stopTriggerFromStatus(stopStatus);
  const rejectedInvalid = isStopPriceInvalidRejection(stopStatus);
  const qtyAndResting =
    observedStopQty === filled && isRestingStopStatus(stopStatus?.status);
  const triggerOk = expected == null || stopTriggersMatch(observedTrigger, expected);
  const brokerDidMatch = qtyAndResting && triggerOk && !rejectedInvalid;

  if (brokerDidMatch) {
    return {
      aligned: true,
      replaced: false,
      reason: 'already_matched',
      stopOrderId,
      observedStopQty,
      observedTrigger,
      expectedTrigger: expected,
      brokerDidMatch: true,
      filledQuantity: filled,
      nakedAfterCancel: false,
    };
  }

  const inspectReason = replaceReasonAfterInspect({
    rejectedInvalid,
    qtyAndResting,
    triggerOk,
  });
  console.warn(
    `[OtoStop] child needs replace reason=${inspectReason} order=${stopOrderId || 'none'} ` +
      `filledQty=${filled} observedQty=${observedStopQty ?? 'n/a'} ` +
      `observedTrigger=$${observedTrigger ?? 'n/a'} expectedTrigger=$${expected ?? 'n/a'} ` +
      `resting=${isRestingStopStatus(stopStatus?.status)} ` +
      `reject=${stopStatus?.rejectReason || stopStatus?.status || 'n/a'}`
  );

  if (stopStatus?.isFilled) {
    console.error(
      `[OtoStop] ALIGN FAILED filled=${filled} order=${stopOrderId || 'none'} ` +
        `reason=child_already_filled — not submitting a second stop`
    );
    return {
      aligned: false,
      replaced: false,
      reason: 'child_already_filled',
      stopOrderId: null,
      previousStopOrderId: stopOrderId || null,
      observedStopQty,
      observedTrigger,
      expectedTrigger: expected,
      brokerDidMatch: false,
      filledQuantity: filled,
      nakedAfterCancel: false,
    };
  }

  let cancelledChild = false;
  let cancelError = null;
  const childAlreadyDead = isOtoChildAlreadyDead(stopStatus);
  if (childAlreadyDead) {
    console.warn(
      `[OtoStop] child already terminal status=${stopStatus?.status || 'n/a'} ` +
        `order=${stopOrderId || 'none'} — skip cancel, place fill-based stop`
    );
  } else if (stopOrderId && typeof cancelOrder === 'function') {
    try {
      const cancelResult = await cancelOrder(stopOrderId);
      cancelledChild = isCancelConfirmed(cancelResult);
      if (!cancelledChild) {
        cancelError = cancelResult?.reason || 'cancel_unconfirmed';
        console.error(
          `[OtoStop] child cancel not confirmed order=${stopOrderId} filled=${filled} ` +
            `reason=${cancelError}`
        );
      }
    } catch (err) {
      cancelError = String(err?.message || err);
      console.error(
        `[OtoStop] child cancel failed order=${stopOrderId} filled=${filled} ` +
          `observed=${observedStopQty ?? 'n/a'} error=${cancelError}`
      );
    }
  }

  const cancelFailedBecauseDead = isCancelFailureBecauseOrderDead(cancelError);
  const mayPlaceReplacement =
    cancelledChild || childAlreadyDead || cancelFailedBecauseDead || !stopOrderId;

  if (stopOrderId && !mayPlaceReplacement) {
    console.error(
      `[OtoStop] ALIGN FAILED filled=${filled} observed=${observedStopQty ?? 'n/a'} ` +
        `reason=cancel_unconfirmed — not submitting a second stop`
    );
    return {
      aligned: false,
      replaced: false,
      reason: cancelError || 'cancel_unconfirmed',
      stopOrderId,
      previousStopOrderId: stopOrderId,
      observedStopQty,
      observedTrigger,
      expectedTrigger: expected,
      brokerDidMatch: false,
      filledQuantity: filled,
      nakedAfterCancel: false,
      cancelError,
    };
  }

  if (typeof placeStop !== 'function') {
    console.error(
      `[OtoStop] ALIGN FAILED filled=${filled} observed=${observedStopQty ?? 'n/a'} ` +
        `reason=no_place_stop cancelledChild=${cancelledChild}`
    );
    return {
      aligned: false,
      replaced: false,
      reason: 'no_place_stop',
      stopOrderId: null,
      previousStopOrderId: stopOrderId || null,
      observedStopQty,
      observedTrigger,
      expectedTrigger: expected,
      brokerDidMatch: false,
      filledQuantity: filled,
      nakedAfterCancel: cancelledChild,
      cancelError,
    };
  }

  const attempts = Math.max(1, Math.floor(Number(placeAttempts) || 1));
  let lastReason = 'place_stop_failed';
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const placed = await placeStop(filled);
      if (placed?.orderId) {
        if (attempt > 1) {
          console.error(
            `[OtoStop] stop re-placed after ${attempt} attempt(s) ` +
              `filled=${filled} observed=${observedStopQty ?? 'n/a'} order=${placed.orderId}`
          );
        }
        return {
          aligned: true,
          replaced: true,
          reason: inspectReason,
          stopOrderId: placed.orderId,
          previousStopOrderId: stopOrderId || null,
          observedStopQty,
          observedTrigger,
          expectedTrigger: expected,
          brokerDidMatch: false,
          filledQuantity: filled,
          nakedAfterCancel: false,
          attempt,
        };
      }
      lastReason = 'place_stop_no_order_id';
    } catch (err) {
      lastError = String(err?.message || err);
      lastReason = lastError;
    }

    console.error(
      `[OtoStop] place failed attempt=${attempt}/${attempts} filled=${filled} ` +
        `observed=${observedStopQty ?? 'n/a'} cancelledChild=${cancelledChild} ` +
        `reason=${lastReason}`
    );

    if (attempt < attempts) {
      await sleep(nextStopRetryBackoffMs(attempt));
    }
  }

  console.error(
    `[OtoStop] ALIGN FAILED filled=${filled} observed=${observedStopQty ?? 'n/a'} ` +
      `cancelledChild=${cancelledChild} reason=${lastReason} — stopOrderId cleared for retry loop`
  );

  return {
    aligned: false,
    replaced: false,
    reason: lastReason,
    stopOrderId: null,
    previousStopOrderId: stopOrderId || null,
    observedStopQty,
    observedTrigger,
    expectedTrigger: expected,
    brokerDidMatch: false,
    filledQuantity: filled,
    nakedAfterCancel: cancelledChild,
    cancelError,
    error: lastError,
    attempts,
  };
}

/**
 * Lock in a partial trigger fill, capture the child's native qty for evidence,
 * then make the resting stop match owned size.
 */
export async function finalizeOtoPartialFill({
  triggerOrderId,
  stopOrderId,
  requestedQuantity,
  fillStatus,
  fillPrice,
  fillCtx = null,
  stopPnlFrac,
  getStatus,
  cancelOrder,
  placeStop,
  placeAttempts = OTO_STOP_ALIGN_INLINE_ATTEMPTS,
  sleep = defaultSleep,
}) {
  const observedBefore = await safeGetStatus(getStatus, stopOrderId);
  const observedStopQty = stopQuantityFromStatus(observedBefore);

  let latestFill = fillStatus;
  const remaining = Number(latestFill?.remainingQuantity);
  const filledSoFar = Math.floor(Number(latestFill?.fillQuantity) || 0);
  let cancelledRemainder = false;
  if (filledSoFar >= 1 && remaining > 0 && triggerOrderId && typeof cancelOrder === 'function') {
    try {
      const cancelResult = await cancelOrder(triggerOrderId);
      cancelledRemainder = isCancelConfirmed(cancelResult);
      if (cancelledRemainder) {
        latestFill = (await safeGetStatus(getStatus, triggerOrderId)) || latestFill;
      } else {
        console.error(
          `[OtoStop] trigger remainder cancel not confirmed order=${triggerOrderId} ` +
            `reason=${cancelResult?.reason || 'n/a'}`
        );
      }
    } catch (err) {
      console.error(
        `[OtoStop] trigger remainder cancel failed order=${triggerOrderId}:`,
        err.message
      );
      latestFill = {
        ...latestFill,
        remainderCancelError: String(err?.message || err),
      };
    }
  }

  const bookedQuantity = bookedEntryQuantity({
    requestedQuantity,
    fillQuantity: latestFill?.fillQuantity,
  });
  const fillQty = Math.floor(Number(latestFill?.fillQuantity) || 0);
  let fillPx = Number(fillPrice ?? latestFill?.fillPrice ?? fillCtx?.price);
  if (!(Number.isFinite(fillPx) && fillPx > 0) && fillQty >= 1 && triggerOrderId) {
    const refreshed = await safeGetStatus(getStatus, triggerOrderId);
    if (refreshed) {
      latestFill = refreshed;
      fillPx = Number(refreshed.fillPrice);
    }
  }
  if (fillCtx && Number.isFinite(fillPx) && fillPx > 0) {
    fillCtx.price = fillPx;
  }
  const expectedTrigger =
    Number.isFinite(fillPx) && fillPx > 0 && Number.isFinite(Number(stopPnlFrac))
      ? expectedStopTriggerFromFill(fillPx, stopPnlFrac)
      : null;

  let aligned;
  if (fillQty >= 1 && bookedQuantity >= 1) {
    aligned = await alignOtoChildStopToFilledQty({
      stopOrderId,
      filledQuantity: bookedQuantity,
      expectedTrigger,
      getStatus,
      cancelOrder,
      placeStop,
      placeAttempts,
      sleep,
    });
  } else {
    aligned = {
      aligned: true,
      replaced: false,
      reason: 'no_fill_yet',
      stopOrderId,
      observedStopQty,
      observedTrigger: stopTriggerFromStatus(observedBefore),
      expectedTrigger,
      brokerDidMatch: false,
      filledQuantity: fillQty,
      nakedAfterCancel: false,
    };
  }

  return {
    fillStatus: latestFill,
    bookedQuantity,
    cancelledRemainder,
    observedStopQty,
    expectedTrigger,
    brokerDidMatch: Boolean(aligned.brokerDidMatch),
    aligned: {
      ...aligned,
      observedStopQty,
      brokerDidMatch: fillQty >= 1 ? aligned.brokerDidMatch : false,
    },
  };
}
