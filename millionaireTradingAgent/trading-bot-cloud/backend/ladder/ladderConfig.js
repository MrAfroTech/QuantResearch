/**
 * Target contracts per ladder entry (Swing).
 * Cap at 3 so 20/40/60% ladder rungs can actually scale out; 1-contract entries
 * collapse the schedule to a single rung. Buy min(3, affordable); never exceed 3.
 * Premarket, ORB, and EMA/VWAP are separately hard-capped at 1 contract in their configs.
 */
export const LADDER_TARGET_CONTRACTS = 3;

/**
 * Tastytrade equity-options opening commission per contract.
 * Existing budget remaining is premium×100 only — it does not include fees.
 * ORB / Premarket affordability adds this so we never round into a fee overshoot.
 * Closing commission is $0.
 */
export const OPTION_OPENING_COMMISSION_PER_CONTRACT = 1;

/**
 * Default primary (target) stop when a strategy does not pass its own stop %.
 * Callers pass their strategy STOP_LOSS_PCT (ORB/EMA/Swing = 6.5%; Premarket may differ).
 * This is a poll-based *target* — fills can overshoot; see LADDER_HARD_STOP_PCT.
 */
export const LADDER_INITIAL_STOP_PCT = 0.065;

/**
 * Hard secondary loss ceiling (fraction of entry premium).
 * Always evaluated on the poll path — even when broker-side stops are active
 * and the primary 6.5% poll stop is skipped. Does not replace the primary stop.
 */
export const LADDER_HARD_STOP_PCT = 0.10;

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
  HARD_STOP: 'hard_stop',
  TIME_STOP: 'time_stop',
  /** Unfilled discretionary exit that was flattened at the 15:05 ET time-stop. */
  FORCED_CLOSE_EOD: 'forced_close_eod',
};

/**
 * Fill wait for a submitted STC already lives in closeOptionOrder (15s).
 * If a discretionary limit still has not filled, restore the protective stop
 * and skip retrying that profit-take for this cooldown so we do not flap
 * cancel-stop → limit → cancel-limit every minute.
 */
export const LADDER_UNFILLED_EXIT_COOLDOWN_MS = 60_000;

/** Marketable 0DTE flatten when a risk/time-stop limit does not print. */
export const LADDER_FORCED_FLATTEN_PRICE = 0.01;

/**
 * Poll-path hard-stop close: first STC is a limit at trigger minus this buffer,
 * not at the already-slipped mark. $0.01 is one equity-option tick — enough to
 * be a tick through without reopening the $2–4 (2–4¢) slip seen on marketable
 * mark/bid closes. Floor remains $0.01.
 */
export const HARD_STOP_LIMIT_BUFFER = 0.01;

/**
 * How long to wait for the trigger-priced limit before cancelling and escalating
 * to the $0.01 flatten. 3s is a few 0DTE quote updates — long enough for a
 * bounce print, short enough not to sit in a collapsing bid the way the 15s
 * fill-wait did.
 */
export const HARD_STOP_LIMIT_WAIT_MS = 3_000;
export const HARD_STOP_LIMIT_POLL_MS = 500;

const RISK_EXIT_REASONS = new Set([
  LADDER_CLOSE_REASON.STOP_LOSS,
  LADDER_CLOSE_REASON.HARD_STOP,
  LADDER_CLOSE_REASON.TIME_STOP,
  LADDER_CLOSE_REASON.TRAILING_STOP,
  LADDER_CLOSE_REASON.FORCED_CLOSE_EOD,
]);

export function isRiskExitReason(reason) {
  return RISK_EXIT_REASONS.has(String(reason || ''));
}

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
  const n = Math.max(1, Math.floor(Number(entryContracts) || 1));
  // Prefer exact schedule (keeps legacy 4/5-contract open positions correct after
  // target was lowered to 3). Unknown sizes clamp to current target.
  if (LADDER_SELL_SCHEDULE[n]) return LADDER_SELL_SCHEDULE[n];
  const size = Math.min(LADDER_TARGET_CONTRACTS, n);
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

/**
 * Master switch for broker-side ladder stops.
 * Single, environment-agnostic flag — paper and live must stay identical.
 * Default ON so an unset/missing env var does not silently downgrade live to poll-only.
 * `environment` on place/cancel/check only selects which broker account receives the order;
 * it must never gate whether stops are enabled.
 */
export function isLadderBrokerStopEnabled() {
  return parseEnvBool(process.env.LADDER_BROKER_STOP_ENABLED, true);
}

/** Comma-separated strategy keys: emavwap, orb, premarket. Default: all 0DTE ladder strategies. */
export function getLadderBrokerStopStrategies() {
  const configured = parseEnvList(process.env.LADDER_BROKER_STOP_STRATEGIES);
  if (configured.length) return configured;
  return ['emavwap', 'orb', 'premarket'];
}

/** Strategy allowlist only — never branches on paper vs live. */
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

/** Hard-stop trigger from entry and the hard-stop fraction (e.g. 0.0175). */
export function computeHardStopTriggerPrice(entryPremium, hardStopPct) {
  const pct = Number(hardStopPct);
  const effective = Number.isFinite(pct) && pct > 0 ? pct : LADDER_HARD_STOP_PCT;
  return computeStopTriggerPrice(entryPremium, -effective);
}

/**
 * Limit price for the poll hard-stop STC: trigger minus HARD_STOP_LIMIT_BUFFER.
 * Sell-to-close fills at this price or better; one tick of room, then escalate.
 */
export function computeHardStopCloseLimitPrice(
  triggerPrice,
  buffer = HARD_STOP_LIMIT_BUFFER
) {
  const trigger = Number(triggerPrice);
  const off = Number(buffer);
  if (!Number.isFinite(trigger) || trigger <= 0) return null;
  const buf = Number.isFinite(off) && off >= 0 ? off : HARD_STOP_LIMIT_BUFFER;
  return Math.max(0.01, Math.round((trigger - buf) * 100) / 100);
}

export function computeStopLimitPrice(triggerPrice, offsetPct = LADDER_STOP_LIMIT_OFFSET_PCT) {
  const trigger = Number(triggerPrice);
  const offset = Number(offsetPct);
  if (!Number.isFinite(trigger) || trigger <= 0) return null;
  const limit = trigger * (1 - (Number.isFinite(offset) ? offset : LADDER_STOP_LIMIT_OFFSET_PCT));
  return Math.max(0.01, Math.round(limit * 100) / 100);
}
