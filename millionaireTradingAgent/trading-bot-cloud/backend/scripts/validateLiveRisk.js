import {
  computeLivePerStrategyBudget,
  computeLiveSharedRemaining,
  applyLivePerTradeCap,
  resolveLiveSizingBudget,
  LIVE_PER_TRADE_CAP_FRAC,
  livePerTradeCapFracFor,
} from '../budget/liveBudget.js';
import { ORB_LIVE_PER_TRADE_CAP_FRAC } from '../orb/orbConfig.js';
import {
  computeDailyPnl,
  shouldTriggerDailyLossLimit,
  computeUnrealizedPnl,
  LIVE_DAILY_LOSS_LIMIT_PCT,
} from '../budget/liveDailyLossLimit.js';
import { evaluateLiveRiskRefreshForEntry } from '../budget/liveEntryGate.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Live allocation max is 70% of cash per live strategy (not cash÷n).
const onlyPremarket = computeLivePerStrategyBudget(10_000, 1);
assert(onlyPremarket === 7_000, 'live max: single strategy is 70% of cash');

const bothLive = computeLivePerStrategyBudget(10_000, 2);
assert(bothLive === 7_000, 'live max: two strategies each get 70% of cash, not 50/50');

// Live FCFS shared pool + provisional per-trade cap
const shared = computeLiveSharedRemaining(140, 40);
assert(shared === 100, 'shared remaining = cash − all live deployed');

const capped = applyLivePerTradeCap(shared);
assert(LIVE_PER_TRADE_CAP_FRAC === 0.8, 'account-wide live per-trade cap is 80%');
assert(capped === 80, 'default per-trade cap clamps to 80% of shared remaining');
assert(ORB_LIVE_PER_TRADE_CAP_FRAC === 0.8, 'ORB live per-trade cap is 80%');
assert(livePerTradeCapFracFor('orb') === 0.8, 'livePerTradeCapFracFor(orb) is 80%');
assert(livePerTradeCapFracFor('premarket') === 0.8, 'Premarket live per-trade cap is 80%');
assert(livePerTradeCapFracFor('emavwap') === 0.8, 'EMA/VWAP live per-trade cap is 80%');

const orbSizing = resolveLiveSizingBudget({
  cashBalance: 140,
  deployedByStrategy: { premarket: 40, orb: 0 },
  liveStrategies: ['orb', 'premarket'],
  requestingStrategy: 'orb',
  perTradeCapFrac: livePerTradeCapFracFor('orb'),
});
assert(orbSizing === 80, 'ORB live remaining reflects Premarket deployed + 80% cap');
assert(orbSizing !== 50, 'must not return stale equal-split (140/2)');

const premarketSizing = resolveLiveSizingBudget({
  cashBalance: 140,
  deployedByStrategy: { premarket: 40, orb: 0 },
  liveStrategies: ['orb', 'premarket'],
  requestingStrategy: 'premarket',
  perTradeCapFrac: livePerTradeCapFracFor('premarket'),
});
assert(premarketSizing === 80, 'Premarket uses 80% per-trade cap');

const dailyPnl = computeDailyPnl({ realizedToday: -500, unrealizedOpen: -400 });
assert(dailyPnl === -900, 'daily P&L should sum realized and unrealized');

assert(
  shouldTriggerDailyLossLimit({ baselineBalance: 10_000, dailyPnl: -3_000 }),
  '30% loss should trip breaker'
);
assert(
  !shouldTriggerDailyLossLimit({ baselineBalance: 10_000, dailyPnl: -2_999 }),
  '29.99% loss should not trip breaker'
);

const unrealized = computeUnrealizedPnl(
  { entry_premium: 1.0, quantity: 2 },
  0.75
);
assert(unrealized === -50, 'unrealized P&L should be (0.75-1.0)*100*2');

// Fail-closed: credential / refresh failures must block live entries
const blockedMissingCreds = evaluateLiveRiskRefreshForEntry({
  skipped: true,
  reason: 'live_credentials_missing',
});
assert(
  blockedMissingCreds.allowed === false &&
    blockedMissingCreds.reason === 'live_risk_state_unknown',
  'missing live credentials must fail-closed'
);

const blockedRefreshError = evaluateLiveRiskRefreshForEntry({
  skipped: true,
  reason: 'refresh_error',
  error: 'Tastytrade /accounts/.../balances failed: 401',
});
assert(
  blockedRefreshError.allowed === false &&
    blockedRefreshError.reason === 'live_risk_state_unknown',
  'balance refresh error must fail-closed'
);

const blockedNoRiskRow = evaluateLiveRiskRefreshForEntry({
  skipped: false,
  cashBalance: 10_000,
  dailyLoss: { skipped: true, reason: 'invalid_baseline' },
});
assert(
  blockedNoRiskRow.allowed === false &&
    blockedNoRiskRow.reason === 'live_risk_state_unknown',
  'unavailable daily-loss status must fail-closed'
);

const blockedTripped = evaluateLiveRiskRefreshForEntry({
  skipped: false,
  cashBalance: 10_000,
  dailyLoss: { active: true, skipped: false },
});
assert(
  blockedTripped.allowed === false &&
    blockedTripped.reason === 'daily_loss_limit_reached',
  'active breaker must block'
);

const allowedHealthy = evaluateLiveRiskRefreshForEntry({
  skipped: false,
  cashBalance: 10_000,
  dailyLoss: { active: false, skipped: false },
});
assert(allowedHealthy.allowed === true, 'healthy refresh must allow');

console.log('live risk validation passed');
console.log(
  JSON.stringify(
    {
      sharedFCFS: {
        shared,
        capped,
        orbSizing,
        premarketSizing,
        perTradeCapFracDefault: LIVE_PER_TRADE_CAP_FRAC,
        orbPerTradeCapFrac: livePerTradeCapFracFor('orb'),
      },
      liveBudgetMax: { onlyPremarket, bothLive },
      dailyPnl,
      lossLimitPct: LIVE_DAILY_LOSS_LIMIT_PCT,
      unrealized,
      failClosed: {
        blockedMissingCreds,
        blockedRefreshError,
        blockedNoRiskRow,
        blockedTripped,
        allowedHealthy,
      },
    },
    null,
    2
  )
);
