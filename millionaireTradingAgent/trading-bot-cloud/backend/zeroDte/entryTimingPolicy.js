/**
 * A/B entry-timing policy for 0DTE strategies.
 *
 * control — existing timing (ORB/Premarket: later hold bar; EMA/VWAP: cross bar).
 * bar0    — permit entry on the breakout/cross bar itself. Does not wait for a
 *           later hold/quiet bar. Does not bypass chop or any other remaining gate.
 *
 * Assignment is always control per qualifying setup and is sticky on the FSM so
 * catch-up replay cannot flip the arm. Order placement / OTO / stops are not
 * branched here. The bar0 arm remains callable via the test hook only.
 */

export const CONTROL_ENTRY_POLICY = 'control';
export const BAR0_ENTRY_POLICY = 'bar0';
export const ENTRY_POLICY_ASSIGNED_REASON = 'entry_policy_assigned';

const POLICIES = new Set([CONTROL_ENTRY_POLICY, BAR0_ENTRY_POLICY]);

let assignImpl = defaultAssign;

function defaultAssign() {
  return CONTROL_ENTRY_POLICY;
}

/** Map a 0/1 bit onto an arm. 0 = control, 1 = bar0. */
export function pickEntryPolicy(randomBit) {
  return Number(randomBit) === 1 ? BAR0_ENTRY_POLICY : CONTROL_ENTRY_POLICY;
}

export function assignEntryPolicy() {
  return assignImpl();
}

/** Test hook. Pass null to restore the default control assigner. */
export function setEntryPolicyAssigner(fn) {
  assignImpl = typeof fn === 'function' ? fn : defaultAssign;
}

export function isBar0Policy(policy) {
  return policy === BAR0_ENTRY_POLICY;
}

/** Legacy in-flight FSMs with no policy field keep today's control timing. */
export function resolveEntryPolicy(policy) {
  return policy === BAR0_ENTRY_POLICY ? BAR0_ENTRY_POLICY : CONTROL_ENTRY_POLICY;
}

export function isEntryPolicyAssignedEvent(type) {
  return type === ENTRY_POLICY_ASSIGNED_REASON;
}

export function buildPolicyAssignedEvent({
  strategy,
  symbol,
  tradeDate,
  direction,
  breakoutLevel,
  breakoutBarTime,
  policy,
  bar = null,
}) {
  const entry_policy = POLICIES.has(policy) ? policy : CONTROL_ENTRY_POLICY;
  return {
    type: ENTRY_POLICY_ASSIGNED_REASON,
    strategy,
    symbol,
    tradeDate: tradeDate ?? null,
    direction,
    breakout_level: breakoutLevel ?? null,
    breakout_bar_time: breakoutBarTime ?? null,
    entry_policy,
    bar,
  };
}
