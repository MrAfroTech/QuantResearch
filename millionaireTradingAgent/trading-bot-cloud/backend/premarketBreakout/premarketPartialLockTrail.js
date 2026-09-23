/**
 * Premarket profit trail: arm at +3%, then ratchet the lock floor up in +5%
 * steps through +100% and +10% steps through +1000%. Runs after the shared
 * ladder poll so hard/soft stops still win on the way down. Does not stop at
 * the old +20% profit-target flatten.
 */

import {
  PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
  PREMARKET_PARTIAL_LOCK_CLOSE_REASON,
} from './premarketConfig.js';
import { computeStopTriggerPrice } from '../ladder/ladderConfig.js';
import { evaluateSteppedPartialLockTrail } from '../ladder/partialLockTrailRungs.js';

/**
 * Pure decision — no I/O.
 * @returns {{ action: 'hold' } | { action: 'close_all', reason: string, peakMfe: number, trailFloor: number, pnlFrac: number }}
 */
export function evaluatePremarketPartialLockTrail({
  pnlFrac,
  mfeFrac,
  activationMfe = PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
  hardStopPct = null,
}) {
  return evaluateSteppedPartialLockTrail({
    pnlFrac,
    mfeFrac,
    hardStopPct,
    closeReason: PREMARKET_PARTIAL_LOCK_CLOSE_REASON,
    activationMfe,
  });
}

/**
 * Whether the resting broker stop should be raised to the partial-lock floor.
 * Long option: more protective = higher trigger. Never lowers an existing stop.
 */
export function shouldRaisePartialLockBrokerStop(position, trailFloor) {
  const desiredPnlFrac = Number(trailFloor);
  const desiredTrigger = computeStopTriggerPrice(position?.entry_premium, desiredPnlFrac);
  const currentTrigger = Number(position?.broker_stop_trigger_price);
  const hasOrder = Boolean(position?.broker_stop_order_id);

  if (desiredTrigger == null) {
    return {
      raise: false,
      desiredTrigger: null,
      desiredPnlFrac: Number.isFinite(desiredPnlFrac) ? desiredPnlFrac : null,
      currentTrigger: Number.isFinite(currentTrigger) ? currentTrigger : null,
    };
  }

  if (!hasOrder || !Number.isFinite(currentTrigger)) {
    return {
      raise: true,
      desiredTrigger,
      desiredPnlFrac,
      currentTrigger: Number.isFinite(currentTrigger) ? currentTrigger : null,
    };
  }

  return {
    raise: desiredTrigger > currentTrigger,
    desiredTrigger,
    desiredPnlFrac,
    currentTrigger,
  };
}

/**
 * Broker-fill attribution for a profit-trail resting stop.
 * Hard-stop fills stay hard_stop. Any positive stop floor is partial_lock_trail.
 */
export function resolvePremarketPartialLockStopFillReason({
  position,
  defaultReason,
}) {
  if (defaultReason === 'hard_stop') return defaultReason;
  const stopFrac = Number(position?.broker_stop_pnl_frac);
  if (Number.isFinite(stopFrac) && stopFrac > 0) {
    return PREMARKET_PARTIAL_LOCK_CLOSE_REASON;
  }
  return defaultReason;
}
