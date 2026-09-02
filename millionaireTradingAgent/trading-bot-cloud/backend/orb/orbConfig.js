/** 0DTE ORB strategy constants — independent from swing bot. */

export const ORB_SYMBOLS = ['SPY', 'QQQ', 'IWM'];

export const ORB_BUDGET_MAX = 299.5;
/** Paper concurrent open-position cap (unchanged). */
export const ORB_MAX_POSITIONS = 3;
/**
 * Live concurrent open-position cap — revisit as live balance grows ($60 now → ~$210 pending → more).
 * Kept separate so paper sizing/caps stay untouched.
 */
export const LIVE_MAX_POSITIONS_ORB = 1;

/** Resolve max open positions from strategy environment at decision time. */
export function getOrbMaxPositions(environment) {
  return String(environment || '').toLowerCase() === 'live'
    ? LIVE_MAX_POSITIONS_ORB
    : ORB_MAX_POSITIONS;
}

/** Profit target and stop loss (fraction of premium). Independently tunable. */
export const ORB_PROFIT_PCT = 0.175;
export const ORB_STOP_LOSS_PCT = 0.01;  // 1% soft stop
export const ORB_HARD_STOP_PCT = 0.0175; // 1.75% hard stop (poll-based trigger)

/**
 * Minimum option entry premium to open a position. null = disabled (set before go-live).
 * Diagnostic reference range: ~$0.75–$1.00 — owner sets the live value.
 */
export const ORB_MIN_ENTRY_PREMIUM = null;

/** Session window for ORB logic (ET). */
export const ORB_SESSION_START = { hour: 9, minute: 30 };
export const ORB_RANGE_END = { hour: 9, minute: 45 };
export const ORB_TIME_STOP = { hour: 15, minute: 5 };

/**
 * Strong breakout: breakout candle body >= this fraction of opening range width.
 * UNBACKTESTED — pending tuning after historical review.
 */
export const STRONG_BREAKOUT_BODY_RATIO = 0.5;

/** OTM strike offsets (number of strike steps from ATM). */
export const STRONG_OTM_STEPS = 2;
export const WEAK_OTM_STEPS = 0;

export const ORB_STRIKE_STEP = {
  SPY: 1,
  QQQ: 1,
  IWM: 1,
};
