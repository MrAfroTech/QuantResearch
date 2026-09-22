/**
 * Parse Tastytrade order fill state. remaining-quantity is authoritative for
 * what is still working; summed fills are authoritative for owned size.
 * Never treat requested quantity as a fill.
 */

const TERMINAL_NO_FILL_STATUSES = ['cancelled', 'canceled', 'expired', 'rejected'];

export function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstLeg(order) {
  const legs = order?.legs || order?.['order-legs'] || [];
  return Array.isArray(legs) ? legs[0] : null;
}

export function normalizeOrderStatus(orderJson) {
  const order = orderJson?.data || orderJson;
  const status = String(
    order?.status || order?.['order-status'] || order?.order_status || ''
  ).toLowerCase();
  const leg = firstLeg(order);
  const fills = leg?.fills || order?.fills || [];
  const fillList = Array.isArray(fills) ? fills : [];

  let fillPrice = null;
  let fillQuantity = 0;
  for (const fill of fillList) {
    const price = parseNumber(fill?.['fill-price'] ?? fill?.fill_price ?? fill?.price);
    const qty = parseNumber(fill?.quantity ?? fill?.['fill-quantity']);
    if (price != null) {
      fillPrice = fillPrice == null ? price : (fillPrice + price) / 2;
    }
    if (qty != null) fillQuantity += qty;
  }

  if (!fillPrice) {
    fillPrice = parseNumber(order?.['average-fill-price'] ?? order?.average_fill_price);
  }

  const requestedQuantity = parseNumber(
    leg?.quantity ?? order?.quantity ?? order?.size ?? order?.['order-size']
  );
  const remainingQuantity = parseNumber(
    leg?.['remaining-quantity'] ??
      leg?.remaining_quantity ??
      order?.['remaining-quantity'] ??
      order?.remaining_quantity
  );
  const remainingKnown = remainingQuantity != null;
  const terminalNoFill = TERMINAL_NO_FILL_STATUSES.includes(status);

  // Complete fill only. A live order with fills still working is not isFilled.
  const isFilled =
    status === 'filled' ||
    (fillQuantity > 0 && remainingKnown && remainingQuantity === 0) ||
    (fillQuantity > 0 && terminalNoFill);
  const isPartialFill = fillQuantity > 0 && !isFilled;
  const isTerminal = terminalNoFill || status === 'filled' || (isFilled && !isPartialFill);
  const stopTrigger = parseNumber(
    order?.['stop-trigger'] ?? order?.stop_trigger ?? leg?.['stop-trigger'] ?? leg?.stop_trigger
  );
  const rejectReason =
    order?.['reject-reason'] ??
    order?.reject_reason ??
    order?.['cancel-reason'] ??
    order?.cancel_reason ??
    null;

  return {
    status,
    isFilled,
    isPartialFill,
    isTerminal,
    fillPrice,
    fillQuantity,
    requestedQuantity,
    remainingQuantity,
    stopTrigger,
    rejectReason: rejectReason != null ? String(rejectReason) : null,
    raw: order,
  };
}

/** True when the broker has printed a usable fill premium (not the selection quote). */
export function hasConfirmedFillPrice(status) {
  const px = Number(status?.fillPrice);
  return Number.isFinite(px) && px > 0;
}

/**
 * Stop the fill poll only when we have a real price, or the order died with no fill.
 * Tastytrade can mark status=Filled before fills[] / average-fill-price land —
 * returning then books the construction-time quote as entry_premium.
 */
export function fillPollShouldReturn(status) {
  if (!status) return false;
  const s = String(status.status || '').toLowerCase();
  if (TERMINAL_NO_FILL_STATUSES.includes(s)) return true;
  if (hasConfirmedFillPrice(status) && (status.isFilled || status.isTerminal)) return true;
  return false;
}

/**
 * Quantity to book after the fill poll.
 * Observed fills (>=1) win, capped at the request. Zero/unknown fill books 0 —
 * never treat requested size as owned. Partial fills (1..requested-1) still book
 * the actual fill; that path is unchanged.
 */
export function bookedEntryQuantity({ requestedQuantity, fillQuantity } = {}) {
  const requested = Math.floor(Number(requestedQuantity));
  const filled = Math.floor(Number(fillQuantity));
  if (Number.isFinite(filled) && filled >= 1) {
    if (Number.isFinite(requested) && requested >= 1) return Math.min(filled, requested);
    return filled;
  }
  return 0;
}

export function entryHasBrokerLong(status) {
  return Math.floor(Number(status?.fillQuantity) || 0) >= 1;
}

/** Close reasons that must not burn the daily breakout / collision slot. */
export const NON_CLAIMING_CLOSE_REASONS = Object.freeze([
  'entry_unfilled_cancelled',
  'entry_never_filled',
]);

export function closeReasonClaimsBreakoutSlot(closeReason) {
  const reason = String(closeReason || '');
  if (!reason) return true;
  return !NON_CLAIMING_CLOSE_REASONS.includes(reason);
}

export function parseEntryMetadata(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * True when the row has a confirmed broker long.
 * Legacy rows without fill_quantity were insert-on-submit — treat as owned.
 * Explicit fill_quantity: 0 is the zero-fill phantom case — not owned.
 */
export function positionHasConfirmedBrokerLong(position) {
  const meta = parseEntryMetadata(position?.entry_metadata_json);
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'fill_quantity')) {
    return true;
  }
  return Math.floor(Number(meta.fill_quantity) || 0) >= 1;
}

/** OPEN insert only after a real fill (or a dry-run/simulated complete fill). */
export function shouldInsertOpenPosition({
  fillQuantity,
  bookedQuantity,
  dryRun = false,
  simulated = false,
} = {}) {
  if (dryRun || simulated) {
    const booked = Math.floor(Number(bookedQuantity));
    return Number.isFinite(booked) && booked >= 1;
  }
  return (
    Math.floor(Number(fillQuantity) || 0) >= 1 &&
    Math.floor(Number(bookedQuantity) || 0) >= 1
  );
}

export function stopQuantityFromStatus(status) {
  if (!status) return null;
  const requested = Math.floor(Number(status.requestedQuantity));
  if (Number.isFinite(requested) && requested >= 1) return requested;
  const remaining = Math.floor(Number(status.remainingQuantity));
  const filled = Math.floor(Number(status.fillQuantity) || 0);
  if (Number.isFinite(remaining) && remaining >= 0) {
    const total = remaining + (Number.isFinite(filled) ? Math.max(0, filled) : 0);
    return total >= 1 ? total : null;
  }
  return null;
}

export function isRestingStopStatus(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return false;
  return !['filled', 'cancelled', 'canceled', 'expired', 'rejected'].includes(s);
}

export function isConfirmedCancelledStatus(status) {
  if (status?.gone) return true;
  const s = String(status?.status || status || '').toLowerCase();
  return TERMINAL_NO_FILL_STATUSES.includes(s);
}

/** Tastytrade GET/DELETE of an already-gone order surfaces as HTTP 404. */
export function isBrokerOrderGoneError(err) {
  const msg = String(err?.message || err || '');
  return /\bfailed:\s*404\b/.test(msg) || (/\b404\b/.test(msg) && /not found|does not exist/i.test(msg));
}

export function isCancelConfirmed(result) {
  return Boolean(result?.cancelled === true || result?.gone === true);
}

/** STC / flatten: filled is not enough — a real fill premium must have landed. */
export function closeFillIsConfirmed(result) {
  if (result?.noBrokerPosition) return false;
  const filled = result?.filled === true || result?.isFilled === true;
  return filled && hasConfirmedFillPrice(result);
}

/** Broker-stop fill: require printed price and owned size before booking the close. */
export function brokerStopFillIsConfirmed(status) {
  if (!status?.isFilled) return false;
  if (!hasConfirmedFillPrice(status)) return false;
  return Math.floor(Number(status.fillQuantity) || 0) >= 1;
}

export function isConfirmedRestingStop(status) {
  if (!status) return false;
  if (status.gone || status.isFilled || status.isTerminal) return false;
  return isRestingStopStatus(status.status || status);
}

/**
 * OPEN insert only after a real fill *and* a confirmed fill premium.
 * Dry-run / simulated fills may book the connector's simulated price.
 */
export function shouldBookConfirmedEntry({
  fillQuantity,
  bookedQuantity,
  fillPrice,
  dryRun = false,
  simulated = false,
} = {}) {
  if (
    !shouldInsertOpenPosition({
      fillQuantity,
      bookedQuantity,
      dryRun,
      simulated,
    })
  ) {
    return false;
  }
  if (dryRun || simulated) return true;
  return hasConfirmedFillPrice({ fillPrice });
}
