import { getAllStrategyEnvironments } from '../strategyEnvironment.js';

const LIVE_STRATEGY_KEYS = ['swing', 'orb', 'premarket', 'emavwap'];

/**
 * Fraction of available account cash the bot may deploy.
 * Shared across live strategies — not an equal split of the full account,
 * and not 100% of cash.
 */
export const LIVE_BUDGET_MAX_FRAC = 0.5;

/**
 * Per-trade cap as a fraction of shared live remaining at sizing time.
 * Account-wide for live 0DTE strategies (ORB / Premarket / EMA-VWAP): 80%
 * of the remaining tradable pool (50% of account cash minus already deployed).
 */
export const LIVE_PER_TRADE_CAP_FRAC = 0.8;

/** Strategy-specific overrides (all three live 0DTE strategies use 80%). */
export const LIVE_PER_TRADE_CAP_FRAC_BY_STRATEGY = Object.freeze({
  orb: LIVE_PER_TRADE_CAP_FRAC,
  premarket: LIVE_PER_TRADE_CAP_FRAC,
  emavwap: LIVE_PER_TRADE_CAP_FRAC,
});

/** Max dollars the bot may show / draw: 50% of available account cash. */
export function computeLiveBudgetMax(cashBalance) {
  const cash = Number(cashBalance);
  if (!Number.isFinite(cash) || cash <= 0) return 0;
  return cash * LIVE_BUDGET_MAX_FRAC;
}

/** Resolve per-trade cap frac for a strategy; default LIVE_PER_TRADE_CAP_FRAC. */
export function livePerTradeCapFracFor(strategy) {
  const keyed = LIVE_PER_TRADE_CAP_FRAC_BY_STRATEGY[strategy];
  const n = Number(keyed);
  return Number.isFinite(n) && n > 0 ? Math.min(1, n) : LIVE_PER_TRADE_CAP_FRAC;
}

let cache = {
  cashBalance: null,
  liveStrategies: [],
  /** @deprecated equal-split slices removed — kept for meta/debug shape compatibility */
  perStrategyBudget: {},
  updatedAt: null,
};

/**
 * Live allocation max: 50% of cash, shared by every live strategy (not cash÷n,
 * and not the full account). Prefer computeLiveBudgetMax; this keeps the old
 * signature for callers that still pass a strategy count.
 */
export function computeLivePerStrategyBudget(cashBalance, liveStrategyCount) {
  if (!liveStrategyCount || liveStrategyCount <= 0) return 0;
  return computeLiveBudgetMax(cashBalance);
}

/** Shared live pool remaining: 50% of account cash − Σ(deployed across live strategies). */
export function computeLiveSharedRemaining(cashBalance, deployedAcrossLive) {
  const cash = Number(cashBalance);
  const deployed = Number(deployedAcrossLive) || 0;
  if (!Number.isFinite(cash) || cash <= 0) return 0;
  const tradable = computeLiveBudgetMax(cash);
  return Math.max(0, tradable - Math.max(0, deployed));
}

/**
 * Clamp a single trade to min(sharedRemaining, sharedRemaining * capFrac).
 * With default 80%, this is 80% of shared remaining when remaining > 0.
 */
export function applyLivePerTradeCap(sharedRemaining, capFrac = LIVE_PER_TRADE_CAP_FRAC) {
  const rem = Number(sharedRemaining);
  if (!Number.isFinite(rem) || rem <= 0) return 0;
  const frac = Number(capFrac);
  const safeFrac = Number.isFinite(frac) && frac > 0 ? Math.min(1, frac) : LIVE_PER_TRADE_CAP_FRAC;
  return Math.min(rem, rem * safeFrac);
}

/**
 * Pure live sizing budget for a requesting strategy.
 * Cross-strategy FCFS: 50% of account cash − all live deployed, then per-trade cap.
 */
export function resolveLiveSizingBudget({
  cashBalance,
  deployedByStrategy = {},
  liveStrategies = [],
  requestingStrategy,
  perTradeCapFrac = LIVE_PER_TRADE_CAP_FRAC,
}) {
  if (!liveStrategies.includes(requestingStrategy)) return 0;
  const deployed = liveStrategies.reduce(
    (sum, key) => sum + (Number(deployedByStrategy[key]) || 0),
    0
  );
  const shared = computeLiveSharedRemaining(cashBalance, deployed);
  return applyLivePerTradeCap(shared, perTradeCapFrac);
}

export async function getLiveStrategyKeys() {
  const environments = await getAllStrategyEnvironments();
  return LIVE_STRATEGY_KEYS.filter((strategy) => environments[strategy] === 'live');
}

/**
 * Cache live account cash as a shared pool (no equal split).
 * perStrategyBudget entries are set to full cash for each live strategy so
 * older readers that still peek the map see the shared pool, not cash/n.
 */
export function updateLiveBudgetCache({ cashBalance, liveStrategies }) {
  const cash = Number(cashBalance) || 0;
  const max = computeLiveBudgetMax(cash);
  const perStrategyBudget = {};
  for (const strategy of liveStrategies) {
    perStrategyBudget[strategy] = max;
  }

  cache = {
    cashBalance: cash,
    liveStrategies: [...liveStrategies],
    perStrategyBudget,
    updatedAt: new Date().toISOString(),
  };

  return cache;
}

export function clearLiveBudgetCache() {
  cache = {
    cashBalance: null,
    liveStrategies: [],
    perStrategyBudget: {},
    updatedAt: null,
  };
}

export function getLiveBudgetCacheMeta() {
  return {
    cashBalance: cache.cashBalance,
    liveCount: cache.liveStrategies.length,
    liveStrategies: [...cache.liveStrategies],
    updatedAt: cache.updatedAt,
  };
}

/** Live strategy max: 50% of account cash (not cash÷n, not 100% of cash). */
export async function getLiveBudgetTotal(strategy) {
  const liveStrategies = await getLiveStrategyKeys();
  if (!liveStrategies.includes(strategy)) {
    return 0;
  }
  if (cache.perStrategyBudget[strategy] != null) {
    return cache.perStrategyBudget[strategy];
  }
  return computeLiveBudgetMax(cache.cashBalance);
}
