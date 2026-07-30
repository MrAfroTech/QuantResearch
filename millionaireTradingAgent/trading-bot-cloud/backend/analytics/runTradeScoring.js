import { etDateKey } from '../orb/tradierTimesales.js';
import { collectTradesClosedOnDate } from './tradeCollector.js';
import { scoreTrades, tradeDateFromOpenedAt } from './tradeScoring.js';
import {
  ensureAnalyticsSchema,
  getTradeScores,
  getUnscoredTradesInRange,
  upsertTradeScores,
  getScoringMeta,
  setScoringMeta,
} from './analyticsDb.js';
import { getSql } from '../sqlClient.js';

function rowToObject(row) {
  return Object.fromEntries(Object.entries(row));
}

const STRATEGY_TABLES = {
  swing: 'trade_log',
  orb: 'orb_trade_log',
  premarket: 'premarket_trade_log',
  ema_vwap: 'emavwap_trade_log',
};

/** All closed trades in an opened_at date range (for backfill preview). */
export async function collectTradesOpenedInRange(startDate, endDate) {
  const sql = getSql();
  const trades = [];

  for (const [strategy, table] of Object.entries(STRATEGY_TABLES)) {
    const rows = await sql.unsafe(`
      SELECT * FROM ${table}
      WHERE LEFT(opened_at::text, 10) >= '${startDate}'
        AND LEFT(opened_at::text, 10) <= '${endDate}'
      ORDER BY opened_at
    `);
    for (const row of rows) {
      trades.push({ ...rowToObject(row), strategy });
    }
  }

  return trades;
}

function summarizeScores(scores) {
  const byTier = {};
  for (const s of scores) {
    byTier[s.tier] = (byTier[s.tier] || 0) + 1;
  }
  return {
    count: scores.length,
    by_tier: byTier,
    flagged: scores.filter((s) => s.tier === 'flagged').length,
  };
}

/**
 * Score trades closed on reportDate (incremental daily path).
 * @param {{ reportDate?: string, dryRun?: boolean }} options
 */
export async function runDailyTradeScoring({ reportDate = etDateKey(), dryRun = false } = {}) {
  await ensureAnalyticsSchema();

  const collected = await collectTradesClosedOnDate(reportDate);
  const allTrades = Object.values(collected.strategies).flat();

  const unscored = await getUnscoredTradesInRange({
    trades: allTrades,
  });

  const scores = scoreTrades(unscored);

  const result = {
    report_date: reportDate,
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    trades_considered: allTrades.length,
    trades_scored: scores.length,
    summary: summarizeScores(scores),
    scores,
  };

  if (!dryRun && scores.length > 0) {
    const stored = await upsertTradeScores(scores);
    await setScoringMeta('last_daily_scoring_run', result.generated_at);
    result.stored = stored.length;
  }

  return result;
}

/**
 * Score or preview trades opened within a date range (backfill / on-demand rescore).
 * @param {{ startDate: string, endDate: string, dryRun?: boolean, rescored?: boolean }} options
 */
export async function runTradeScoringRange({
  startDate,
  endDate,
  dryRun = true,
  rescored = false,
} = {}) {
  await ensureAnalyticsSchema();

  const trades = await collectTradesOpenedInRange(startDate, endDate);
  const toScore = rescored
    ? trades
    : await getUnscoredTradesInRange({ trades });

  const scores = scoreTrades(toScore);

  const result = {
    start_date: startDate,
    end_date: endDate,
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    rescored,
    trades_in_range: trades.length,
    trades_scored: scores.length,
    summary: summarizeScores(scores),
    scores,
  };

  if (!dryRun && scores.length > 0) {
    const stored = await upsertTradeScores(scores);
    result.stored = stored.length;
  }

  return result;
}

/** Preview full historical backfill without writing. */
export async function previewBackfill() {
  const sql = getSql();
  let minDate = '2099-01-01';
  let maxDate = '1970-01-01';

  for (const table of Object.values(STRATEGY_TABLES)) {
    const [row] = await sql.unsafe(`
      SELECT MIN(LEFT(opened_at::text, 10)) AS min_d, MAX(LEFT(opened_at::text, 10)) AS max_d
      FROM ${table}
    `);
    if (row?.min_d && row.min_d < minDate) minDate = row.min_d;
    if (row?.max_d && row.max_d > maxDate) maxDate = row.max_d;
  }

  if (minDate === '2099-01-01') {
    return { trades_in_range: 0, scores: [], summary: { count: 0, by_tier: {}, flagged: 0 } };
  }

  return runTradeScoringRange({
    startDate: minDate,
    endDate: maxDate,
    dryRun: true,
    rescored: true,
  });
}

export async function listTradeScores({ tradeDate, strategy, tier } = {}) {
  await ensureAnalyticsSchema();
  return getTradeScores({ tradeDate, strategy, tier });
}

export async function getScoringStatus() {
  await ensureAnalyticsSchema();
  const lastRun = await getScoringMeta('last_daily_scoring_run');
  const sql = getSql();
  const [countRow] = await sql`SELECT COUNT(*)::int AS n FROM trade_scores`;
  return {
    last_daily_scoring_run: lastRun,
    total_scored_trades: countRow?.n ?? 0,
  };
}

export { tradeDateFromOpenedAt };
