import { getAllStrategyEnvironments } from '../strategyEnvironment.js';

const LIVE_STRATEGY_KEYS = ['swing', 'orb', 'premarket', 'emavwap'];

/** Each live strategy max is 70% of account cash (not an equal split). */
export const LIVE_BUDGET_MAX_FRAC = 0.7;

let cache = {
  cashBalance: null,
  liveStrategies: [],
  perStrategyBudget: {},
  updatedAt: null,
};

export function computeLiveBudgetMax(cashBalance) {
  const cash = Number(cashBalance);
  if (!Number.isFinite(cash) || cash <= 0) return 0;
  return cash * LIVE_BUDGET_MAX_FRAC;
}

export function computeLivePerStrategyBudget(cashBalance, liveStrategyCount) {
  if (!liveStrategyCount || liveStrategyCount <= 0) return 0;
  return computeLiveBudgetMax(cashBalance);
}

export async function getLiveStrategyKeys() {
  const environments = await getAllStrategyEnvironments();
  return LIVE_STRATEGY_KEYS.filter((strategy) => environments[strategy] === 'live');
}

export function updateLiveBudgetCache({ cashBalance, liveStrategies }) {
  const perStrategyBudget = {};
  const perStrategy = computeLiveBudgetMax(cashBalance);
  for (const strategy of liveStrategies) {
    perStrategyBudget[strategy] = perStrategy;
  }

  cache = {
    cashBalance: Number(cashBalance) || 0,
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
