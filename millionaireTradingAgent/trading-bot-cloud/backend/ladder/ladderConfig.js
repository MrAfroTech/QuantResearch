/** Target contracts per ladder entry ("buy in 5's"). */
export const LADDER_TARGET_CONTRACTS = 5;

/**
 * Default initial hard stop when a strategy does not pass its own stop %.
 * 0DTE strategies pass ORB/PREMARKET/EMA_VWAP_STOP_LOSS_PCT (10%); Swing uses STOP_LOSS_PCT (10%).
 */
export const LADDER_INITIAL_STOP_PCT = 0.10;

/** Profit milestones (fraction of entry premium). */
export const LADDER_MILESTONES_PCT = [0.20, 0.40, 0.60, 0.80];

/**
 * Contracts to sell at each milestone, keyed by entry size.
 * Final milestone leg uses close reason profit_target; earlier legs use scale_out_partial.
 */
export const LADDER_SELL_SCHEDULE = {
  5: [2, 1, 1, 1],
  4: [1, 1, 1, 1],
  3: [1, 1, 1],
  2: [1, 1],
  1: [1],
};

export const LADDER_CLOSE_REASON = {
  SCALE_OUT: 'scale_out_partial',
  TRAILING_STOP: 'trailing_stop',
  PROFIT_TARGET: 'profit_target',
  STOP_LOSS: 'stop_loss',
  TIME_STOP: 'time_stop',
};

export function ladderExitPhase(milestonesCompleted) {
  return `LADDER:${milestonesCompleted}`;
}

export function parseLadderMilestonesCompleted(exitPhase) {
  if (!exitPhase || typeof exitPhase !== 'string') return 0;
  if (exitPhase.startsWith('LADDER:')) {
    const n = parseInt(exitPhase.split(':')[1], 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}

export function getLadderSellSchedule(entryContracts) {
  const size = Math.min(LADDER_TARGET_CONTRACTS, Math.max(1, Number(entryContracts) || 1));
  return LADDER_SELL_SCHEDULE[size] || LADDER_SELL_SCHEDULE[1];
}

/**
 * Broker-side stop order type for ladder protection.
 * - stop_market: fills when triggered; may slip on illiquid 0DTE but closes the position.
 * - stop_limit: caps fill price; may not fill on a gap through the limit (poll fallback remains).
 */
export const LADDER_STOP_ORDER_TYPE = {
  STOP_MARKET: 'stop_market',
  STOP_LIMIT: 'stop_limit',
};

/** Default stop_market — capital protection beats price precision on 0DTE gap risk. */
export const LADDER_STOP_ORDER_TYPE_DEFAULT = LADDER_STOP_ORDER_TYPE.STOP_MARKET;

/** Limit offset below stop trigger for stop_limit (fraction of trigger price). */
export const LADDER_STOP_LIMIT_OFFSET_PCT = 0.05;

function parseEnvBool(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function parseEnvList(value) {
  if (!value || !String(value).trim()) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Master switch — off by default until paper validation. */
export function isLadderBrokerStopEnabled() {
  return parseEnvBool(process.env.LADDER_BROKER_STOP_ENABLED, false);
}

/** Comma-separated strategy keys: emavwap, orb, premarket. Default: all 0DTE ladder strategies. */
export function getLadderBrokerStopStrategies() {
  const configured = parseEnvList(process.env.LADDER_BROKER_STOP_STRATEGIES);
  if (configured.length) return configured;
  return ['emavwap', 'orb', 'premarket'];
}

export function isLadderBrokerStopEnabledForStrategy(strategy) {
  if (!isLadderBrokerStopEnabled()) return false;
  const key = String(strategy || '').toLowerCase();
  return getLadderBrokerStopStrategies().includes(key);
}

export function resolveLadderStopOrderType() {
  const raw = String(process.env.LADDER_STOP_ORDER_TYPE || LADDER_STOP_ORDER_TYPE_DEFAULT).toLowerCase();
  if (raw === LADDER_STOP_ORDER_TYPE.STOP_LIMIT) return LADDER_STOP_ORDER_TYPE.STOP_LIMIT;
  return LADDER_STOP_ORDER_TYPE.STOP_MARKET;
}

/** PnL fraction protected by the active stop (negative for initial, positive after ratchet). */
export function computeActiveStopPnlFrac({
  exitPhase,
  ratchetStopFrac,
  initialStopPct = LADDER_INITIAL_STOP_PCT,
}) {
  const milestonesCompleted = parseLadderMilestonesCompleted(exitPhase);
  if (milestonesCompleted === 0) {
    const stopPct = Number(initialStopPct);
    const effective = Number.isFinite(stopPct) && stopPct > 0 ? stopPct : LADDER_INITIAL_STOP_PCT;
    return -effective;
  }
  if (milestonesCompleted > 0) {
    return LADDER_MILESTONES_PCT[milestonesCompleted - 1];
  }
  const ratchet = Number(ratchetStopFrac);
  return Number.isFinite(ratchet) ? ratchet : null;
}

/** Option premium at which the stop should trigger (sell-to-close). */
export function computeStopTriggerPrice(entryPremium, stopPnlFrac) {
  const entry = Number(entryPremium);
  const frac = Number(stopPnlFrac);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(frac)) return null;
  const trigger = entry * (1 + frac);
  return Math.max(0.01, Math.round(trigger * 100) / 100);
}

export function computeStopLimitPrice(triggerPrice, offsetPct = LADDER_STOP_LIMIT_OFFSET_PCT) {
  const trigger = Number(triggerPrice);
  const offset = Number(offsetPct);
  if (!Number.isFinite(trigger) || trigger <= 0) return null;
  const limit = trigger * (1 - (Number.isFinite(offset) ? offset : LADDER_STOP_LIMIT_OFFSET_PCT));
  return Math.max(0.01, Math.round(limit * 100) / 100);
}
