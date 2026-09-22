import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from '../ladder/ladderConfig.js';

/** 9EMA/VWAP cross (0DTE) — independent from swing, ORB, and premarket. */

export const EMA_VWAP_SYMBOLS = ['SPY', 'QQQ', 'IWM'];

export const EMA_VWAP_BUDGET_MAX = 299.5;
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
 * Primary soft stop (poll + resting broker stop). Flat 1.75% of premium.
 * Hard backstop is EMA_VWAP_HARD_STOP_PCT (2%).
 */
export const EMA_VWAP_STOP_LOSS_PCT = 0.0175;

/** Poll / fill-attribution hard ceiling. Independent of shared LADDER_HARD_STOP_PCT. */
export const EMA_VWAP_HARD_STOP_PCT = 0.02;

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
 * EMA/VWAP-only pre-milestone partial-lock trail.
 * Floor = peak_mfe / EMA_VWAP_PARTIAL_LOCK_TRAIL_DIVISOR (~77% of peak locked in).
 */
export const EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE = 0.03;

/** Peak ÷ this value = trail floor (1.3 ≈ lock ~77% of peak MFE). */
export const EMA_VWAP_PARTIAL_LOCK_TRAIL_DIVISOR = 1.3;

/** Close reason for pre-milestone partial-lock trail exits (EMA/VWAP trade/event logs). */
export const EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON = 'partial_lock_trail';

/**
 * Minimum option entry premium to open a position.
 * Account-wide $0.85 (was unset / no floor).
 */
export const EMA_VWAP_MIN_ENTRY_PREMIUM = 0.85;

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
