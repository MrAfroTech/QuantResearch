import { computeLivePerStrategyBudget } from '../budget/liveBudget.js';
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

const onlyPremarket = computeLivePerStrategyBudget(10_000, 1);
assert(onlyPremarket === 10_000, 'single live strategy should receive full balance');

const half = computeLivePerStrategyBudget(10_000, 2);
assert(half === 5_000, 'two live strategies should split evenly');

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
      onlyPremarket,
      half,
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
