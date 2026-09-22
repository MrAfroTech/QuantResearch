/**
 * Durable Daily P&L calendar book.
 *
 * Trade logs are the source of truth. This table stores per-strategy per-day
 * totals so the dashboard can page back years without depending on the 40-row
 * trade-log slice. Rows are upserted only — never deleted — so a day that
 * later ages out of a log query still remains on the calendar.
 */

import { getSql } from '../sqlClient.js';
import { etDateKey } from '../orb/tradierTimesales.js';
import { displayPnlDollars, tradeCommissionDollars } from '../tradePnl.js';

export const HEADLINE_PNL_START_DAY = '2026-08-14';

let schemaReady;

export function closeDateKey(closedAt) {
  if (closedAt == null || closedAt === '') return null;
  if (closedAt instanceof Date) {
    if (Number.isNaN(closedAt.getTime())) return null;
    return etDateKey(closedAt);
  }
  const raw = String(closedAt).trim();
  const dateOnly = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return dateOnly;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return etDateKey(d);
}

export function tradeNotionalDollars(trade) {
  const prem = Number(trade?.entry_premium);
  const qty = Number(trade?.quantity ?? trade?.entry_contracts ?? trade?.contracts) || 1;
  if (!(prem > 0) || !(qty > 0)) return 0;
  return prem * 100 * qty;
}

export function tradePnlDollars(trade) {
  return displayPnlDollars(trade);
}

/** Collapse closed trades into (day_key, strategy) totals. Does not write. */
export function rowsFromTrades(trades) {
  const byKey = new Map();
  for (const trade of trades || []) {
    const dayKey = closeDateKey(trade.closed_at);
    const strategy = String(trade._strategy || trade.strategy || '').trim();
    if (!dayKey || !strategy) continue;
    const id = `${dayKey}|${strategy}`;
    if (!byKey.has(id)) {
      byKey.set(id, {
        day_key: dayKey,
        strategy,
        dollars: 0,
        notional: 0,
        trade_count: 0,
        contracts: 0,
      });
    }
    const row = byKey.get(id);
    row.dollars += tradePnlDollars(trade);
    row.notional += tradeNotionalDollars(trade);
    row.trade_count += 1;
    row.contracts += tradeCommissionDollars(trade);
  }
  return [...byKey.values()];
}

const ZERO_DTE_STRATEGIES = new Set(['orb', 'premarket', 'emavwap']);

/**
 * Headline book is "was this a live fill?", not "is the strategy live today?".
 * Paper fills after a demotion stay out. Live fills (and pre-column 0DTE rows)
 * stay in after ORB / Premarket / EMA are flipped to paper.
 */
export function tradeCountsAsLiveBook(trade, liveKeys = new Set()) {
  const env = String(trade?.environment || '').toLowerCase();
  if (env === 'paper') return false;
  if (env === 'live') return true;
  const strategy = String(trade?._strategy || trade?.strategy || '');
  if (liveKeys instanceof Set && liveKeys.has(strategy)) return true;
  return ZERO_DTE_STRATEGIES.has(strategy);
}

export function filterHeadlineTrades(trades, liveKeys) {
  const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys || []);
  return (trades || []).filter((trade) => tradeCountsAsLiveBook(trade, live));
}

export function sumCalendarForDashboard(rows, { headlineStart, filterPaper } = {}) {
  const floor = headlineStart || HEADLINE_PNL_START_DAY;
  const byDay = {};
  for (const row of rows || []) {
    const dayKey = String(row.day_key || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
    if (filterPaper && dayKey < floor) continue;
    if (!byDay[dayKey]) byDay[dayKey] = { dollars: 0, notional: 0, contracts: 0 };
    byDay[dayKey].dollars += Number(row.dollars) || 0;
    byDay[dayKey].notional += Number(row.notional) || 0;
    byDay[dayKey].contracts += Number(row.contracts) || 0;
  }
  for (const row of Object.values(byDay)) {
    row.commission = Number(row.contracts) || 0;
    row.pct = row.notional > 0 ? (row.dollars / row.notional) * 100 : null;
  }
  return byDay;
}

/** Stored days win when fresh logs no longer include that day. Fresh overwrites overlap. */
export function mergeDayMaps(stored, fresh) {
  return { ...stored, ...fresh };
}

export async function ensureDailyPnlCalendarSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();
    await sql`
      CREATE TABLE IF NOT EXISTS daily_pnl_calendar (
        day_key TEXT NOT NULL,
        strategy TEXT NOT NULL,
        dollars DOUBLE PRECISION NOT NULL DEFAULT 0,
        notional DOUBLE PRECISION NOT NULL DEFAULT 0,
        trade_count INTEGER NOT NULL DEFAULT 0,
        contracts INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (day_key, strategy)
      )
    `;
    await sql`ALTER TABLE daily_pnl_calendar ADD COLUMN IF NOT EXISTS contracts INTEGER NOT NULL DEFAULT 0`;
  })();
  return schemaReady;
}

export async function persistDailyPnlFromTrades(trades) {
  await ensureDailyPnlCalendarSchema();
  const rows = rowsFromTrades(trades);
  if (!rows.length) return rows;
  const sql = getSql();
  await sql.begin(async (tx) => {
    for (const row of rows) {
      await tx`
        INSERT INTO daily_pnl_calendar (
          day_key, strategy, dollars, notional, trade_count, contracts, updated_at
        )
        VALUES (
          ${row.day_key}, ${row.strategy}, ${row.dollars}, ${row.notional},
          ${row.trade_count}, ${row.contracts}, NOW()
        )
        ON CONFLICT (day_key, strategy) DO UPDATE SET
          dollars = EXCLUDED.dollars,
          notional = EXCLUDED.notional,
          trade_count = EXCLUDED.trade_count,
          contracts = EXCLUDED.contracts,
          updated_at = NOW()
      `;
    }
  });
  return rows;
}

export async function loadDailyPnlCalendar() {
  await ensureDailyPnlCalendarSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT day_key, strategy, dollars, notional, trade_count, contracts
    FROM daily_pnl_calendar
    ORDER BY day_key ASC
  `;
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

export async function buildPersistedDailyPnlByKey(trades, environments = {}, filterPaper = false) {
  const liveKeys = new Set(
    Object.entries(environments || {})
      .filter(([, env]) => String(env).toLowerCase() === 'live')
      .map(([strategy]) => strategy)
  );
  const bookTrades = filterPaper ? filterHeadlineTrades(trades, liveKeys) : trades;
  const opts = {
    headlineStart: HEADLINE_PNL_START_DAY,
    filterPaper,
  };
  const freshRows = rowsFromTrades(bookTrades);
  const fresh = sumCalendarForDashboard(freshRows, opts);
  let stored = {};
  try {
    await persistDailyPnlFromTrades(bookTrades);
    const storedRows = await loadDailyPnlCalendar();
    stored = sumCalendarForDashboard(storedRows, opts);
  } catch (err) {
    console.warn('[dailyPnlCalendar] persist failed, serving in-memory net totals:', err.message);
  }
  const merged = mergeDayMaps(stored, fresh);
  for (const day of Object.values(merged)) {
    day.net_of_commission = true;
  }
  return merged;
}
