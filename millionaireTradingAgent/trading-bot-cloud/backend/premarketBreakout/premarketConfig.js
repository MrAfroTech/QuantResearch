import { OPTION_OPENING_COMMISSION_PER_CONTRACT } from '../ladder/ladderConfig.js';

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

/**
 * Premarket-only hard entry-size cap. Overrides max-affordable under the live
 * per-trade cap. ORB and EMA/VWAP are separately 1-capped.
 *
 * REVERSIBLE OVERRIDE — 2026-09-22.
 * Wired at: premarketExecutor.positionSize → ladderPositionSize(..., PREMARKET_ENTRY_SIZING)
 *
 * To restore max-affordable for Premarket: set PREMARKET_MAX_ENTRY_CONTRACTS = Infinity
 * (same as ORB_PREMARKET_ENTRY_SIZING).
 */
export const PREMARKET_MAX_ENTRY_CONTRACTS = 1;

/** Premarket entry sizing — 1-contract hard cap + $1 opening commission. */
export const PREMARKET_ENTRY_SIZING = Object.freeze({
  maxContracts: PREMARKET_MAX_ENTRY_CONTRACTS,
  feePerContract: OPTION_OPENING_COMMISSION_PER_CONTRACT,
});

/**
 * STALE / UNUSED for exits — live profit-taking for Premarket is the first ladder
 * milestone (+20%) closing the full position, plus pre-milestone partial-lock trail.
 * Kept only for analytics suggestionEngine / tradeDiagnosis display; do not wire into monitors.
 */
export const PREMARKET_PROFIT_PCT = 0.175;
/**
 * Primary soft stop (fraction of premium) — poll stop_loss + resting broker stop_market.
 * Flat 1% — not IV-scaled. Hard backstop is PREMARKET_HARD_STOP_TRIGGER.
 */
export const PREMARKET_STOP_LOSS_PCT = 0.01;

/**
 * Premarket-only pre-milestone partial-lock trail.
 * Activates only while milestonesCompleted === 0 (before first +20% ladder rung).
 * Floor = peak_mfe / PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR (~77% of peak locked in).
 * TUNABLE — chosen below the +6.9%–+9.9% peaks of the four real give-back trades
 * so normal noise does not arm the trail, with room before the first milestone.
 */
export const PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE = 0.03;

/** Peak ÷ this value = trail floor (1.3 ≈ lock ~77% of peak MFE). */
export const PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR = 1.3;

/** Close reason for pre-milestone partial-lock trail exits (Premarket trade/event logs). */
export const PREMARKET_PARTIAL_LOCK_CLOSE_REASON = 'partial_lock_trail';

/**
 * Premarket hard backstop (fraction of premium) — poll hard_stop + fill-attribution ceiling.
 * Flat 1.75% — not IV-scaled. Soft is primary on the resting broker order.
 * Soft→hard gap stays 0.75 pts (same spacing as prior 2.25%/3%).
 */
export const PREMARKET_HARD_STOP_TRIGGER = 0.0175;

/**
 * Legacy / display name for Premarket's hard-stop level. Exit path uses
 * PREMARKET_HARD_STOP_TRIGGER. Kept so analytics denylists and older metadata
 * keys remain stable — do not wire this into the live hard-stop check.
 */
export const PREMARKET_HARD_STOP_PCT = PREMARKET_HARD_STOP_TRIGGER;

/**
 * Minimum option entry premium (ask / entry quote) to open a position.
 * Raised account-wide to $0.85 (was $0.30).
 */
export const PREMARKET_MIN_ENTRY_PREMIUM = 0.85;

/** premarket_event_log event_type when entry ask/premium is below PREMARKET_MIN_ENTRY_PREMIUM. */
export const ENTRY_BELOW_PREMIUM_FLOOR_REASON = 'entry_below_premium_floor';

/**
 * Reject entry when (ask - bid) / mid exceeds this fraction of mid premium.
 * Tunable starting threshold — not a locked edge.
 */
export const PREMARKET_MAX_SPREAD_PCT = 0.15;

export const SPREAD_TOO_WIDE_REJECTED_REASON = 'spread_too_wide_rejected';

/**
 * Baseline IV (decimal) — retained for metadata / historical logs only.
 * Soft stop is no longer IV-scaled (always flat PREMARKET_STOP_LOSS_PCT).
 */
export const PREMARKET_BASELINE_IV = 0.25;

/**
 * Cap retained for API compatibility; unused while soft stop is flat.
 */
export const PREMARKET_IV_STOP_MULT_CAP = 2;

/**
 * Premarket stop levels for poll + broker.
 * Soft is ALWAYS the flat PREMARKET_STOP_LOSS_PCT (1%) — IV scaling removed.
 * Hard is ALWAYS PREMARKET_HARD_STOP_TRIGGER (1.75%).
 * softStopBase override still honored when Tier-1 runtime params pass an explicit base
 * (still not IV-multiplied).
 */
export function computePremarketIvStopPcts(entryIv, softStopBase = PREMARKET_STOP_LOSS_PCT) {
  const softBase =
    Number.isFinite(Number(softStopBase)) && Number(softStopBase) > 0
      ? Number(softStopBase)
      : PREMARKET_STOP_LOSS_PCT;
  return {
    softStopPct: softBase,
    hardStopPct: PREMARKET_HARD_STOP_TRIGGER,
    ivMult: 1,
  };
}

/** Premarket range window (ET). */
export const PREMARKET_RANGE_START = { hour: 4, minute: 0 };
export const PREMARKET_RANGE_END = { hour: 9, minute: 30 };

/** Active session for scan/monitor (regular hours through time-stop). */
export const PREMARKET_SESSION_START = { hour: 9, minute: 30 };
export const PREMARKET_TIME_STOP = { hour: 15, minute: 5 };

/**
 * Premarket entries allowed for the full active session (market open → time-stop).
 * No separate start-of-window gate — only PREMARKET_TIME_STOP bounds new entries.
 * Reject outside session (`outside_entry_window`). Exits/open positions unaffected.
 */
export const OUTSIDE_ENTRY_WINDOW_REASON = 'outside_entry_window';

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
