import { getSql } from '../sqlClient.js';
import { getOpenPositions } from '../db.js';
import { getOrbOpenPositions } from '../orb/orbDb.js';
import { getPremarketOpenPositions } from '../premarketBreakout/premarketDb.js';
import { getEmaVwapOpenPositions } from '../emaVwapCross/emaVwapDb.js';
import { ORB_BUDGET_MAX } from '../orb/orbConfig.js';
import { PREMARKET_BUDGET_MAX } from '../premarketBreakout/premarketConfig.js';
import { EMA_VWAP_BUDGET_MAX } from '../emaVwapCross/emaVwapConfig.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { getLiveBudgetTotal, getLiveBudgetCacheMeta } from './liveBudget.js';
import { refreshLiveRiskState } from './liveRiskSync.js';

/** Weekly top-off / base allocation for swing (16.67% of $1,797 weekly pool). */
export const SWING_WEEKLY_TOP_OFF = 299.5;

let schemaReady;

export const BUDGET_SPLIT_VERSION = 3;

/** One-time deltas from swing-50% split → premarket 50% / others 16.67% base split. */
const BUDGET_SPLIT_ADJUSTMENTS = {
  swing: -599,
  orb: 0,
  premarket: 599,
  emavwap: 0,
};

const STRATEGY_CONFIG = {
  swing: { weekly_top_off: SWING_WEEKLY_TOP_OFF, initial: SWING_WEEKLY_TOP_OFF },
  orb: { weekly_top_off: ORB_BUDGET_MAX, initial: ORB_BUDGET_MAX },
  premarket: { weekly_top_off: PREMARKET_BUDGET_MAX, initial: PREMARKET_BUDGET_MAX },
  emavwap: { weekly_top_off: EMA_VWAP_BUDGET_MAX, initial: EMA_VWAP_BUDGET_MAX },
};

function rowToObject(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row));
}

function getEtParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
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

export function getNextWeeklyTopOffEt(now = new Date()) {
  const { year, month, day, weekday, hours, minutes } = getEtParts(now);
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  let daysUntilMonday = (8 - dayIndex) % 7;
  if (daysUntilMonday === 0 && (hours > 0 || minutes >= 1)) {
    daysUntilMonday = 7;
  }
  if (daysUntilMonday === 0 && hours === 0 && minutes < 1) {
    daysUntilMonday = 0;
  }

  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + daysUntilMonday);
  const y = base.getUTCFullYear();
  const m = String(base.getUTCMonth() + 1).padStart(2, '0');
  const d = String(base.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}T00:01:00 America/New_York`;
}

export async function ensureBudgetAllocationsSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();
    await sql`
      CREATE TABLE IF NOT EXISTS budget_allocations (
        strategy TEXT PRIMARY KEY,
        total_allocated DOUBLE PRECISION NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    for (const [strategy, config] of Object.entries(STRATEGY_CONFIG)) {
      await sql`
        INSERT INTO budget_allocations (strategy, total_allocated, updated_at)
        VALUES (${strategy}, ${config.initial}, NOW()::text)
        ON CONFLICT (strategy) DO NOTHING
      `;
    }
  })();
  return schemaReady;
}

export async function applyBudgetSplitAdjustmentIfNeeded() {
  await ensureBudgetAllocationsSchema();
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS budget_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  const [existing] = await sql`
    SELECT value FROM budget_meta WHERE key = 'split_adjustment_version'
  `;
  if (existing?.value === String(BUDGET_SPLIT_VERSION)) {
    return { applied: false, reason: 'already_applied' };
  }

  const beforeRows = await sql`
    SELECT strategy, total_allocated FROM budget_allocations ORDER BY strategy
  `;
  const before = Object.fromEntries(
    beforeRows.map((row) => [row.strategy, Number(row.total_allocated)])
  );

  const adjustments = [];
  for (const [strategy, delta] of Object.entries(BUDGET_SPLIT_ADJUSTMENTS)) {
    const [row] = await sql`
      UPDATE budget_allocations
      SET total_allocated = total_allocated + ${delta},
          updated_at = NOW()::text
      WHERE strategy = ${strategy}
      RETURNING strategy, total_allocated
    `;
    adjustments.push({
      strategy,
      delta,
      before: before[strategy] ?? null,
      after: Number(row.total_allocated),
    });
    console.log(
      `[Budget] Split adjustment ${strategy}: ${before[strategy]?.toFixed(2)} → ${Number(row.total_allocated).toFixed(2)} (delta ${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`
    );
  }

  await sql`
    INSERT INTO budget_meta (key, value, updated_at)
    VALUES ('split_adjustment_version', ${String(BUDGET_SPLIT_VERSION)}, NOW()::text)
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;

  return { applied: true, adjustments };
}

export async function getTotalAllocated(strategy) {
  const environment = await getStrategyEnvironment(strategy);
  if (environment === 'live') {
    if (!getLiveBudgetCacheMeta().updatedAt) {
      await refreshLiveRiskState();
    }
    return getLiveBudgetTotal(strategy);
  }

  await ensureBudgetAllocationsSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT total_allocated FROM budget_allocations WHERE strategy = ${strategy}
  `;
  if (rows.length === 0) {
    return STRATEGY_CONFIG[strategy]?.initial ?? 0;
  }
  return Number(rows[0].total_allocated);
}

/** Capital currently tied up in open contracts (reusable when positions close). */
export function positionDeployedCost(position) {
  const premium = Number(position.entry_premium) || 0;
  const contracts = Number(position.contracts_open ?? position.quantity) || 0;
  return premium * 100 * contracts;
}

export function sumDeployedCapital(positions) {
  return (positions || []).reduce((sum, position) => sum + positionDeployedCost(position), 0);
}

async function getStrategySpent(strategy) {
  if (strategy === 'swing') {
    return sumDeployedCapital(await getOpenPositions());
  }
  if (strategy === 'orb') {
    return sumDeployedCapital(await getOrbOpenPositions());
  }
  if (strategy === 'premarket') {
    return sumDeployedCapital(await getPremarketOpenPositions());
  }
  if (strategy === 'emavwap') {
    return sumDeployedCapital(await getEmaVwapOpenPositions());
  }
  return 0;
}

export async function getSwingBudgetRemaining() {
  const total = await getTotalAllocated('swing');
  const spent = await getStrategySpent('swing');
  return Math.max(0, total - spent);
}

export async function getSwingTotalAllocated() {
  return getTotalAllocated('swing');
}

export async function getOrbBudgetRemaining() {
  const total = await getTotalAllocated('orb');
  const spent = await getStrategySpent('orb');
  return Math.max(0, total - spent);
}

export async function getPremarketBudgetRemaining() {
  const total = await getTotalAllocated('premarket');
  const spent = await getStrategySpent('premarket');
  return Math.max(0, total - spent);
}

export async function getEmaVwapBudgetRemaining() {
  const total = await getTotalAllocated('emavwap');
  const spent = await getStrategySpent('emavwap');
  return Math.max(0, total - spent);
}

const STRATEGY_LABELS = {
  swing: 'Swing',
  orb: '0DTE ORB',
  premarket: 'Premarket Breakout',
  emavwap: 'EMA/VWAP Cross',
};

export async function getStrategyBudgetSnapshot(strategy) {
  const environment = await getStrategyEnvironment(strategy);
  const total = await getTotalAllocated(strategy);
  const spent = await getStrategySpent(strategy);
  const weeklyTopOff = environment === 'live' ? null : (STRATEGY_CONFIG[strategy]?.weekly_top_off ?? 0);
  const liveMeta = environment === 'live' ? getLiveBudgetCacheMeta() : null;

  return {
    strategy,
    label: STRATEGY_LABELS[strategy] || strategy,
    total_allocated: total,
    max: total,
    spent,
    remaining: Math.max(0, total - spent),
    weekly_top_off: weeklyTopOff,
    budget_mode: environment,
    live_account_cash: liveMeta?.cashBalance ?? null,
    live_strategies_count: liveMeta?.liveCount ?? null,
  };
}

export async function getAllBudgetAllocations() {
  await ensureBudgetAllocationsSchema();
  const strategies = {};
  for (const key of Object.keys(STRATEGY_CONFIG)) {
    strategies[key] = await getStrategyBudgetSnapshot(key);
  }
  return {
    generated_at: new Date().toISOString(),
    next_weekly_top_off_et: getNextWeeklyTopOffEt(),
    strategies,
  };
}

/** For handlers.js dashboard budget cards. */
export async function getDashboardBudgets() {
  const all = await getAllBudgetAllocations();
  return {
    swing_budget: all.strategies.swing,
    orb_budget: all.strategies.orb,
    premarket_budget: all.strategies.premarket,
    emavwap_budget: all.strategies.emavwap,
  };
}

export async function runWeeklyBudgetTopOff() {
  await ensureBudgetAllocationsSchema();
  const sql = getSql();
  const results = [];

  for (const [strategy, config] of Object.entries(STRATEGY_CONFIG)) {
    const [row] = await sql`
      UPDATE budget_allocations
      SET total_allocated = total_allocated + ${config.weekly_top_off},
          updated_at = NOW()::text
      WHERE strategy = ${strategy}
      RETURNING strategy, total_allocated
    `;
    const updated = rowToObject(row);
    console.log(
      `[Budget] Weekly top-off ${strategy}: +$${config.weekly_top_off.toFixed(2)} → total_allocated=$${Number(updated.total_allocated).toFixed(2)}`
    );
    results.push({
      strategy,
      added: config.weekly_top_off,
      total_allocated: Number(updated.total_allocated),
    });
  }

  return results;
}
