/**
 * Attach hard_stop_slippage event fields onto Trade Log rows.
 * Read-only correlation — does not change stops or execution.
 *
 * Events store position_id; trade_log rows do not. Match by strategy + ticker +
 * entry/fill premiums + close-time proximity (events fire in the same second
 * as the hard-stop close).
 */

import { computeStopTriggerPrice } from '../ladder/ladderConfig.js';
import { ORB_STOP_LOSS_PCT } from '../orb/orbConfig.js';
import { PREMARKET_STOP_LOSS_PCT } from '../premarketBreakout/premarketConfig.js';
import { EMA_VWAP_STOP_LOSS_PCT } from '../emaVwapCross/emaVwapConfig.js';

const MATCH_WINDOW_MS = 120_000;
const PRICE_EPS = 0.005;

function restingSoftStopPct(strategy) {
  const key = String(strategy || '').toLowerCase();
  if (key === 'premarket') return PREMARKET_STOP_LOSS_PCT;
  if (key === 'emavwap' || key === 'ema_vwap') return EMA_VWAP_STOP_LOSS_PCT;
  return ORB_STOP_LOSS_PCT;
}

function detailsHasLimitPrice(details) {
  return details != null && Object.prototype.hasOwnProperty.call(details, 'limit_price');
}

/**
 * Broker resting-stop fill: poll path always writes limit_price (number);
 * the broker-stop notify path writes limit_price: null explicitly.
 * Legacy events omit the key — leave those tagged as they were (· limit).
 */
export function isBrokerRestingStopFill(slip) {
  if (!slip || slip.escalated === true) return false;
  if (slip.limit_price_present !== true) return false;
  return slip.limit_price == null || !Number.isFinite(Number(slip.limit_price));
}

/**
 * Display numbers for the Slippage cell. Broker-stop fills are measured vs the
 * resting soft-stop trigger (the order that actually fired), not the theoretical
 * hard-stop level stored on the event.
 */
export function resolveDisplayHardStopSlippage(slip) {
  if (!slip) return null;
  if (!isBrokerRestingStopFill(slip)) return slip;

  const entry = Number(slip.entry_premium);
  const fill = Number(slip.fill_price);
  const qty = Number(slip.quantity) || 1;
  const trigger = computeStopTriggerPrice(entry, -restingSoftStopPct(slip.strategy));
  if (!(entry > 0) || !Number.isFinite(fill) || trigger == null) return slip;

  return {
    ...slip,
    trigger_price: trigger,
    slippage_dollars: Math.round((fill - trigger) * 100 * qty * 100) / 100,
    slippage_pct_of_entry: (fill - trigger) / entry,
  };
}

function parseDetails(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function parseMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Normalize a hard_stop_slippage event row into a flat slip object.
 */
export function normalizeHardStopSlippageEvent(row) {
  const details = parseDetails(row?.details_json ?? row?.details);
  if (!details || details.type !== 'hard_stop_slippage') return null;

  const trigger = Number(details.trigger_price);
  const fill = Number(details.fill_price);
  const slipDollars = Number(details.slippage_dollars);
  const slipPct = Number(details.slippage_pct_of_entry);
  if (!Number.isFinite(trigger) || !Number.isFinite(fill)) return null;

  return {
    position_id: details.position_id ?? null,
    ticker: row.ticker ?? null,
    strategy: row.strategy ?? null,
    created_at: row.created_at ?? null,
    trigger_price: trigger,
    fill_price: fill,
    quantity: Number(details.quantity) || 1,
    entry_premium: Number(details.entry_premium),
    slippage_dollars: Number.isFinite(slipDollars) ? slipDollars : (fill - trigger) * 100,
    slippage_pct_of_entry: Number.isFinite(slipPct)
      ? slipPct
      : Number(details.entry_premium) > 0
        ? (fill - trigger) / Number(details.entry_premium)
        : null,
    hard_stop_trigger_pct: Number(details.hard_stop_trigger_pct) || null,
    escalated: details.escalated === true,
    skipped_limit_escalation: details.skipped_limit_escalation === true,
    limit_price: details.limit_price != null ? Number(details.limit_price) : null,
    limit_price_present: detailsHasLimitPrice(details),
  };
}

/**
 * Whether a trade row can be paired with a slippage event.
 */
export function matchHardStopSlippage(trade, slip) {
  if (!trade || !slip) return false;
  if (String(trade.close_reason || '') !== 'hard_stop') return false;
  if (trade.strategy && slip.strategy && trade.strategy !== slip.strategy) return false;
  if (
    String(trade.ticker || '').toUpperCase() !== String(slip.ticker || '').toUpperCase()
  ) {
    return false;
  }

  const entry = Number(trade.entry_premium);
  const exit = Number(trade.exit_premium);
  if (Number.isFinite(entry) && Number.isFinite(slip.entry_premium)) {
    if (Math.abs(entry - slip.entry_premium) > PRICE_EPS) return false;
  }
  if (Number.isFinite(exit) && Number.isFinite(slip.fill_price)) {
    if (Math.abs(exit - slip.fill_price) > PRICE_EPS) return false;
  }

  const tradeMs = parseMs(trade.closed_at || trade.date);
  const eventMs = parseMs(slip.created_at);
  if (tradeMs != null && eventMs != null) {
    if (Math.abs(tradeMs - eventMs) > MATCH_WINDOW_MS) return false;
  }

  return true;
}

export function formatHardStopSlippageLabel(slip) {
  const display = resolveDisplayHardStopSlippage(slip);
  if (!display) return null;
  const trigger = Number(display.trigger_price);
  const fill = Number(display.fill_price);
  const dollars = Number(display.slippage_dollars);
  const pct = Number(display.slippage_pct_of_entry);
  if (!Number.isFinite(trigger) || !Number.isFinite(fill)) return null;

  const triggerStr = `$${trigger.toFixed(2)}`;
  const fillStr = `$${fill.toFixed(2)}`;
  const dollarStr = `${dollars >= 0 ? '+' : '−'}$${Math.abs(dollars).toFixed(2)}`;
  const pctStr =
    Number.isFinite(pct) ? `${pct >= 0 ? '+' : '−'}${(Math.abs(pct) * 100).toFixed(2)}%` : '';
  const base =
    Math.abs(dollars) < 0.005 && Math.abs(pct || 0) < 1e-9
      ? `Clean @ ${triggerStr}`
      : `${triggerStr}→${fillStr} (${dollarStr}${pctStr ? ` / ${pctStr}` : ''})`;
  if (display.escalated === true) return `${base} · market`;
  if (isBrokerRestingStopFill(display)) return `${base} · broker stop`;
  if (display.escalated === false) return `${base} · limit`;
  return base;
}

/**
 * Load recent hard_stop_slippage events for ORB + Premarket + EMA/VWAP.
 */
export async function fetchHardStopSlippageEvents(sql, { lookbackDays = 14 } = {}) {
  if (!sql) return [];
  const days = Math.max(1, Math.min(90, Number(lookbackDays) || 14));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const [orbRows, pmRows, emaRows] = await Promise.all([
    sql`
      SELECT ticker, created_at, details_json
      FROM orb_event_log
      WHERE event_type = 'hard_stop_slippage'
        AND created_at::timestamptz >= ${cutoff}::timestamptz
      ORDER BY created_at DESC
      LIMIT 200
    `.catch(() => []),
    sql`
      SELECT ticker, created_at, details_json
      FROM premarket_event_log
      WHERE event_type = 'hard_stop_slippage'
        AND created_at::timestamptz >= ${cutoff}::timestamptz
      ORDER BY created_at DESC
      LIMIT 200
    `.catch(() => []),
    sql`
      SELECT ticker, created_at, details_json
      FROM emavwap_event_log
      WHERE event_type = 'hard_stop_slippage'
        AND created_at::timestamptz >= ${cutoff}::timestamptz
      ORDER BY created_at DESC
      LIMIT 200
    `.catch(() => []),
  ]);

  const out = [];
  for (const row of orbRows || []) {
    const slip = normalizeHardStopSlippageEvent({ ...row, strategy: 'orb' });
    if (slip) out.push(slip);
  }
  for (const row of pmRows || []) {
    const slip = normalizeHardStopSlippageEvent({ ...row, strategy: 'premarket' });
    if (slip) out.push(slip);
  }
  for (const row of emaRows || []) {
    const slip = normalizeHardStopSlippageEvent({ ...row, strategy: 'emavwap' });
    if (slip) out.push(slip);
  }
  return out;
}

/**
 * Enrich trade_log entries that closed hard_stop with matching slippage fields.
 */
export async function enrichTradesWithHardStopSlippage(trades, { sql, lookbackDays = 14 } = {}) {
  const list = Array.isArray(trades) ? trades : [];
  const hardStops = list.filter((t) => String(t.close_reason || '') === 'hard_stop');
  if (!hardStops.length || !sql) return list;

  let events = [];
  try {
    events = await fetchHardStopSlippageEvents(sql, { lookbackDays });
  } catch (err) {
    console.warn('[HardStopSlippage] event fetch failed:', err.message);
    return list;
  }
  if (!events.length) return list;

  const used = new Set();
  return list.map((trade) => {
    if (String(trade.close_reason || '') !== 'hard_stop') return trade;

    let matchIdx = -1;
    for (let i = 0; i < events.length; i += 1) {
      if (used.has(i)) continue;
      if (matchHardStopSlippage(trade, events[i])) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx < 0) return trade;
    used.add(matchIdx);
    const slip = resolveDisplayHardStopSlippage(events[matchIdx]);
    return {
      ...trade,
      hard_stop_slippage: {
        trigger_price: slip.trigger_price,
        fill_price: slip.fill_price,
        slippage_dollars: slip.slippage_dollars,
        slippage_pct_of_entry: slip.slippage_pct_of_entry,
        quantity: slip.quantity,
        position_id: slip.position_id,
        escalated: slip.escalated === true,
        skipped_limit_escalation: slip.skipped_limit_escalation === true,
        limit_price: slip.limit_price,
      },
      hard_stop_slippage_label: formatHardStopSlippageLabel(slip),
    };
  });
}
