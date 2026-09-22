/**
 * Premarket-only pre-milestone partial-lock trail.
 *
 * Invoked only while milestonesCompleted === 0, AFTER the shared ladder poll
 * (so hard stop / soft stop / broker-stop fills are never short-circuited).
 * Once the first ladder rung (+20%) is completed, this module must not fire —
 * post-milestone stepped-floor trail in ladderExit.js owns that phase.
 *
 * Premarket now flattens the full book at the first trigger (no scale-outs),
 * so exit_phase stays LADDER:0 until close_all. This trail already issues
 * close_all against contracts_open — compatible with variable entry size.
 *
 * Floor = peak_mfe / PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR (ratchets up only as MFE makes new highs).
 * While active, the same single resting broker stop is raised to that floor
 * via replaceStop (does not coexist with the −1% loss stop).
 */

import {
  PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
  PREMARKET_PARTIAL_LOCK_CLOSE_REASON,
  PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR,
} from './premarketConfig.js';
import {
  parseLadderMilestonesCompleted,
  computeStopTriggerPrice,
} from '../ladder/ladderConfig.js';

/**
 * Pure decision — no I/O.
 * @returns {{ action: 'hold' } | { action: 'close_all', reason: string, peakMfe: number, trailFloor: number, pnlFrac: number }}
 */
export function evaluatePremarketPartialLockTrail({
  pnlFrac,
  mfeFrac,
  exitPhase,
  activationMfe = PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
  hardStopPct = null,
  trailDivisor = PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR,
}) {
  const milestonesCompleted = parseLadderMilestonesCompleted(exitPhase);
  // Hard gate: never compete with post-milestone ladder ratchet.
  if (milestonesCompleted > 0) {
    return { action: 'hold', inactiveReason: 'post_milestone_ladder_owns_trail' };
  }

  const peak = Math.max(
    Number.isFinite(Number(mfeFrac)) ? Number(mfeFrac) : 0,
    Number.isFinite(Number(pnlFrac)) ? Number(pnlFrac) : 0
  );
  const unrealized = Number.isFinite(Number(pnlFrac)) ? Number(pnlFrac) : 0;

  // Defense in depth: never claim a close that belongs to the hard-stop path.
  // Monitor must evaluate ladder/hard-stop before calling this; this guard
  // prevents partial_lock_trail from winning the race if call order regresses.
  const hardPct = Number(hardStopPct);
  if (Number.isFinite(hardPct) && hardPct > 0 && unrealized <= -hardPct) {
    return {
      action: 'hold',
      inactiveReason: 'hard_stop_owns_exit',
      peakMfe: peak,
      pnlFrac: unrealized,
    };
  }

  if (!(peak >= activationMfe)) {
    return { action: 'hold', inactiveReason: 'below_activation', peakMfe: peak };
  }

  const divisor =
    Number.isFinite(Number(trailDivisor)) && Number(trailDivisor) > 0
      ? Number(trailDivisor)
      : PREMARKET_PARTIAL_LOCK_TRAIL_DIVISOR;
  const trailFloor = peak / divisor;
  if (unrealized <= trailFloor) {
    return {
      action: 'close_all',
      reason: PREMARKET_PARTIAL_LOCK_CLOSE_REASON,
      peakMfe: peak,
      trailFloor,
      pnlFrac: unrealized,
    };
  }

  return {
    action: 'hold',
    peakMfe: peak,
    trailFloor,
    pnlFrac: unrealized,
  };
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
 * Broker-fill attribution for a pre-milestone partial-lock resting stop.
 * Hard-stop fills stay hard_stop. Post-milestone fills keep ladder trailing_stop.
 */
export function resolvePremarketPartialLockStopFillReason({
  position,
  defaultReason,
}) {
  if (defaultReason === 'hard_stop') return defaultReason;
  const milestones = parseLadderMilestonesCompleted(position?.exit_phase);
  const stopFrac = Number(position?.broker_stop_pnl_frac);
  if (milestones === 0 && Number.isFinite(stopFrac) && stopFrac > 0) {
    return PREMARKET_PARTIAL_LOCK_CLOSE_REASON;
  }
  return defaultReason;
}
