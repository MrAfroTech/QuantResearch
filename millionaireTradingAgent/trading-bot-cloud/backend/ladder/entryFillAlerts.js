/**
 * Loud partial-fill / OTO stop-align notifications.
 * Must not live in logs only — first real 2-of-3 cannot be another silent find.
 */

import {
  isPartialEntryFill,
  OTO_STOP_ALIGN_FAILED,
  PARTIAL_FILL_BOOKED,
} from './otoStopQuantity.js';

export { isPartialEntryFill, OTO_STOP_ALIGN_FAILED, PARTIAL_FILL_BOOKED };

export function shouldAlertEntryFillQty({
  requestedQuantity,
  fillQuantity,
  bookedQuantity,
  stopAlignFailed,
} = {}) {
  return (
    Boolean(stopAlignFailed) ||
    isPartialEntryFill({ requestedQuantity, fillQuantity, bookedQuantity })
  );
}

export async function reportEntryFillQty({
  strategy,
  ticker,
  direction,
  strike,
  positionId,
  breakoutLevel = null,
  requestedQty,
  bookedQty,
  order,
  logEvent = null,
}) {
  const stopAlignFailed = Boolean(order?.stopAlignFailed);
  const fillQuantity = order?.fillQuantity;
  if (
    !shouldAlertEntryFillQty({
      requestedQuantity: requestedQty,
      fillQuantity,
      bookedQuantity: bookedQty,
      stopAlignFailed,
    })
  ) {
    return { sent: false, logged: false };
  }

  const payload = {
    strategy,
    ticker,
    direction,
    strike,
    positionId,
    requestedQty,
    bookedQty,
    fillQuantity,
    observedStopQty: order?.observedOtoStopQty ?? null,
    stopReplaced: Boolean(order?.stopQtyReplaced),
    brokerStopMatchedFill: Boolean(order?.brokerStopMatchedFill),
    stopAlignFailed,
    stopOrderId: order?.stopOrderId ?? null,
    reason: order?.stopAlignReason || null,
  };

  if (stopAlignFailed) {
    console.error(
      `[${strategy}] OTO_STOP_ALIGN_FAILED #${positionId} ${ticker} ` +
        `booked=${bookedQty} requested=${requestedQty} filled=${fillQuantity ?? 'n/a'} ` +
        `otoChildStopQty=${payload.observedStopQty ?? 'n/a'} reason=${payload.reason || 'unknown'}`
    );
  } else {
    console.warn(
      `[${strategy}] PARTIAL_FILL_BOOKED #${positionId} ${ticker} ` +
        `booked=${bookedQty} requested=${requestedQty} filled=${fillQuantity ?? 'n/a'} ` +
        `otoChildStopQty=${payload.observedStopQty ?? 'n/a'} ` +
        `brokerStopMatchedFill=${payload.brokerStopMatchedFill} stopReplaced=${payload.stopReplaced}`
    );
  }

  const { sendEntryFillQtyTelegram } = await import('../telegramHandler.js');
  let sent = false;
  try {
    const result = await sendEntryFillQtyTelegram(payload);
    sent = Boolean(result?.sent);
  } catch (err) {
    console.error(`[${strategy}] entry fill qty telegram failed:`, err.message);
  }

  let logged = false;
  if (typeof logEvent === 'function') {
    try {
      await logEvent({
        ticker,
        eventType: stopAlignFailed ? OTO_STOP_ALIGN_FAILED : PARTIAL_FILL_BOOKED,
        direction,
        breakoutLevel,
        details: payload,
      });
      logged = true;
    } catch (err) {
      console.error(`[${strategy}] entry fill qty event log failed:`, err.message);
    }
  }

  return { sent, logged, stopAlignFailed };
}
