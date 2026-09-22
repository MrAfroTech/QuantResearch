/**
 * Tastytrade OTO (one-triggers-other) entry + protective stop.
 *
 * OTOCO is entry + take-profit + stop as an OCO pair. We use OTO — trigger BTO
 * plus a single STC stop — so the ladder can still cancel/replace that stop
 * after fill. A bracket profit-target would fight milestone replaceStop.
 *
 * @see https://tastyworks-api.readthedocs.io/en/latest/api/order.html (OTOOrder)
 */

import {
  LADDER_STOP_ORDER_TYPE,
  computeStopLimitPrice,
  resolveLadderStopOrderType,
} from './ladderConfig.js';

export const OTO_COMPLEX_TYPE = 'OTO';

export function buildOtoEntryStopBody({
  optionSymbol,
  quantity,
  entryPrice,
  stopTrigger,
  stopOrderType = null,
  stopLimitPrice = null,
}) {
  const qty = Number(quantity);
  const entry = Number(entryPrice);
  const trigger = Number(stopTrigger);
  if (!optionSymbol) throw new Error('OTO body requires optionSymbol');
  if (!Number.isFinite(qty) || qty < 1) throw new Error('OTO body requires quantity >= 1');
  if (!Number.isFinite(entry) || entry <= 0) throw new Error('OTO body requires a positive entry price');
  if (!Number.isFinite(trigger) || trigger <= 0) throw new Error('OTO body requires a positive stop trigger');

  const orderType = stopOrderType || resolveLadderStopOrderType();
  const isStopLimit = orderType === LADDER_STOP_ORDER_TYPE.STOP_LIMIT;
  const stop = {
    'order-type': isStopLimit ? 'Stop Limit' : 'Stop',
    // Same TIF rule as tastytradeSubmitStopOrderWithCredentials:
    // Stop Market equity options reject GTC (tif_no_stop_market_gtc_options).
    'time-in-force': isStopLimit ? 'GTC' : 'Day',
    'stop-trigger': String(trigger),
    'price-effect': 'Credit',
    legs: [
      {
        'instrument-type': 'Equity Option',
        symbol: optionSymbol,
        quantity: qty,
        action: 'Sell to Close',
      },
    ],
  };
  if (isStopLimit) {
    const limit = stopLimitPrice ?? computeStopLimitPrice(trigger);
    if (limit == null) throw new Error('OTO stop-limit requires a limit price');
    stop.price = String(limit);
  }

  return {
    type: OTO_COMPLEX_TYPE,
    'trigger-order': {
      'order-type': 'Limit',
      'time-in-force': 'Day',
      price: String(entry),
      'price-effect': 'Debit',
      legs: [
        {
          'instrument-type': 'Equity Option',
          symbol: optionSymbol,
          quantity: qty,
          action: 'Buy to Open',
        },
      ],
    },
    orders: [stop],
  };
}

function asOrder(node) {
  if (!node || typeof node !== 'object') return null;
  return node.order && typeof node.order === 'object' ? node.order : node;
}

function orderIdFrom(node) {
  const order = asOrder(node);
  if (!order) return null;
  const id = order.id ?? order['order-id'] ?? order.order_id;
  return id != null ? String(id) : null;
}

function orderTypeFrom(node) {
  const order = asOrder(node);
  return String(order?.['order-type'] ?? order?.order_type ?? '').toLowerCase();
}

function isStopOrderType(type) {
  return type === 'stop' || type === 'stop limit' || type === 'stop_limit';
}

/**
 * Pull trigger (entry) and stop child ids from a Tastytrade complex-order response.
 */
export function parsePlacedComplexOrder(json) {
  const data = json?.data ?? json;
  const complex =
    data?.['complex-order'] ??
    data?.complex_order ??
    data?.complexOrder ??
    data;
  if (!complex || typeof complex !== 'object') {
    return { complexOrderId: null, triggerOrderId: null, stopOrderId: null };
  }

  const complexOrderId = complex.id != null ? String(complex.id) : null;
  const trigger = complex['trigger-order'] ?? complex.trigger_order ?? complex.triggerOrder;
  const triggerOrderId = orderIdFrom(trigger);

  const children = complex.orders ?? complex.Orders ?? [];
  const list = Array.isArray(children) ? children : [];
  const stopChild =
    list.find((o) => isStopOrderType(orderTypeFrom(o))) || list[0] || null;
  const stopOrderId = orderIdFrom(stopChild);

  return {
    complexOrderId,
    triggerOrderId,
    stopOrderId,
    type: complex.type || complex['complex-order-type'] || null,
    raw: complex,
  };
}

export function otoFallbackReason(err) {
  return String(err?.message || err || 'oto_submit_failed');
}
