import { getSql } from '../sqlClient.js';
import { getBotState, getOpenPositions, getLastSignal, getTradeLog } from '../db.js';
import { getOptionPremium } from '../brokerageConnector.js';
import { getStrategyBudgetSnapshot } from '../budget/budgetAllocations.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { MAX_POSITIONS } from '../positionManager.js';
import { getOrbMaxPositions } from '../orb/orbConfig.js';
import { getPremarketMaxPositions } from '../premarketBreakout/premarketConfig.js';
import { EMA_VWAP_MAX_POSITIONS } from '../emaVwapCross/emaVwapConfig.js';
import { getOrbMode, getOrbBotState, getOrbOpenPositions } from '../orb/orbDb.js';
import {
  getPremarketMode,
  getPremarketBotState,
  getPremarketOpenPositions,
} from '../premarketBreakout/premarketDb.js';
import {
  getEmaVwapMode,
  getEmaVwapBotState,
  getEmaVwapOpenPositions,
} from '../emaVwapCross/emaVwapDb.js';
import { etDateKey, minutesSinceMidnightEt, isWeekdayEt } from '../orb/tradierTimesales.js';

function rowToObject(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row));
}

function parseTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function timestampToEtDate(value) {
  const d = parseTimestamp(value);
  if (!d) return null;
  return etDateKey(d);
}

function getMarketContext() {
  const now = new Date();
  const mins = minutesSinceMidnightEt(now);
  const weekday = isWeekdayEt(now);
  const isMarketHours = weekday && mins >= 9 * 60 + 30 && mins < 16 * 60;
  return {
    generated_at: now.toISOString(),
    et_date: etDateKey(now),
    is_weekday: weekday,
    is_market_hours: isMarketHours,
    minutes_since_midnight_et: mins,
  };
}

function pickLatestActivity(candidates) {
  let best = null;
  for (const item of candidates) {
    if (!item?.timestamp) continue;
    const ts = parseTimestamp(item.timestamp);
    if (!ts) continue;
    if (!best || ts > best.parsed) {
      best = { ...item, parsed: ts };
    }
  }
  if (!best) return null;
  const { parsed, ...rest } = best;
  return { ...rest, timestamp: parsed.toISOString() };
}

function evaluateStaleness(latestActivity, marketContext) {
  if (!marketContext.is_market_hours) {
    return {
      status: 'MARKET_CLOSED',
      reason: 'Outside regular market hours (Mon–Fri 9:30am–4:00pm ET)',
    };
  }

  if (!latestActivity?.timestamp) {
    return {
      status: 'NO_ACTIVITY_TODAY',
      reason: 'No recorded activity found for this strategy',
    };
  }

  const activityDate = timestampToEtDate(latestActivity.timestamp);
  if (activityDate !== marketContext.et_date) {
    return {
      status: 'NO_ACTIVITY_TODAY',
      reason: `Last activity on ${activityDate || 'unknown date'}, not today (${marketContext.et_date})`,
    };
  }

  const ageMinutes = (Date.now() - parseTimestamp(latestActivity.timestamp).getTime()) / 60000;
  if (ageMinutes > 20) {
    return {
      status: 'STALE',
      reason: `Last activity ${Math.round(ageMinutes)} minutes ago during market hours`,
    };
  }

  return {
    status: 'OK',
    reason: `Last activity ${Math.round(ageMinutes)} minutes ago`,
  };
}

async function enrichOpenPositions(positions) {
  const open = [];
  for (const position of positions) {
    const entry = Number(position.entry_premium);
    let unrealized_pnl_pct = null;
    try {
      const currentPremium = await getOptionPremium(
        position.ticker,
        position.direction,
        position.strike,
        position.expiration
      );
      if (Number.isFinite(entry) && entry > 0) {
        unrealized_pnl_pct = Number((((currentPremium - entry) / entry) * 100).toFixed(2));
      }
    } catch {
      unrealized_pnl_pct = null;
    }

    open.push({
      id: position.id,
      ticker: position.ticker,
      direction: position.direction,
      strike: position.strike,
      expiration: position.expiration,
      entry_premium: position.entry_premium,
      quantity: position.quantity ?? 1,
      opened_at: position.opened_at,
      unrealized_pnl_pct,
    });
  }
  return open;
}

function buildBudget(cap, spent) {
  const spentNum = Number(spent) || 0;
  return {
    cap,
    spent: spentNum,
    remaining: Math.max(0, cap - spentNum),
  };
}

function buildPositionBlock(openPositions, maxPositions) {
  const openCount = openPositions.length;
  return {
    open_count: openCount,
    max: maxPositions,
    at_limit: openCount >= maxPositions,
    open: openPositions,
  };
}

async function queryLatestOrbTrade() {
  const sql = getSql();
  const rows = await sql`SELECT * FROM orb_trade_log ORDER BY closed_at DESC LIMIT 1`;
  return rowToObject(rows[0]);
}

async function queryLatestOrbEvent() {
  const sql = getSql();
  const rows = await sql`SELECT * FROM orb_event_log ORDER BY created_at DESC LIMIT 1`;
  return rowToObject(rows[0]);
}

async function queryLatestOrbRangeUpdate() {
  const sql = getSql();
  const [row] = await sql`SELECT MAX(updated_at) AS updated_at FROM orb_range_state`;
  return row?.updated_at || null;
}

function parseJsonSafe(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function formatPremarketSignalActivity(latestRow, rowsTodayCount, etDate) {
  if (!latestRow || rowsTodayCount === 0) {
    return {
      found: false,
      timestamp: null,
      source: 'premarket_state',
      summary: 'no per-symbol state rows found for today',
      note: `no per-symbol state rows found for today (${etDate})`,
      per_symbol_rows_today: 0,
      detail: null,
    };
  }

  const fsm = parseJsonSafe(latestRow.fsm_json);
  return {
    found: true,
    source: 'premarket_state',
    timestamp: parseTimestamp(latestRow.updated_at)?.toISOString() || latestRow.updated_at,
    summary: `${latestRow.symbol} pm H=${latestRow.pm_high ?? '—'} L=${latestRow.pm_low ?? '—'} FSM=${fsm.phase || 'unknown'}`,
    note: null,
    per_symbol_rows_today: rowsTodayCount,
    detail: {
      symbol: latestRow.symbol,
      trade_date: latestRow.trade_date,
      pm_high: latestRow.pm_high,
      pm_low: latestRow.pm_low,
      range_complete: latestRow.range_complete,
      fsm_phase: fsm.phase ?? null,
      fsm_direction: fsm.direction ?? null,
      breakout_level: fsm.breakout_level ?? null,
      last_processed_bar_time: fsm.last_processed_bar_time ?? null,
      fsm,
      updated_at: latestRow.updated_at,
    },
  };
}

function formatEmaVwapSignalActivity(latestRow, rowsTodayCount, etDate) {
  if (!latestRow || rowsTodayCount === 0) {
    return {
      found: false,
      timestamp: null,
      source: 'emavwap_state',
      summary: 'no per-symbol state rows found for today',
      note: `no per-symbol state rows found for today (${etDate})`,
      per_symbol_rows_today: 0,
      detail: null,
    };
  }

  const fsm = parseJsonSafe(latestRow.fsm_json);
  return {
    found: true,
    source: 'emavwap_state',
    timestamp: parseTimestamp(latestRow.updated_at)?.toISOString() || latestRow.updated_at,
    summary: `${latestRow.symbol} ema_side=${fsm.ema_side || 'unknown'}`,
    note: null,
    per_symbol_rows_today: rowsTodayCount,
    detail: {
      symbol: latestRow.symbol,
      trade_date: latestRow.trade_date,
      ema_side: fsm.ema_side ?? null,
      last_processed_bar_time: fsm.last_processed_bar_time ?? null,
      fsm,
      updated_at: latestRow.updated_at,
    },
  };
}

function evaluateSignalStaleness(recentSignalActivity, marketContext) {
  if (!marketContext.is_market_hours) {
    return {
      status: 'MARKET_CLOSED',
      reason: 'Outside regular market hours (Mon–Fri 9:30am–4:00pm ET)',
    };
  }

  if (!recentSignalActivity?.found || !recentSignalActivity?.timestamp) {
    return {
      status: 'NO_ACTIVITY_TODAY',
      reason:
        recentSignalActivity?.note ||
        'No per-symbol signal state rows found for today — scan may not be running',
    };
  }

  const activityDate = timestampToEtDate(recentSignalActivity.timestamp);
  if (activityDate !== marketContext.et_date) {
    return {
      status: 'NO_ACTIVITY_TODAY',
      reason: `Last signal state on ${activityDate || 'unknown date'}, not today (${marketContext.et_date})`,
    };
  }

  const ageMinutes =
    (Date.now() - parseTimestamp(recentSignalActivity.timestamp).getTime()) / 60000;
  if (ageMinutes > 20) {
    return {
      status: 'STALE',
      reason: `Last per-symbol signal state ${Math.round(ageMinutes)} minutes ago during market hours`,
    };
  }

  return {
    status: 'OK',
    reason: `Last per-symbol signal state ${Math.round(ageMinutes)} minutes ago`,
  };
}

async function queryLatestPremarketTrade() {
  const sql = getSql();
  const rows = await sql`SELECT * FROM premarket_trade_log ORDER BY closed_at DESC LIMIT 1`;
  return rowToObject(rows[0]);
}

async function queryLatestPremarketEvent() {
  const sql = getSql();
  const rows = await sql`SELECT * FROM premarket_event_log ORDER BY created_at DESC LIMIT 1`;
  return rowToObject(rows[0]);
}

async function queryPremarketSymbolStateForToday(tradeDate) {
  const sql = getSql();
  const [countRow] = await sql`
    SELECT COUNT(*)::int AS count FROM premarket_state
    WHERE symbol <> '' AND trade_date = ${tradeDate}
  `;
  const rows = await sql`
    SELECT * FROM premarket_state
    WHERE symbol <> '' AND trade_date = ${tradeDate}
    ORDER BY updated_at DESC
  `;
  return {
    count: Number(countRow?.count || 0),
    latest: rowToObject(rows[0]),
    symbols: rows.map((r) => r.symbol),
  };
}

async function queryEmaVwapSymbolStateForToday(tradeDate) {
  const sql = getSql();
  const [countRow] = await sql`
    SELECT COUNT(*)::int AS count FROM emavwap_state
    WHERE symbol <> '' AND trade_date = ${tradeDate}
  `;
  const rows = await sql`
    SELECT * FROM emavwap_state
    WHERE symbol <> '' AND trade_date = ${tradeDate}
    ORDER BY updated_at DESC
  `;
  return {
    count: Number(countRow?.count || 0),
    latest: rowToObject(rows[0]),
    symbols: rows.map((r) => r.symbol),
  };
}

async function queryLatestEmaVwapTrade() {
  const sql = getSql();
  const rows = await sql`SELECT * FROM emavwap_trade_log ORDER BY closed_at DESC LIMIT 1`;
  return rowToObject(rows[0]);
}

async function buildSwingHealth(marketContext) {
  const state = await getBotState();
  const budgetSnap = await getStrategyBudgetSnapshot('swing');
  const environment = await getStrategyEnvironment('swing');
  const positions = await enrichOpenPositions(await getOpenPositions());
  const lastSignal = await getLastSignal();
  const lastTrade = (await getTradeLog(1))[0] || null;

  const activityCandidates = [
    lastSignal && {
      source: 'signal_log',
      timestamp: lastSignal.checked_at,
      summary: `Signal ${lastSignal.ticker} ${lastSignal.signal_type} → ${lastSignal.result}`,
      detail: lastSignal,
    },
    lastTrade && {
      source: 'trade_log',
      timestamp: lastTrade.closed_at,
      summary: `Closed ${lastTrade.ticker} ${lastTrade.direction} (${lastTrade.close_reason || 'n/a'})`,
      detail: lastTrade,
    },
    state?.updated_at && {
      source: 'bot_state',
      timestamp: state.updated_at,
      summary: 'bot_state row updated',
      detail: { monthly_spend: state.monthly_spend, execution_mode: state.execution_mode },
    },
    ...positions.map((p) => ({
      source: 'open_position',
      timestamp: p.opened_at,
      summary: `Open ${p.ticker} ${p.direction}`,
      detail: p,
    })),
  ].filter(Boolean);

  const recentActivity = pickLatestActivity(activityCandidates);

  return {
    strategy: 'swing',
    execution_mode: state.swing_mode || state.execution_mode || 'AUTO',
    environment,
    budget: buildBudget(budgetSnap.max, budgetSnap.spent),
    positions: buildPositionBlock(positions, MAX_POSITIONS),
    recent_activity: recentActivity,
    recent_event: null,
    health: evaluateStaleness(recentActivity, marketContext),
  };
}

async function buildOrbHealth(marketContext) {
  const mode = await getOrbMode();
  const botState = await getOrbBotState();
  const budgetSnap = await getStrategyBudgetSnapshot('orb');
  const environment = await getStrategyEnvironment('orb');
  const positions = await enrichOpenPositions(await getOrbOpenPositions());

  let lastTrade = null;
  let lastEvent = null;
  let rangeUpdatedAt = null;
  try {
    lastTrade = await queryLatestOrbTrade();
    lastEvent = await queryLatestOrbEvent();
    rangeUpdatedAt = await queryLatestOrbRangeUpdate();
  } catch (err) {
    console.warn('[healthCheck] ORB table query:', err.message);
  }

  const activityCandidates = [
    lastTrade && {
      source: 'orb_trade_log',
      timestamp: lastTrade.closed_at,
      summary: `Closed ${lastTrade.ticker} ${lastTrade.direction} (${lastTrade.close_reason || 'n/a'})`,
      detail: lastTrade,
    },
    rangeUpdatedAt && {
      source: 'orb_range_state',
      timestamp: rangeUpdatedAt,
      summary: 'ORB range/FSM state updated',
      detail: { updated_at: rangeUpdatedAt },
    },
    botState?.updated_at && {
      source: 'orb_bot_state',
      timestamp: botState.updated_at,
      summary: 'ORB budget state updated',
      detail: { orb_monthly_spend: botState.orb_monthly_spend },
    },
    ...positions.map((p) => ({
      source: 'orb_positions',
      timestamp: p.opened_at,
      summary: `Open ${p.ticker} ${p.direction}`,
      detail: p,
    })),
  ].filter(Boolean);

  const recentActivity = pickLatestActivity(activityCandidates);
  const recentEvent = lastEvent
    ? {
        source: 'orb_event_log',
        timestamp: parseTimestamp(lastEvent.created_at)?.toISOString() || lastEvent.created_at,
        summary: `${lastEvent.event_type} ${lastEvent.ticker} ${lastEvent.direction || ''}`.trim(),
        detail: lastEvent,
      }
    : null;

  return {
    strategy: 'orb',
    execution_mode: mode,
    environment,
    budget: buildBudget(budgetSnap.max, budgetSnap.spent),
    positions: buildPositionBlock(positions, getOrbMaxPositions(environment)),
    recent_activity: recentActivity,
    recent_event: recentEvent,
    health: evaluateStaleness(recentActivity, marketContext),
  };
}

async function buildPremarketHealth(marketContext) {
  const mode = await getPremarketMode();
  const botState = await getPremarketBotState();
  const budgetSnap = await getStrategyBudgetSnapshot('premarket');
  const environment = await getStrategyEnvironment('premarket');
  const positions = await enrichOpenPositions(await getPremarketOpenPositions());

  let lastTrade = null;
  let lastEvent = null;
  let symbolStateToday = { count: 0, latest: null, symbols: [] };
  try {
    lastTrade = await queryLatestPremarketTrade();
    lastEvent = await queryLatestPremarketEvent();
    symbolStateToday = await queryPremarketSymbolStateForToday(marketContext.et_date);
  } catch (err) {
    console.warn('[healthCheck] Premarket table query:', err.message);
  }

  const recentSignalActivity = formatPremarketSignalActivity(
    symbolStateToday.latest,
    symbolStateToday.count,
    marketContext.et_date
  );

  const activityCandidates = [
    lastTrade && {
      source: 'premarket_trade_log',
      timestamp: lastTrade.closed_at,
      summary: `Closed ${lastTrade.ticker} ${lastTrade.direction} (${lastTrade.close_reason || 'n/a'})`,
      detail: lastTrade,
    },
    lastEvent && {
      source: 'premarket_event_log',
      timestamp: lastEvent.created_at,
      summary: `${lastEvent.event_type} ${lastEvent.ticker}`,
      detail: lastEvent,
    },
    recentSignalActivity.found && {
      source: 'premarket_state',
      timestamp: recentSignalActivity.timestamp,
      summary: recentSignalActivity.summary,
      detail: recentSignalActivity.detail,
    },
    botState?.updated_at && {
      source: 'premarket_state_ledger',
      timestamp: botState.updated_at,
      summary: 'Premarket budget ledger updated',
      detail: { monthly_spend: botState.monthly_spend },
    },
    ...positions.map((p) => ({
      source: 'premarket_positions',
      timestamp: p.opened_at,
      summary: `Open ${p.ticker} ${p.direction}`,
      detail: p,
    })),
  ].filter(Boolean);

  const recentActivity = pickLatestActivity(activityCandidates);
  const recentEvent = lastEvent
    ? {
        source: 'premarket_event_log',
        timestamp: parseTimestamp(lastEvent.created_at)?.toISOString() || lastEvent.created_at,
        summary: `${lastEvent.event_type} ${lastEvent.ticker} ${lastEvent.direction || ''}`.trim(),
        detail: lastEvent,
      }
    : null;

  return {
    strategy: 'premarket_breakout',
    execution_mode: mode,
    environment,
    budget: buildBudget(budgetSnap.max, budgetSnap.spent),
    positions: buildPositionBlock(positions, getPremarketMaxPositions(environment)),
    recent_signal_activity: recentSignalActivity,
    recent_activity: recentActivity,
    recent_event: recentEvent,
    health: evaluateSignalStaleness(recentSignalActivity, marketContext),
  };
}

async function buildEmaVwapHealth(marketContext) {
  const mode = await getEmaVwapMode();
  const botState = await getEmaVwapBotState();
  const budgetSnap = await getStrategyBudgetSnapshot('emavwap');
  const environment = await getStrategyEnvironment('emavwap');
  const positions = await enrichOpenPositions(await getEmaVwapOpenPositions());

  let lastTrade = null;
  let symbolStateToday = { count: 0, latest: null, symbols: [] };
  try {
    lastTrade = await queryLatestEmaVwapTrade();
    symbolStateToday = await queryEmaVwapSymbolStateForToday(marketContext.et_date);
  } catch (err) {
    console.warn('[healthCheck] EMA/VWAP table query:', err.message);
  }

  const recentSignalActivity = formatEmaVwapSignalActivity(
    symbolStateToday.latest,
    symbolStateToday.count,
    marketContext.et_date
  );

  const activityCandidates = [
    lastTrade && {
      source: 'emavwap_trade_log',
      timestamp: lastTrade.closed_at,
      summary: `Closed ${lastTrade.ticker} ${lastTrade.direction} (${lastTrade.close_reason || 'n/a'})`,
      detail: lastTrade,
    },
    recentSignalActivity.found && {
      source: 'emavwap_state',
      timestamp: recentSignalActivity.timestamp,
      summary: recentSignalActivity.summary,
      detail: recentSignalActivity.detail,
    },
    botState?.updated_at && {
      source: 'emavwap_state_ledger',
      timestamp: botState.updated_at,
      summary: 'EMA/VWAP budget ledger updated',
      detail: { monthly_spend: botState.monthly_spend },
    },
    ...positions.map((p) => ({
      source: 'emavwap_positions',
      timestamp: p.opened_at,
      summary: `Open ${p.ticker} ${p.direction}`,
      detail: p,
    })),
  ].filter(Boolean);

  const recentActivity = pickLatestActivity(activityCandidates);

  return {
    strategy: 'ema_vwap_cross',
    execution_mode: mode,
    environment,
    budget: buildBudget(budgetSnap.max, budgetSnap.spent),
    positions: buildPositionBlock(positions, EMA_VWAP_MAX_POSITIONS),
    recent_signal_activity: recentSignalActivity,
    recent_activity: recentActivity,
    recent_event: null,
    health: evaluateSignalStaleness(recentSignalActivity, marketContext),
  };
}

export async function buildDiagnosticsHealthReport() {
  const marketContext = getMarketContext();

  const [swing, orb, premarket, emaVwap] = await Promise.all([
    buildSwingHealth(marketContext),
    buildOrbHealth(marketContext),
    buildPremarketHealth(marketContext),
    buildEmaVwapHealth(marketContext),
  ]);

  const statuses = [swing, orb, premarket, emaVwap].map((s) => s.health.status);
  const overall =
    statuses.includes('STALE') || statuses.includes('NO_ACTIVITY_TODAY')
      ? 'DEGRADED'
      : marketContext.is_market_hours
        ? 'OK'
        : 'MARKET_CLOSED';

  return {
    ...marketContext,
    overall,
    strategies: {
      swing,
      orb,
      premarket_breakout: premarket,
      ema_vwap_cross: emaVwap,
    },
  };
}
