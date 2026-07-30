/** Number of contracts per full pyramid entry (equal legs). */
export const PYRAMID_CONTRACTS = 3;

/** Entry sizing tier — recorded on positions/trade_log for reporting. */
export const PYRAMID_TIER = {
  FULL: 'full',
  PARTIAL: 'partial',
  LEGACY: 'legacy',
};

/**
 * Trailing-stop pullback from peak favorable P&L (fraction of entry premium).
 * Starting hypotheses — revisit after real TRAILING-phase trade data exists.
 */
export const SWING_TRAILING_PULLBACK_PCT = 0.15;        // 15%
export const ORB_TRAILING_PULLBACK_PCT = 0.20;           // 20%
export const PREMARKET_TRAILING_PULLBACK_PCT = 0.20;     // 20%
export const EMA_VWAP_TRAILING_PULLBACK_PCT = 0.25;      // 25%

export const PYRAMID_EXIT_PHASE = {
  INITIAL: 'INITIAL',
  TRAILING: 'TRAILING',
};

export const PYRAMID_CLOSE_REASON = {
  SCALE_OUT: 'scale_out_partial',
  TRAILING_STOP: 'trailing_stop',
};
