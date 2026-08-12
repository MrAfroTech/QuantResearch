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
 * Minimum option entry premium (ask / entry quote) to open a position.
 * PROVISIONAL — derived from n=3 real trades under the current 4.25% stop config;
 * not validated at scale. Stop-market fills slip by a roughly constant dollar amount
 * (spread/tick), so cheap premium turns fixed $ slippage into outsized % losses
 * (e.g. 2026-08-12 IWM PUT id 58 @ $0.485 → -$0.079 / -20.62% vs 4.25% trigger).
 */
export const PREMARKET_MIN_ENTRY_PREMIUM = 0.6;

/** premarket_event_log event_type when entry ask/premium is below PREMARKET_MIN_ENTRY_PREMIUM. */
export const ENTRY_BELOW_PREMIUM_FLOOR_REASON = 'entry_below_premium_floor';

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
