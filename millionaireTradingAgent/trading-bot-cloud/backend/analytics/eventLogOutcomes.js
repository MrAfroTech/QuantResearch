import { isNeverOpenedCloseReason } from '../tradePnl.js';

/** Matches isAtOrAfterTimeStop — 15:05 ET session freeze for 0DTE FSM. */
export const SESSION_FREEZE_ET_MINUTES = 15 * 60 + 5;

export const BREAKOUT_INVALIDATED = 'breakout_invalidated';

const ET_TZ = 'America/New_York';

function etParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hours: Number(get('hour')),
    minutes: Number(get('minute')),
  };
}

export function etDateKeyFromDate(date = new Date()) {
  const { year, month, day } = etParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseTimestampMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  let s = String(value).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} /.test(s) && !s.includes('T')) {
    s = s.replace(' ', 'T');
  }
  if (/\+\d{2}$/.test(s)) s += ':00';
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export function sessionHasEnded(tradeDate, now = new Date()) {
  if (!tradeDate) return false;
  const today = etDateKeyFromDate(now);
  if (tradeDate < today) return true;
  if (tradeDate > today) return false;
  const { hours, minutes } = etParts(now);
  return hours * 60 + minutes >= SESSION_FREEZE_ET_MINUTES;
}

function groupKey(row) {
  return [
    row.strategy || '',
    String(row.ticker || '').toUpperCase(),
    String(row.direction || '').toUpperCase(),
    row.trade_date || '',
  ].join('|');
}

function tradeEtDate(trade) {
  if (trade.trade_date) return trade.trade_date;
  const ms = parseTimestampMs(trade.opened_at);
  if (ms == null) return String(trade.opened_at || '').slice(0, 10);
  return etDateKeyFromDate(new Date(ms));
}

function isRealFill(trade) {
  return !isNeverOpenedCloseReason(trade?.close_reason);
}

function formatPnl(trade) {
  const dollars = Number(trade.realized_pnl);
  if (Number.isFinite(dollars)) {
    const sign = dollars < 0 ? '-' : dollars > 0 ? '+' : '';
    return `${sign}$${Math.abs(dollars).toFixed(2)}`;
  }
  const pct = Number(trade.pnl_pct);
  if (Number.isFinite(pct)) {
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }
  return '';
}

function filledLabel(trade) {
  const reason = trade.close_reason || 'closed';
  const pnl = formatPnl(trade);
  return pnl ? `Filled — ${reason} ${pnl}` : `Filled — ${reason}`;
}

/**
 * Correlate each event-log row to the terminator of that breakout attempt:
 * next fill, next invalidation, session-end abandon, or still awaiting.
 * Multiple confirmation_too_explosive rows share the same later terminator.
 */
export function resolveEventOutcomes({ events = [], trades = [], now = new Date() } = {}) {
  const fills = (trades || []).filter(isRealFill).map((trade) => ({
    ...trade,
    _ms: parseTimestampMs(trade.opened_at),
    _day: tradeEtDate(trade),
    _ticker: String(trade.ticker || '').toUpperCase(),
    _direction: String(trade.direction || '').toUpperCase(),
    _strategy: trade.strategy || '',
  }));

  const byGroup = new Map();
  for (const event of events || []) {
    const key = groupKey(event);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(event);
  }

  const resolved = [];
  for (const [key, group] of byGroup) {
    const sorted = [...group].sort((a, b) => {
      const da = parseTimestampMs(a.created_at) ?? 0;
      const db = parseTimestampMs(b.created_at) ?? 0;
      if (da !== db) return da - db;
      return (Number(a.id) || 0) - (Number(b.id) || 0);
    });
    const [strategy, ticker, direction, tradeDate] = key.split('|');
    const groupFills = fills
      .filter(
        (t) =>
          t._strategy === strategy &&
          t._ticker === ticker &&
          t._direction === direction &&
          t._day === tradeDate &&
          t._ms != null
      )
      .sort((a, b) => a._ms - b._ms);

    for (const event of sorted) {
      resolved.push(annotateEvent(event, sorted, groupFills, now));
    }
  }

  resolved.sort((a, b) => {
    const db = parseTimestampMs(b.created_at) ?? 0;
    const da = parseTimestampMs(a.created_at) ?? 0;
    if (db !== da) return db - da;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });
  return resolved;
}

function annotateEvent(event, groupEvents, groupFills, now) {
  const eventMs = parseTimestampMs(event.created_at) ?? 0;

  if (event.event_type === BREAKOUT_INVALIDATED) {
    return {
      ...event,
      outcome: 'invalidated',
      outcome_label: 'Invalidated — no trade',
      trade_id: null,
      opened_at: null,
      close_reason: null,
      realized_pnl: null,
    };
  }

  const nextInvalidation = groupEvents.find((other) => {
    if (other.event_type !== BREAKOUT_INVALIDATED) return false;
    const otherMs = parseTimestampMs(other.created_at) ?? 0;
    return otherMs >= eventMs;
  });
  const nextFill = groupFills.find((trade) => trade._ms >= eventMs);

  const invMs = nextInvalidation ? parseTimestampMs(nextInvalidation.created_at) : null;
  const fillMs = nextFill?._ms ?? null;

  const fillFirst =
    fillMs != null && (invMs == null || fillMs < invMs);
  const invFirst =
    invMs != null && (fillMs == null || invMs <= fillMs);

  if (fillFirst) {
    return {
      ...event,
      outcome: 'filled',
      outcome_label: filledLabel(nextFill),
      trade_id: nextFill.id ?? null,
      opened_at: nextFill.opened_at ?? null,
      close_reason: nextFill.close_reason ?? null,
      realized_pnl: nextFill.realized_pnl ?? null,
      pnl_pct: nextFill.pnl_pct ?? null,
    };
  }

  if (invFirst) {
    return {
      ...event,
      outcome: 'invalidated',
      outcome_label: 'Invalidated — no trade',
      trade_id: null,
      opened_at: null,
      close_reason: null,
      realized_pnl: null,
    };
  }

  if (sessionHasEnded(event.trade_date, now)) {
    return {
      ...event,
      outcome: 'abandoned',
      outcome_label: 'No fill — session ended',
      trade_id: null,
      opened_at: null,
      close_reason: null,
      realized_pnl: null,
    };
  }

  return {
    ...event,
    outcome: 'pending',
    outcome_label: 'Awaiting confirmation',
    trade_id: null,
    opened_at: null,
    close_reason: null,
    realized_pnl: null,
  };
}
