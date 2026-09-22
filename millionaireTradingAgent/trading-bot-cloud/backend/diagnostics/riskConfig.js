import {
  LIVE_PER_TRADE_CAP_FRAC,
  LIVE_PER_TRADE_CAP_FRAC_BY_STRATEGY,
  livePerTradeCapFracFor,
} from '../budget/liveBudget.js';
import {
  ORB_ENTRIES_ENABLED,
  ORB_ENTRY_SIZING,
  ORB_HARD_STOP_PCT,
  ORB_LIVE_PER_TRADE_CAP_FRAC,
  ORB_MAX_ENTRY_CONTRACTS,
  ORB_MIN_ENTRY_PREMIUM,
  ORB_PARTIAL_LOCK_ACTIVATION_MFE,
  ORB_PARTIAL_LOCK_TRAIL_DIVISOR,
  ORB_STOP_LOSS_PCT,
} from '../orb/orbConfig.js';
import {
  PREMARKET_ENTRY_SIZING,
  PREMARKET_HARD_STOP_TRIGGER,
  PREMARKET_MAX_ENTRY_CONTRACTS,
  PREMARKET_MIN_ENTRY_PREMIUM,
  PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
  PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR,
  PREMARKET_STOP_LOSS_PCT,
} from '../premarketBreakout/premarketConfig.js';
import {
  EMA_VWAP_ENTRY_SIZING,
  EMA_VWAP_HARD_STOP_PCT,
  EMA_VWAP_MAX_ENTRY_CONTRACTS,
  EMA_VWAP_MIN_ENTRY_PREMIUM,
  EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE,
  EMA_VWAP_PARTIAL_LOCK_TRAIL_DIVISOR,
  EMA_VWAP_STOP_LOSS_PCT,
} from '../emaVwapCross/emaVwapConfig.js';

function strategyRisk({
  perTradeCapFrac,
  maxEntryContracts,
  entrySizing,
  premiumFloor,
  softStopPct,
  hardStopPct,
  partialLockActivationMfe,
  partialLockTrailDivisor,
}) {
  return {
    per_trade_cap_frac: perTradeCapFrac,
    max_entry_contracts: maxEntryContracts,
    entry_sizing: {
      maxContracts: entrySizing.maxContracts,
      feePerContract: entrySizing.feePerContract,
    },
    premium_floor: premiumFloor,
    soft_stop_pct: softStopPct,
    hard_stop_pct: hardStopPct,
    partial_lock: {
      activation_mfe: partialLockActivationMfe,
      trail_divisor: partialLockTrailDivisor,
    },
  };
}

/**
 * Snapshot of module-scope risk constants already loaded by this process.
 * Imports the same bindings executors/configs use — not file re-reads, not literals.
 */
export function buildRiskConfigSnapshot() {
  return {
    generated_at: new Date().toISOString(),
    source: 'in_memory_module_exports',
    account: {
      live_per_trade_cap_frac: LIVE_PER_TRADE_CAP_FRAC,
      live_per_trade_cap_frac_by_strategy: { ...LIVE_PER_TRADE_CAP_FRAC_BY_STRATEGY },
    },
    orb_entries_enabled: ORB_ENTRIES_ENABLED,
    strategies: {
      orb: {
        ...strategyRisk({
          perTradeCapFrac: livePerTradeCapFracFor('orb'),
          maxEntryContracts: ORB_MAX_ENTRY_CONTRACTS,
          entrySizing: ORB_ENTRY_SIZING,
          premiumFloor: ORB_MIN_ENTRY_PREMIUM,
          softStopPct: ORB_STOP_LOSS_PCT,
          hardStopPct: ORB_HARD_STOP_PCT,
          partialLockActivationMfe: ORB_PARTIAL_LOCK_ACTIVATION_MFE,
          partialLockTrailDivisor: ORB_PARTIAL_LOCK_TRAIL_DIVISOR,
        }),
        orb_live_per_trade_cap_frac: ORB_LIVE_PER_TRADE_CAP_FRAC,
      },
      premarket: strategyRisk({
        perTradeCapFrac: livePerTradeCapFracFor('premarket'),
        maxEntryContracts: PREMARKET_MAX_ENTRY_CONTRACTS,
        entrySizing: PREMARKET_ENTRY_SIZING,
        premiumFloor: PREMARKET_MIN_ENTRY_PREMIUM,
        softStopPct: PREMARKET_STOP_LOSS_PCT,
        hardStopPct: PREMARKET_HARD_STOP_TRIGGER,
        partialLockActivationMfe: PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
        partialLockTrailDivisor: PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR,
      }),
      emavwap: strategyRisk({
        perTradeCapFrac: livePerTradeCapFracFor('emavwap'),
        maxEntryContracts: EMA_VWAP_MAX_ENTRY_CONTRACTS,
        entrySizing: EMA_VWAP_ENTRY_SIZING,
        premiumFloor: EMA_VWAP_MIN_ENTRY_PREMIUM,
        softStopPct: EMA_VWAP_STOP_LOSS_PCT,
        hardStopPct: EMA_VWAP_HARD_STOP_PCT,
        partialLockActivationMfe: EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE,
        partialLockTrailDivisor: EMA_VWAP_PARTIAL_LOCK_TRAIL_DIVISOR,
      }),
    },
  };
}
