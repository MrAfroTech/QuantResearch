/**
 * Zero-fill OPEN skip — shared by ORB and Premarket executors.
 *
 * A submitted-but-unfilled BTO must not become a live DB row. Working broker
 * orders are cancelled so they are not left untracked (next scan can retry;
 * the daily slot is not claimed).
 */

import { cancelBrokerOrder } from '../brokerageConnector.js';
import { isCancelConfirmed, shouldInsertOpenPosition } from './orderFillStatus.js';

export async function maybeSkipUnfilledOpenInsert({
  order,
  bookedQty,
  environment,
  strategy,
  ticker,
  direction,
  breakoutLevel,
  confirmTags = {},
  logEvent,
  cancelOrder = cancelBrokerOrder,
} = {}) {
  if (
    shouldInsertOpenPosition({
      fillQuantity: order?.fillQuantity,
      bookedQuantity: bookedQty,
      dryRun: order?.dryRun,
      simulated: order?.simulated,
    })
  ) {
    return { skipped: false };
  }

  if (!order?.dryRun && !order?.simulated) {
    for (const id of [order?.stopOrderId, order?.orderId].filter(Boolean)) {
      try {
        const cancelResult = await cancelOrder(id, { environment, strategy });
        if (!isCancelConfirmed(cancelResult)) {
          console.error(
            `[${strategy}] cancel unfilled working order ${id} not confirmed ` +
              `cancelled=${cancelResult?.cancelled} reason=${cancelResult?.reason || 'n/a'}`
          );
        }
      } catch (err) {
        console.warn(
          `[${strategy}] cancel unfilled working order ${id} failed:`,
          err.message
        );
      }
    }
  }

  if (typeof logEvent === 'function') {
    try {
      await logEvent({
        ticker,
        eventType: 'entry_unfilled',
        direction,
        breakoutLevel,
        details: {
          reason: 'entry_unfilled',
          order_id: order?.orderId ?? null,
          requested_quantity: order?.requestedQuantity ?? null,
          fill_quantity: order?.fillQuantity ?? 0,
          booked_quantity: bookedQty,
          ...confirmTags,
        },
      });
    } catch (err) {
      console.warn(`[${strategy}] entry_unfilled event persist failed:`, err.message);
    }
  }

  console.warn(
    `[${strategy}] Skip OPEN insert — zero broker fill order=${order?.orderId} ` +
      `requested=${order?.requestedQuantity} filled=${order?.fillQuantity ?? 0}`
  );

  return { skipped: true, reason: 'entry_unfilled' };
}
