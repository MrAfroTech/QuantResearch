/** 9EMA/VWAP cross (0DTE) — independent from swing, ORB, and premarket. */

export const EMA_VWAP_SYMBOLS = ['SPY', 'QQQ', 'IWM'];

export const EMA_VWAP_BUDGET_MAX = 299.5;
export const EMA_VWAP_MAX_POSITIONS = 3;

export const EMA_PERIOD = 9;

/** Profit target and stop loss (fraction of premium). Independently tunable. */
export const EMA_VWAP_PROFIT_PCT = 0.175;
export const EMA_VWAP_STOP_LOSS_PCT = 0.10;

/**
 * Minimum option entry premium to open a position. null = disabled (set before go-live).
 * Diagnostic reference range: ~$0.75–$1.00 — owner sets the live value.
 */
export const EMA_VWAP_MIN_ENTRY_PREMIUM = null;

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
