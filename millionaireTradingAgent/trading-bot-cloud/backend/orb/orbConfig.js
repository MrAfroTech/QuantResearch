import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from '../ladder/ladderConfig.js';
import { LIVE_PER_TRADE_CAP_FRAC } from '../budget/liveBudget.js';

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

/**
 * STALE / UNUSED for exits — live profit-taking for ORB is the first ladder
 * milestone (+20%) closing the full position, plus pre-milestone partial-lock trail.
 * Kept only for analytics suggestionEngine / tradeDiagnosis display; do not wire into monitors.
 */
export const ORB_PROFIT_PCT = 0.175;
/**
 * ORB primary soft stop (poll + resting broker stop_market). Flat 1% — not IV-scaled.
 */
export const ORB_STOP_LOSS_PCT = 0.01;
/**
 * ORB hard backstop (poll hard_stop + broker-fill attribution). Flat 1.75% — not IV-scaled.
 * Independent of Premarket and of shared LADDER_HARD_STOP_PCT.
 * Soft→hard gap stays 0.75 pts (same spacing as prior 2.25%/3%).
 */
export const ORB_HARD_STOP_PCT = 0.0175;

/**
 * Profit trail arm: first lock rung is +3%, then +5% through +100%,
 * then +10% through +1000% (see ladder/partialLockTrailRungs.js).
 */
export const ORB_PARTIAL_LOCK_ACTIVATION_MFE = 0.03;

/** Unused by the stepped trail; kept so older snapshots still import. */
export const ORB_PARTIAL_LOCK_TRAIL_DIVISOR = 1.3;

/** Close reason for pre-milestone partial-lock trail exits (ORB trade/event logs). */
export const ORB_PARTIAL_LOCK_CLOSE_REASON = 'partial_lock_trail';

/**
 * Minimum option entry premium to open a position.
 */
export const ORB_MIN_ENTRY_PREMIUM = 0.85;

/** Session window for ORB scan/monitor (ET). */
export const ORB_SESSION_START = { hour: 9, minute: 30 };
export const ORB_RANGE_END = { hour: 9, minute: 45 };
export const ORB_TIME_STOP = { hour: 15, minute: 5 };

/**
 * New ORB entries only between these times (ET). Exits/open positions unaffected.
 * Inclusive start, exclusive end → 9:30–10:59:59 ET.
 */
export const ORB_ENTRY_WINDOW_START = { hour: 9, minute: 30 };
export const ORB_ENTRY_WINDOW_END = { hour: 11, minute: 0 };

export const OUTSIDE_ENTRY_WINDOW_REASON = 'outside_entry_window';
export const DAILY_PROFIT_HALT_REASON = 'daily_profit_halt';

/**
 * Live ORB per-trade cap as a fraction of shared live remaining.
 * Kept in sync with LIVE_PER_TRADE_CAP_FRAC (account-wide 80% for live 0DTE).
 */
export const ORB_LIVE_PER_TRADE_CAP_FRAC = LIVE_PER_TRADE_CAP_FRAC;

/**
 * ORB-only hard entry-size cap. Overrides max-affordable under the 80% live
 * per-trade cap. Premarket and EMA/VWAP are separately 1-capped; Swing is unaffected.
 *
 * REVERSIBLE OVERRIDE — 2026-09-18.
 * ORB is the worst-performing strategy (21.8% all-time win rate, negative ROI
 * across every window). Cap every ORB entry at 1 contract regardless of what
 * max-affordable would otherwise allow.
 *
 * Wired at: orbExecutor.positionSize → ladderPositionSize(..., ORB_ENTRY_SIZING)
 *
 * To restore max-affordable for ORB: set ORB_MAX_ENTRY_CONTRACTS = Infinity
 * (same as ORB_PREMARKET_ENTRY_SIZING).
 */
export const ORB_MAX_ENTRY_CONTRACTS = 1;

/**
 * Hard off: no live ORB entries and no paper ORB order attempts.
 * Scan/FSM may still update the dashboard. Set true to restore entries.
 */
export const ORB_ENTRIES_ENABLED = false;
export const ORB_ENTRIES_DISABLED_REASON = 'orb_entries_disabled';

/** ORB entry sizing — 1-contract hard cap + $1 opening commission. */
export const ORB_ENTRY_SIZING = Object.freeze({
  maxContracts: ORB_MAX_ENTRY_CONTRACTS,
  feePerContract: OPTION_OPENING_COMMISSION_PER_CONTRACT,
});

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
