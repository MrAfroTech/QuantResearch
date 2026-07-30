/** Premarket range breakout (0DTE) — fully independent from ORB and swing. */

export const PREMARKET_SYMBOLS = ['SPY', 'QQQ', 'IWM'];

export const PREMARKET_BUDGET_MAX = 898.5;
/** Paper concurrent open-position cap (unchanged). */
export const PREMARKET_MAX_POSITIONS = 3;
/**
 * Live concurrent open-position cap — revisit as live balance grows ($60 now → ~$210 pending → more).
 * Kept separate so paper sizing/caps stay untouched.
 */
export const LIVE_MAX_POSITIONS_PREMARKET = 1;

/** Resolve max open positions from strategy environment at decision time. */
export function getPremarketMaxPositions(environment) {
  return String(environment || '').toLowerCase() === 'live'
    ? LIVE_MAX_POSITIONS_PREMARKET
    : PREMARKET_MAX_POSITIONS;
}

/** Profit target and stop loss (fraction of premium). Independently tunable from ORB. */
export const PREMARKET_PROFIT_PCT = 0.175;
export const PREMARKET_STOP_LOSS_PCT = 0.10;

/**
 * Minimum option entry premium to open a position. null = disabled (set before go-live).
 * Diagnostic reference range: ~$0.75–$1.00 — owner sets the live value.
 */
export const PREMARKET_MIN_ENTRY_PREMIUM = null;

/** Premarket range window (ET). */
export const PREMARKET_RANGE_START = { hour: 4, minute: 0 };
export const PREMARKET_RANGE_END = { hour: 9, minute: 30 };

/** Active session for scan/monitor (regular hours through time-stop). */
export const PREMARKET_SESSION_START = { hour: 9, minute: 30 };
export const PREMARKET_TIME_STOP = { hour: 15, minute: 5 };

/**
 * Strong breakout: distance traveled beyond breakout level >= this fraction of premarket range width.
 * UNBACKTESTED — pending tuning after historical review.
 */
export const STRONG_BREAKOUT_DISTANCE_RATIO = 0.5;

export const STRONG_OTM_STEPS = 2;
export const WEAK_OTM_STEPS = 0;

export const PREMARKET_STRIKE_STEP = {
  SPY: 1,
  QQQ: 1,
  IWM: 1,
};
