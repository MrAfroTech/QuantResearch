import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from '../ladder/ladderConfig.js';

/** 9EMA/VWAP cross (0DTE) — independent from swing, ORB, and premarket. */

export const EMA_VWAP_SYMBOLS = ['SPY', 'QQQ', 'IWM'];

export const EMA_VWAP_BUDGET_MAX = 299.5;

/**
 * When false, remaining strategy budget cannot reject an EMA/VWAP entry.
 * Sizing stays at EMA_VWAP_MAX_ENTRY_CONTRACTS. The $299.50 figure remains
 * the paper allocation / weekly top-off only.
 */
export const EMA_VWAP_BUDGET_GATE_ENABLED = false;

/** Budget passed to the sizer. With the gate off, one contract is always fundable. */
export function emaVwapEntrySizingBudget(budgetRemaining, premium, feePerContract = 1) {
  const remaining = Number(budgetRemaining);
  const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
  if (EMA_VWAP_BUDGET_GATE_ENABLED) return safeRemaining;
  const oneContract = Number(premium) * 100 + Number(feePerContract);
  const cost = Number.isFinite(oneContract) && oneContract > 0 ? oneContract : 0;
  return Math.max(safeRemaining, cost);
}
/** Spec: max 2 concurrent open positions (was 3 — drift from documented design). */
export const EMA_VWAP_MAX_POSITIONS = 2;

/**
 * SPY / QQQ / IWM treated as one correlation group for same-direction concurrency.
 * Block a new entry if another open EMA/VWAP position already exists in the same
 * CALL/PUT direction on a different ticker in this set.
 */
export const EMA_VWAP_CORRELATION_GROUP = ['SPY', 'QQQ', 'IWM'];

export const CORRELATED_POSITION_BLOCK_REASON = 'correlated_position_block';

export const EMA_PERIOD = 9;

/** Wilder ADX lookback on 5-min session bars. */
export const EMA_VWAP_ADX_PERIOD = 14;

/**
 * Minimum ADX(14) required to allow an EMA/VWAP cross entry.
 * Tunable starting threshold — suppress whipsaw crosses in chop.
 */
export const EMA_VWAP_MIN_ADX = 20;

export const CHOP_FILTER_REJECTED_REASON = 'chop_filter_rejected';

/**
 * STALE / UNUSED for exits — live profit-taking is the first ladder
 * milestone (+20%) closing the full position, plus pre-milestone partial-lock trail.
 * Kept only for analytics suggestionEngine / tradeDiagnosis display; do not wire into monitors.
 */
export const EMA_VWAP_PROFIT_PCT = 0.175;
/**
 * Primary soft stop (poll + resting broker stop). Flat 5.75% of premium.
 * Hard backstop is EMA_VWAP_HARD_STOP_PCT (8.5%).
 */
export const EMA_VWAP_STOP_LOSS_PCT = 0.0575;

/** Poll / fill-attribution hard ceiling. Independent of shared LADDER_HARD_STOP_PCT. */
export const EMA_VWAP_HARD_STOP_PCT = 0.085;

/**
 * EMA/VWAP-only hard entry-size cap. Overrides max-affordable under the 70% live
 * per-trade cap. Premarket, ORB, and EMA/VWAP are each 1-capped; Swing is unaffected.
 *
 * REVERSIBLE OVERRIDE — 2026-09-21.
 * Wired at: emaVwapExecutor.positionSize → ladderPositionSize(..., EMA_VWAP_ENTRY_SIZING)
 *
 * To restore max-affordable for EMA/VWAP: set EMA_VWAP_MAX_ENTRY_CONTRACTS = Infinity
 * (same as ORB_PREMARKET_ENTRY_SIZING).
 */
export const EMA_VWAP_MAX_ENTRY_CONTRACTS = 1;

/** EMA/VWAP entry sizing — 1-contract hard cap + $1 opening commission. */
export const EMA_VWAP_ENTRY_SIZING = Object.freeze({
  maxContracts: EMA_VWAP_MAX_ENTRY_CONTRACTS,
  feePerContract: OPTION_OPENING_COMMISSION_PER_CONTRACT,
});

/**
 * Profit trail arm: first lock rung is +3%, then +5% through +100%,
 * then +10% through +1000% (see ladder/partialLockTrailRungs.js).
 */
export const EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE = 0.03;

/** Unused by the stepped trail; kept so older snapshots still import. */
export const EMA_VWAP_PARTIAL_LOCK_TRAIL_DIVISOR = 1.3;

/** Close reason for pre-milestone partial-lock trail exits (EMA/VWAP trade/event logs). */
export const EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON = 'partial_lock_trail';

/**
 * Minimum option entry premium to open a position.
 * Account-wide floor is $0.65.
 */
export const EMA_VWAP_MIN_ENTRY_PREMIUM = 0.65;

export const EMA_VWAP_SESSION_START = { hour: 9, minute: 30 };
export const EMA_VWAP_TIME_STOP = { hour: 15, minute: 5 };

/**
 * Strong cross: |9EMA − VWAP| at cross >= this fraction of underlying price.
 * UNBACKTESTED — pending tuning after historical review.
 */
export const STRONG_CROSS_GAP_PCT = 0.001;

export const STRONG_OTM_STEPS = 2;
export const WEAK_OTM_STEPS = 0;

export const EMA_VWAP_STRIKE_STEP = {
  SPY: 1,
  QQQ: 1,
  IWM: 1,
};
