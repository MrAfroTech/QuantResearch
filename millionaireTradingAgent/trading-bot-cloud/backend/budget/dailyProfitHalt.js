/**
 * Account-wide daily profit halt for ORB / Premarket / EMA-VWAP.
 * Once combined realized P&L for today (ET) reaches
 * DAILY_PROFIT_HALT_THRESHOLD_DOLLARS across those three strategies, halt new
 * entries on all three for the rest of that calendar day. Open positions keep
 * normal exit/stop management. Resets on the next ET trading day.
 */

import { getSql } from '../sqlClient.js';
import { etDateKey } from '../orb/tradierTimesales.js';

export const DAILY_PROFIT_HALT_REASON = 'daily_profit_halt';

/** Combined realized dollars that trip the halt (inclusive). */
export const DAILY_PROFIT_HALT_THRESHOLD_DOLLARS = 100;

const SUPPORTED = new Set(['orb', 'premarket', 'emavwap']);
const HALT_STRATEGIES = ['orb', 'premarket', 'emavwap'];

/**
 * Sum of realized_pnl for closed trades on tradeDate (ET date key).
 * Excludes never-opened / cancelled-unfilled closes (same filter as live daily loss).
 */
export async function getStrategyRealizedPnlToday(strategy, tradeDate = etDateKey()) {
  if (!SUPPORTED.has(strategy)) return 0;

  const sql = getSql();
  let rows;
  if (strategy === 'orb') {
    rows = await sql`
      SELECT COALESCE(SUM(realized_pnl), 0)::float AS total
      FROM orb_trade_log
      WHERE LEFT(closed_at::text, 10) = ${tradeDate}
        AND COALESCE(close_reason, '') NOT IN ('entry_unfilled_cancelled', 'entry_never_filled')
    `;
  } else if (strategy === 'premarket') {
    rows = await sql`
      SELECT COALESCE(SUM(realized_pnl), 0)::float AS total
      FROM premarket_trade_log
      WHERE LEFT(closed_at::text, 10) = ${tradeDate}
        AND COALESCE(close_reason, '') NOT IN ('entry_unfilled_cancelled', 'entry_never_filled')
    `;
  } else {
    rows = await sql`
      SELECT COALESCE(SUM(realized_pnl), 0)::float AS total
      FROM emavwap_trade_log
      WHERE LEFT(closed_at::text, 10) = ${tradeDate}
        AND COALESCE(close_reason, '') NOT IN ('entry_unfilled_cancelled', 'entry_never_filled')
    `;
  }
  return Number(rows[0]?.total) || 0;
}

export async function getAccountRealizedPnlToday(tradeDate = etDateKey()) {
  const parts = await Promise.all(
    HALT_STRATEGIES.map((strategy) => getStrategyRealizedPnlToday(strategy, tradeDate))
  );
  return parts.reduce((sum, value) => sum + value, 0);
}

/** Halt when combined realized dollars reach $100. $99.99 does not halt. */
export function shouldHaltOnDailyProfit(accountRealizedPnlToday) {
  return Number(accountRealizedPnlToday) >= DAILY_PROFIT_HALT_THRESHOLD_DOLLARS;
}

/**
 * @returns {{ halt: boolean, reason: string|null, realizedPnlToday: number, tradeDate: string, strategy: string }}
 */
export async function getDailyProfitHalt(strategy, tradeDate = etDateKey()) {
  if (!SUPPORTED.has(strategy)) {
    return {
      halt: false,
      reason: null,
      realizedPnlToday: 0,
      tradeDate,
      strategy,
    };
  }

  const realizedPnlToday = await getAccountRealizedPnlToday(tradeDate);
  if (shouldHaltOnDailyProfit(realizedPnlToday)) {
    return {
      halt: true,
      reason: DAILY_PROFIT_HALT_REASON,
      realizedPnlToday,
      tradeDate,
      strategy,
    };
  }
  return {
    halt: false,
    reason: null,
    realizedPnlToday,
    tradeDate,
    strategy,
  };
}
