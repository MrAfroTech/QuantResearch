import { getSql } from './sqlClient.js';
import {
  getBotState,
  setExecutionMode,
  getTradeLog,
  getLastSignal,
} from './db.js';
import {
  getPositionsWithPnL,
} from './positionManager.js';
import { isPaperTrading, getOptionPremium } from './brokerageConnector.js';
import { getQuote } from './tradierClient.js';
import { sendModeSwitchTelegram } from './telegramHandler.js';
import { getLastScanResults } from './cloudScanner.js';
import { getWatchlist, areDashboardControlsEnabled } from './config.js';
import { getPremarketOpenPositions, getPremarketTradeLog } from './premarketBreakout/premarketDb.js';
import { getOrbOpenPositions } from './orb/orbDb.js';
import { getEmaVwapOpenPositions } from './emaVwapCross/emaVwapDb.js';
import { loadSymbolRangeState } from './orb/orbRangeState.js';
import { getDashboardBudgets } from './budget/budgetAllocations.js';
import {
  getAllStrategyEnvironments,
  setStrategyEnvironment,
} from './strategyEnvironment.js';
import { isNeverOpenedCloseReason } from './tradePnl.js';

const ORB_SYMBOLS = ['SPY', 'QQQ', 'IWM'];
const TRADE_LOG_LIMIT = 40;

let schemaReady;

async function ensureHandlerSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();
    await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS swing_mode TEXT DEFAULT 'AUTO'`;
    await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS orb_mode TEXT DEFAULT 'AUTO'`;
    await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS premarket_mode TEXT DEFAULT 'AUTO'`;
  })();
  return schemaReady;
}

function getEtParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hours: Number(get('hour')),
    minutes: Number(get('minute')),
    weekday: get('weekday'),
  };
}

function etDateKey(date = new Date()) {
  const { year, month, day } = getEtParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function etMonthKey(date = new Date()) {
  const { year, month } = getEtParts(date);
  return `${year}-${String(month).padStart(2, '0')}`;
}

function mondayOfWeekEt(date = new Date()) {
  const { year, month, day, weekday } = getEtParts(date);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const diff = dayIndex === 0 ? -6 : 1 - dayIndex;
  utc.setUTCDate(utc.getUTCDate() + diff);
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

function parseClosedAtEt(trade) {
  if (!trade?.closed_at) return null;
  const raw = String(trade.closed_at);
  const dateOnly = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return dateOnly;
  return etDateKey(new Date(raw));
}

function computeDte(expiration) {
  if (!expiration) return null;
  const expKey = String(expiration).slice(0, 10);
  const todayKey = etDateKey();
  const exp = new Date(`${expKey}T12:00:00Z`);
  const today = new Date(`${todayKey}T12:00:00Z`);
  return Math.round((exp - today) / (1000 * 60 * 60 * 24));
}

function inferStrategy(ticker, expiration) {
  const symbol = String(ticker || '').toUpperCase();
  const dte = computeDte(expiration);
  if (ORB_SYMBOLS.includes(symbol) && dte != null && dte <= 0) return 'orb';
  return 'swing';
}

function positionCost(position) {
  const contracts = Number(position.contracts_open ?? position.quantity) || 1;
  return (Number(position.entry_premium) || 0) * 100 * contracts;
}

function tradePnlDollars(trade) {
  // Never-opened closes must not contribute phantom dollar P&L even if exit_premium differs.
  if (isNeverOpenedCloseReason(trade.close_reason)) return 0;
  if (trade.realized_pnl != null && Number.isFinite(Number(trade.realized_pnl))) {
    return Number(trade.realized_pnl);
  }
  const entry = Number(trade.entry_premium) || 0;
  const exit = Number(trade.exit_premium) || 0;
  const qty = Number(trade.quantity) || 1;
  return (exit - entry) * 100 * qty;
}

function sumTradeLogPnlDollars(trades) {
  return (trades || []).reduce((sum, trade) => sum + tradePnlDollars(trade), 0);
}

function computeRoiPercent(allTimePnlDollars, maxBudget) {
  const max = Number(maxBudget);
  if (!Number.isFinite(max) || max === 0) return null;
  const pnl = Number(allTimePnlDollars);
  if (!Number.isFinite(pnl)) return null;
  return Number(((pnl / max) * 100).toFixed(2));
}

/**
 * All-time win rate from closed legs (same window as ROI %).
 * Excludes never-opened closes; breakeven ($0) legs are omitted from W/L counts.
 */
function computeWinRateStats(trades) {
  let wins = 0;
  let losses = 0;
  for (const trade of trades || []) {
    if (isNeverOpenedCloseReason(trade.close_reason)) continue;
    const pnl = tradePnlDollars(trade);
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
  }
  const decided = wins + losses;
  return {
    wins,
    losses,
    closed_trades: decided,
    win_rate_percent:
      decided === 0 ? null : Number(((wins / decided) * 100).toFixed(1)),
  };
}

const STRATEGY_LABELS = {
  swing: 'swing',
  orb: 'orb',
  premarket: 'premarket',
  emavwap: 'emavwap',
};

/**
 * Per-ticker all-time W/L across strategies (same rules as strategy win rate).
 * Returns one entry per watchlist symbol (plus any traded tickers not on the list).
 */
function computeTickerWinRates(labeledTradeGroups, watchlist = []) {
  const byTicker = new Map();

  function ensure(ticker) {
    const key = String(ticker || '').toUpperCase();
    if (!key) return null;
    if (!byTicker.has(key)) {
      byTicker.set(key, {
        ticker: key,
        wins: 0,
        losses: 0,
        closed_trades: 0,
        win_rate_percent: null,
        by_strategy: {},
      });
    }
    return byTicker.get(key);
  }

  for (const symbol of watchlist) ensure(symbol);

  for (const { strategy, trades } of labeledTradeGroups || []) {
    const strat = STRATEGY_LABELS[strategy] || strategy;
    for (const trade of trades || []) {
      const entry = ensure(trade.ticker);
      if (!entry) continue;
      if (isNeverOpenedCloseReason(trade.close_reason)) continue;
      const pnl = tradePnlDollars(trade);
      if (!(pnl > 0) && !(pnl < 0)) continue;
      if (!entry.by_strategy[strat]) {
        entry.by_strategy[strat] = { wins: 0, losses: 0, closed_trades: 0, win_rate_percent: null };
      }
      const stratStats = entry.by_strategy[strat];
      if (pnl > 0) {
        entry.wins += 1;
        stratStats.wins += 1;
      } else {
        entry.losses += 1;
        stratStats.losses += 1;
      }
    }
  }

  for (const entry of byTicker.values()) {
    entry.closed_trades = entry.wins + entry.losses;
    entry.win_rate_percent =
      entry.closed_trades === 0
        ? null
        : Number(((entry.wins / entry.closed_trades) * 100).toFixed(1));
    for (const stratStats of Object.values(entry.by_strategy)) {
      stratStats.closed_trades = stratStats.wins + stratStats.losses;
      stratStats.win_rate_percent =
        stratStats.closed_trades === 0
          ? null
          : Number(((stratStats.wins / stratStats.closed_trades) * 100).toFixed(1));
    }
  }

  const watchKeys = new Set((watchlist || []).map((t) => String(t).toUpperCase()));
  const ordered = [];
  for (const symbol of watchlist || []) {
    const key = String(symbol).toUpperCase();
    if (byTicker.has(key)) ordered.push(byTicker.get(key));
  }
  for (const [key, entry] of byTicker) {
    if (!watchKeys.has(key) && entry.closed_trades > 0) ordered.push(entry);
  }
  return ordered;
}

async function fetchAllSwingTradesForPnl() {
  const sql = getSql();
  const rows = await sql`
    SELECT ticker, entry_premium, exit_premium, quantity, close_reason
    FROM trade_log
  `;
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

async function fetchAllOrbTradesForPnl() {
  const sql = getSql();
  const rows = await sql`
    SELECT ticker, entry_premium, exit_premium, quantity, realized_pnl, close_reason
    FROM orb_trade_log
  `;
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

async function fetchAllPremarketTradesForPnl() {
  const sql = getSql();
  const rows = await sql`
    SELECT ticker, entry_premium, exit_premium, quantity, realized_pnl, close_reason
    FROM premarket_trade_log
  `;
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

async function fetchAllEmaVwapTradesForPnl() {
  const sql = getSql();
  const rows = await sql`
    SELECT ticker, entry_premium, exit_premium, quantity, realized_pnl, close_reason
    FROM emavwap_trade_log
  `;
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

function isOpenedThisMonth(openedAt) {
  if (!openedAt) return false;
  const raw = String(openedAt);
  const key = raw.length >= 7 && raw[4] === '-' ? raw.slice(0, 7) : etMonthKey(new Date(raw));
  return key === etMonthKey();
}

/** Headline Monthly / All-Time P&L floor. Daily / Weekly cards do not use this. */
export const HEADLINE_PNL_START_UTC = '2026-08-14T00:00:00Z';
const HEADLINE_PNL_START_MS = Date.parse(HEADLINE_PNL_START_UTC);

function liveStrategyKeys(environments = {}) {
  return new Set(
    Object.entries(environments)
      .filter(([, env]) => String(env).toLowerCase() === 'live')
      .map(([strategy]) => strategy)
  );
}

function parseClosedAtMs(trade) {
  if (!trade?.closed_at) return null;
  let s = String(trade.closed_at).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} /.test(s) && !s.includes('T')) {
    s = s.replace(' ', 'T');
  }
  if (/\+\d{2}$/.test(s)) s += ':00';
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function closedAtOnOrAfterHeadlineStart(trade) {
  const ms = parseClosedAtMs(trade);
  if (ms != null) return ms >= HEADLINE_PNL_START_MS;
  const closeKey = parseClosedAtEt(trade);
  return Boolean(closeKey) && closeKey >= HEADLINE_PNL_START_UTC.slice(0, 10);
}

/**
 * Daily / Weekly: all strategies, no date floor (unchanged).
 * Monthly / All-Time: currently-live strategies only, closed_at >= HEADLINE_PNL_START_UTC.
 *
 * Live/paper is the *current* strategy-level flag (bot_state / emavwap_state), applied
 * retroactively to the date window — trade logs have no per-trade environment column.
 */
export function computePerformance(trades, openPositions, environments = {}) {
  const todayKey = etDateKey();
  const weekStart = mondayOfWeekEt();
  const monthKey = etMonthKey();
  const liveKeys = liveStrategyKeys(environments);

  let dailyPnl = 0;
  let weeklyPnl = 0;
  let monthlyPnl = 0;
  let alltimePnl = 0;

  for (const trade of trades) {
    const closeKey = parseClosedAtEt(trade);
    if (!closeKey) continue;
    const pnl = tradePnlDollars(trade);
    if (closeKey === todayKey) dailyPnl += pnl;
    if (closeKey >= weekStart) weeklyPnl += pnl;

    if (!liveKeys.has(trade._strategy)) continue;
    if (!closedAtOnOrAfterHeadlineStart(trade)) continue;
    alltimePnl += pnl;
    if (closeKey.slice(0, 7) === monthKey) monthlyPnl += pnl;
  }

  const currentlyInvested = openPositions.reduce((sum, p) => sum + positionCost(p), 0);

  return {
    daily_pnl: dailyPnl,
    weekly_pnl: weeklyPnl,
    monthly_pnl: monthlyPnl,
    alltime_pnl: alltimePnl,
    currently_invested: currentlyInvested,
    open_position_count: openPositions.length,
  };
}

function toBudgetCard(snapshot, allTimePnlDollars = null, winStats = null) {
  const emptyWin = {
    wins: 0,
    losses: 0,
    closed_trades: 0,
    win_rate_percent: null,
  };
  const win = winStats || emptyWin;
  if (!snapshot) {
    return {
      environment: 'paper',
      max: 0,
      spent: 0,
      remaining: 0,
      roiPercent: null,
      ...emptyWin,
    };
  }
  const max = snapshot.max ?? snapshot.total_allocated ?? 0;
  return {
    environment: snapshot.budget_mode === 'live' ? 'live' : 'paper',
    max,
    spent: snapshot.spent ?? 0,
    remaining: snapshot.remaining ?? 0,
    roiPercent: computeRoiPercent(allTimePnlDollars, max),
    wins: win.wins,
    losses: win.losses,
    closed_trades: win.closed_trades,
    win_rate_percent: win.win_rate_percent,
  };
}

async function computeAllStrategyBudgets(watchlist = []) {
  const [budgets, swingTrades, orbTrades, premarketTrades, emaVwapTrades] = await Promise.all([
    getDashboardBudgets(),
    fetchAllSwingTradesForPnl(),
    fetchAllOrbTradesForPnl(),
    fetchAllPremarketTradesForPnl(),
    fetchAllEmaVwapTradesForPnl(),
  ]);

  const swingPnl = sumTradeLogPnlDollars(swingTrades);
  const orbPnl = sumTradeLogPnlDollars(orbTrades);
  const premarketPnl = sumTradeLogPnlDollars(premarketTrades);
  const emaVwapPnl = sumTradeLogPnlDollars(emaVwapTrades);

  const ticker_win_rates = computeTickerWinRates(
    [
      { strategy: 'swing', trades: swingTrades },
      { strategy: 'orb', trades: orbTrades },
      { strategy: 'premarket', trades: premarketTrades },
      { strategy: 'emavwap', trades: emaVwapTrades },
    ],
    watchlist
  );

  return {
    swing_budget: toBudgetCard(budgets.swing_budget, swingPnl, computeWinRateStats(swingTrades)),
    orb_budget: toBudgetCard(budgets.orb_budget, orbPnl, computeWinRateStats(orbTrades)),
    premarket_budget: toBudgetCard(
      budgets.premarket_budget,
      premarketPnl,
      computeWinRateStats(premarketTrades)
    ),
    emavwap_budget: toBudgetCard(
      budgets.emavwap_budget,
      emaVwapPnl,
      computeWinRateStats(emaVwapTrades)
    ),
    ticker_win_rates,
  };
}

async function enrichPositionsWithPnL(positions) {
  const enriched = [];
  for (const position of positions) {
    try {
      const currentPremium = await getOptionPremium(
        position.ticker,
        position.direction,
        position.strike,
        position.expiration
      );
      const entry = Number(position.entry_premium);
      const pnlPct =
        Number.isFinite(entry) && entry > 0
          ? ((currentPremium - entry) / entry) * 100
          : null;
      enriched.push({ ...position, currentPremium, pnlPct });
    } catch {
      enriched.push({ ...position, currentPremium: null, pnlPct: null });
    }
  }
  return enriched;
}

async function fetchOrbTradeLog(limit = 500) {
  await getOrbOpenPositions();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM orb_trade_log ORDER BY closed_at DESC LIMIT ${limit}
  `;
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

async function fetchEmaVwapTradeLog(limit = 500) {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM emavwap_trade_log ORDER BY closed_at DESC LIMIT ${limit}
  `;
  return rows.map((row) => Object.fromEntries(Object.entries(row)));
}

function mapOpenPosition(position, strategyOverride) {
  const strategy = strategyOverride || inferStrategy(position.ticker, position.expiration);
  const dte = computeDte(position.expiration);
  const pnlPct = position.pnlPct ?? position.pnl_pct ?? null;
  return {
    id: position.id,
    strategy,
    ticker: position.ticker,
    direction: position.direction,
    strike: position.strike,
    expiry: position.expiration,
    entry_premium: position.entry_premium,
    current_mid: position.currentPremium ?? position.current_mid ?? null,
    pnl_pct: pnlPct,
    dte,
    contracts: position.quantity ?? position.contracts ?? 1,
  };
}

function mapTradeLogEntry(trade, strategyOverride) {
  return {
    id: trade.id,
    date: trade.closed_at,
    strategy: strategyOverride || inferStrategy(trade.ticker, trade.expiration),
    ticker: trade.ticker,
    direction: trade.direction,
    entry_premium: trade.entry_premium,
    exit_premium: trade.exit_premium,
    pnl_pct: trade.pnl_pct,
    close_reason: trade.close_reason,
    strike: trade.strike,
    expiration: trade.expiration,
    closed_at: trade.closed_at,
  };
}

function getOrbMarketWindow() {
  const { hours, minutes, weekday } = getEtParts();
  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  const minutesSinceMidnight = hours * 60 + minutes;
  const marketOpen = 9 * 60 + 30;
  const hardStop = 15 * 60;
  const active = isWeekday && minutesSinceMidnight >= marketOpen && minutesSinceMidnight < hardStop;
  const minutesToHardStop = active ? hardStop - minutesSinceMidnight : null;
  return { active, minutesToHardStop, isWeekday };
}

function buildOrbRangeFromScan(scanResults, symbol) {
  const row = scanResults.find(
    (r) => String(r.ticker || r.tv_ticker || '').toUpperCase() === symbol
  );
  const currentPrice = row?.curr_px ?? null;
  return {
    high: null,
    low: null,
    current_price: currentPrice,
    position: null,
    // Intentionally not using swing-scan signal — that is a different strategy.
    signal: null,
  };
}

function withRangePosition(range) {
  const { high, low, current_price: price } = range;
  if (price == null || high == null || low == null) {
    return { ...range, position: null };
  }
  if (price > high) return { ...range, position: 'ABOVE' };
  if (price < low) return { ...range, position: 'BELOW' };
  return { ...range, position: 'INSIDE' };
}

async function fetchSpotPrice(symbol, scanFallbackPrice = null) {
  try {
    const quote = await getQuote(symbol);
    const last = Number(quote?.last);
    if (Number.isFinite(last) && last > 0) return last;
  } catch (err) {
    console.warn(`[handlers] Quote failed for ${symbol}:`, err.message);
  }
  const fallback = Number(scanFallbackPrice);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

/**
 * Dashboard ORB cards — sourced from orb_range_state (not the swing TV scan).
 * Signal/direction come from the live FSM so they cannot disagree with phase.
 */
async function buildOrbStatus(scanResults) {
  const { active, minutesToHardStop } = getOrbMarketWindow();
  const tradeDate = etDateKey();
  const openingRanges = {};

  await Promise.all(
    ORB_SYMBOLS.map(async (symbol) => {
      const scanSlice = buildOrbRangeFromScan(scanResults, symbol);
      const state = await loadSymbolRangeState(symbol, tradeDate);
      const currentPrice = await fetchSpotPrice(symbol, scanSlice.current_price);
      const fsm = state.fsm || {};
      const direction =
        fsm.direction === 'CALL' || fsm.direction === 'PUT' ? fsm.direction : null;

      openingRanges[symbol] = withRangePosition({
        high: state.orHigh,
        low: state.orLow,
        current_price: currentPrice,
        range_complete: state.rangeComplete,
        phase: fsm.phase || null,
        direction,
        breakout_level: fsm.breakout_level ?? null,
        // ORB signal = FSM direction only (not swing-scan CALL/PUT).
        signal: direction,
      });
    })
  );

  return {
    active,
    opening_ranges: openingRanges,
    minutes_to_hard_stop: minutesToHardStop,
    trade_date: tradeDate,
  };
}

export async function buildStatusResponse() {
  await ensureHandlerSchema();

  const state = await getBotState();
  const [
    rawSwingPositions,
    orbPositionsRaw,
    premarketPositionsRaw,
    emaVwapPositionsRaw,
    environments,
  ] = await Promise.all([
    getPositionsWithPnL(),
    getOrbOpenPositions(),
    getPremarketOpenPositions(),
    getEmaVwapOpenPositions(),
    getAllStrategyEnvironments(),
  ]);
  const [orbPositions, premarketPositions, emaVwapPositions] = await Promise.all([
    enrichPositionsWithPnL(orbPositionsRaw),
    enrichPositionsWithPnL(premarketPositionsRaw),
    enrichPositionsWithPnL(emaVwapPositionsRaw),
  ]);

  const [swingTrades, orbTrades, premarketTrades, emaVwapTrades] = await Promise.all([
    getTradeLog(500),
    fetchOrbTradeLog(500),
    getPremarketTradeLog(500),
    fetchEmaVwapTradeLog(500),
  ]);

  const allTrades = [
    ...swingTrades.map((t) => ({ ...t, _strategy: 'swing' })),
    ...orbTrades.map((t) => ({ ...t, _strategy: 'orb' })),
    ...premarketTrades.map((t) => ({ ...t, _strategy: 'premarket' })),
    ...emaVwapTrades.map((t) => ({ ...t, _strategy: 'emavwap' })),
  ].sort((a, b) => String(b.closed_at || '').localeCompare(String(a.closed_at || '')));

  const liveKeys = liveStrategyKeys(environments);
  const tradeLog = allTrades
    .filter((trade) => liveKeys.has(trade._strategy))
    .slice(0, TRADE_LOG_LIMIT)
    .map((trade) => mapTradeLogEntry(trade, trade._strategy));

  const lastSignal = await getLastSignal();
  const watchlist = getWatchlist();
  const scanResults = getLastScanResults();

  const swingMode = state.swing_mode || state.execution_mode || 'AUTO';
  const orbMode = state.orb_mode || 'AUTO';
  const premarketMode = state.premarket_mode || 'AUTO';
  const [budgets, orbStatus] = await Promise.all([
    computeAllStrategyBudgets(watchlist),
    buildOrbStatus(scanResults),
  ]);
  const swingBudget = budgets.swing_budget;

  const openPositions = [
    ...rawSwingPositions.map((p) => mapOpenPosition(p, 'swing')),
    ...orbPositions.map((p) => mapOpenPosition(p, 'orb')),
    ...premarketPositions.map((p) => mapOpenPosition(p, 'premarket')),
    ...emaVwapPositions.map((p) => mapOpenPosition(p, 'emavwap')),
  ];

  const performance = computePerformance(
    allTrades,
    [
      ...rawSwingPositions,
      ...orbPositions,
      ...premarketPositions,
      ...emaVwapPositions,
    ],
    environments
  );

  return {
    execution_mode: state.execution_mode,
    swing_mode: swingMode,
    orb_mode: orbMode,
    premarket_mode: premarketMode,
    paper_trading: isPaperTrading(),
    strategy_environments: {
      swing: environments.swing,
      orb: environments.orb,
      premarket: environments.premarket,
      emavwap: environments.emavwap,
    },
    swing_environment: environments.swing,
    orb_environment: environments.orb,
    premarket_environment: environments.premarket,
    emavwap_environment: environments.emavwap,
    monthly_spend: swingBudget.spent,
    budget_remaining: swingBudget.remaining,
    max_budget: swingBudget.max,
    performance,
    swing_budget: budgets.swing_budget,
    orb_budget: budgets.orb_budget,
    premarket_budget: budgets.premarket_budget,
    emavwap_budget: budgets.emavwap_budget,
    ticker_win_rates: budgets.ticker_win_rates || [],
    orb_status: orbStatus,
    watchlist,
    watchlist_count: watchlist.length,
    last_signal_checked: lastSignal,
    open_positions: openPositions,
    trade_log: tradeLog,
    server_time: new Date().toISOString(),
    last_scan_results: scanResults,
    dashboard_controls_enabled: areDashboardControlsEnabled(),
  };
}

export async function switchExecutionMode(input, strategyArg) {
  await ensureHandlerSchema();

  let mode = typeof input === 'string' ? input : input?.mode;
  let strategy = (typeof input === 'object' && input?.strategy) || strategyArg || 'swing';

  if (typeof mode === 'string' && mode.includes('|')) {
    const [parsedMode, parsedStrategy] = mode.split('|');
    mode = parsedMode;
    strategy = parsedStrategy || strategy;
  }

  if (typeof mode === 'string' && /^ENV:/i.test(mode)) {
    return switchStrategyEnvironment(mode, strategy);
  }

  if (!['AUTO', 'MANUAL'].includes(mode)) {
    throw new Error('Mode must be AUTO or MANUAL');
  }
  if (!['swing', 'orb', 'premarket'].includes(strategy)) {
    throw new Error('Strategy must be swing, orb, or premarket');
  }

  const sql = getSql();

  if (strategy === 'orb') {
    await sql`
      UPDATE bot_state
      SET orb_mode = ${mode}, updated_at = NOW()::text
      WHERE id = 1
    `;
  } else if (strategy === 'premarket') {
    await sql`
      UPDATE bot_state
      SET premarket_mode = ${mode}, updated_at = NOW()::text
      WHERE id = 1
    `;
  } else {
    await sql`
      UPDATE bot_state
      SET swing_mode = ${mode}, execution_mode = ${mode}, updated_at = NOW()::text
      WHERE id = 1
    `;
    await setExecutionMode(mode);
  }

  try {
    await sendModeSwitchTelegram(`${strategy.toUpperCase()} → ${mode}`);
  } catch (err) {
    console.error('Mode switch Telegram failed:', err.message);
  }

  const state = await getBotState();
  const environments = await getAllStrategyEnvironments();
  return {
    mode,
    strategy,
    swing_mode: state.swing_mode || state.execution_mode || mode,
    orb_mode: state.orb_mode || 'AUTO',
    premarket_mode: state.premarket_mode || 'AUTO',
    swing_environment: environments.swing,
    orb_environment: environments.orb,
    premarket_environment: environments.premarket,
    emavwap_environment: environments.emavwap,
  };
}

export async function switchStrategyEnvironment(input, strategyArg = 'swing') {
  let raw = typeof input === 'string' ? input : input?.mode;
  let strategy = (typeof input === 'object' && input?.strategy) || strategyArg || 'swing';

  if (typeof raw === 'string' && raw.includes('|')) {
    const [parsedEnv, parsedStrategy] = raw.split('|');
    raw = parsedEnv;
    strategy = parsedStrategy || strategy;
  }

  const environment = String(raw || '')
    .replace(/^ENV:/i, '')
    .toLowerCase();

  if (!['paper', 'live'].includes(environment)) {
    throw new Error('Environment must be paper or live');
  }
  if (!['swing', 'orb', 'premarket', 'emavwap'].includes(strategy)) {
    throw new Error('Strategy must be swing, orb, premarket, or emavwap');
  }

  await setStrategyEnvironment(strategy, environment);

  try {
    await sendModeSwitchTelegram(`${strategy.toUpperCase()} environment → ${environment.toUpperCase()}`);
  } catch (err) {
    console.error('Environment switch Telegram failed:', err.message);
  }

  const state = await getBotState();
  const environments = await getAllStrategyEnvironments();
  return {
    environment,
    strategy,
    swing_mode: state.swing_mode || state.execution_mode || 'AUTO',
    orb_mode: state.orb_mode || 'AUTO',
    premarket_mode: state.premarket_mode || 'AUTO',
    swing_environment: environments.swing,
    orb_environment: environments.orb,
    premarket_environment: environments.premarket,
    emavwap_environment: environments.emavwap,
  };
}
