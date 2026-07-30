import { getLiveAccountBalances, hasLiveCredentialsConfigured } from '../brokerageConnector.js';
import {
  clearLiveBudgetCache,
  getLiveStrategyKeys,
  updateLiveBudgetCache,
} from './liveBudget.js';
import { syncLiveDailyLossLimit } from './liveDailyLossLimit.js';
import { etDateKey } from '../orb/tradierTimesales.js';

export async function refreshLiveRiskState() {
  const liveStrategies = await getLiveStrategyKeys();
  if (liveStrategies.length === 0) {
    clearLiveBudgetCache();
    return { skipped: true, reason: 'no_live_strategies' };
  }

  if (!hasLiveCredentialsConfigured()) {
    console.warn(
      '[LiveRisk] Live strategy environment enabled but live Tastytrade credentials are not configured'
    );
    return { skipped: true, reason: 'live_credentials_missing' };
  }

  try {
    const balances = await getLiveAccountBalances();
    const budgetCache = updateLiveBudgetCache({
      cashBalance: balances.cashBalance,
      liveStrategies,
    });

    const lossState = await syncLiveDailyLossLimit({
      baselineBalance: balances.cashBalance,
      tradeDate: etDateKey(),
      liveStrategies,
    });

    return {
      skipped: false,
      cashBalance: balances.cashBalance,
      netLiquidatingValue: balances.netLiquidatingValue,
      liveStrategies,
      perStrategyBudget: budgetCache.perStrategyBudget,
      dailyLoss: lossState,
    };
  } catch (err) {
    console.error('[LiveRisk] refresh failed:', err.message);
    return { skipped: true, reason: 'refresh_error', error: err.message };
  }
}
