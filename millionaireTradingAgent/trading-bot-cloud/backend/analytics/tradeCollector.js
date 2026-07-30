import { getSql } from '../sqlClient.js';
import { etDateKey } from '../orb/tradierTimesales.js';

function rowToObject(row) {
  return Object.fromEntries(Object.entries(row));
}

function parseTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function closedOnEtDate(closedAt, targetDate) {
  const d = parseTimestamp(closedAt);
  if (!d) return false;
  return etDateKey(d) === targetDate;
}

const STRATEGY_QUERIES = {
  swing: {
    strategy: 'swing',
    table: 'trade_log',
    query: (sql) => sql`SELECT * FROM trade_log ORDER BY closed_at`,
  },
  orb: {
    strategy: 'orb',
    table: 'orb_trade_log',
    query: (sql) => sql`SELECT * FROM orb_trade_log ORDER BY closed_at`,
  },
  premarket: {
    strategy: 'premarket',
    table: 'premarket_trade_log',
    query: (sql) => sql`SELECT * FROM premarket_trade_log ORDER BY closed_at`,
  },
  ema_vwap: {
    strategy: 'ema_vwap',
    table: 'emavwap_trade_log',
    query: (sql) => sql`SELECT * FROM emavwap_trade_log ORDER BY closed_at`,
  },
};

export async function collectTradesClosedOnDate(reportDate = etDateKey()) {
  const sql = getSql();
  const result = {};

  for (const [key, spec] of Object.entries(STRATEGY_QUERIES)) {
    const rows = await spec.query(sql);
    const trades = rows
      .map(rowToObject)
      .filter((row) => closedOnEtDate(row.closed_at, reportDate))
      .map((row) => ({ ...row, strategy: spec.strategy }));
    result[key] = trades;
  }

  return {
    report_date: reportDate,
    strategies: result,
    total_count: Object.values(result).reduce((sum, list) => sum + list.length, 0),
  };
}

/** Trades from the 7 calendar days ending on reportDate (inclusive), for pattern analysis. */
export async function collectTradesForLookback(reportDate, lookbackDays = 7) {
  const sql = getSql();
  const end = new Date(`${reportDate}T23:59:59`);
  const start = new Date(end);
  start.setDate(start.getDate() - (lookbackDays - 1));

  const inRange = (closedAt) => {
    const d = parseTimestamp(closedAt);
    if (!d) return false;
    const day = etDateKey(d);
    const startKey = etDateKey(start);
    const endKey = etDateKey(end);
    return day >= startKey && day <= endKey;
  };

  const result = {};
  for (const [key, spec] of Object.entries(STRATEGY_QUERIES)) {
    const rows = await spec.query(sql);
    result[key] = rows
      .map(rowToObject)
      .filter((row) => inRange(row.closed_at))
      .map((row) => ({ ...row, strategy: spec.strategy }));
  }
  return result;
}
