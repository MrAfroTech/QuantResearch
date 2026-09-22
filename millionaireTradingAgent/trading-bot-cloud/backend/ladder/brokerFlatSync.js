/**
 * DB OPEN vs live broker book. If Tastytrade is already flat, stop treating
 * the row as a live long (retry loops / ghost monitors).
 *
 * Only books a close when a Sell-to-Close print exists — positions-API lag
 * right after BTO must not close a real long at $0 pnl.
 */

import {
  findLatestSellToCloseFill,
  getLiveOptionPositionQuantity,
} from '../brokerageConnector.js';
import { hasConfirmedFillPrice } from './orderFillStatus.js';

export function pnlFracFromPremiums(entryPremium, exitPremium) {
  const entry = Number(entryPremium);
  const exit = Number(exitPremium);
  if (Number.isFinite(entry) && entry > 0 && Number.isFinite(exit)) {
    return (exit - entry) / entry;
  }
  return 0;
}

export async function settleDbOpenIfBrokerFlat(position, {
  environment,
  strategy,
  fullClosePosition,
  onNotify = null,
  brokerQty = undefined,
  getLiveQuantity = getLiveOptionPositionQuantity,
  findCloseFill = findLatestSellToCloseFill,
} = {}) {
  let qty = brokerQty;
  if (qty === undefined) {
    qty = await getLiveQuantity(position, { environment, strategy });
  }
  if (qty == null) return { settled: false, reason: 'broker_lookup_failed' };
  if (qty >= 1) return { settled: false, reason: 'broker_still_long' };

  const fill = await findCloseFill(position, { environment, strategy });
  const fillPrice = Number(fill?.price ?? fill?.fillPrice);
  if (!hasConfirmedFillPrice({ fillPrice })) {
    return { settled: false, reason: 'broker_flat_no_stc_fill', brokerFlat: true };
  }

  if (typeof fullClosePosition !== 'function') {
    return {
      settled: false,
      reason: 'broker_already_flat',
      brokerFlat: true,
      exitPremium: fillPrice,
      skippedBook: true,
    };
  }

  const pnlFrac = pnlFracFromPremiums(position.entry_premium, fillPrice);
  const closeQty =
    Number(position.contracts_open) || Number(position.quantity) || 1;

  await fullClosePosition(
    position.id,
    fillPrice,
    pnlFrac * 100,
    'broker_already_flat',
    closeQty
  );
  if (typeof onNotify === 'function') {
    try {
      await onNotify(position, 'broker_already_flat', pnlFrac, fillPrice, closeQty, {
        brokerAlreadyFlat: true,
      });
    } catch (err) {
      console.error(
        `[Ladder] broker-flat notify failed #${position?.id}:`,
        err.message
      );
    }
  }
  return {
    settled: true,
    reason: 'broker_already_flat',
    exitPremium: fillPrice,
    pnlFrac,
    brokerFlat: true,
  };
}
