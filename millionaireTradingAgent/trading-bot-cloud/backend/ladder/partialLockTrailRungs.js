/**
 * Shared 0DTE profit-trail rungs for ORB, Premarket, and EMA/VWAP.
 * +3% activates the trail. It is not a profit lock.
 * The first resting floor is breakeven (0). The profit rungs are then
 *   +13.5%, +27.5%, +42.5%, +58.5%, +73.5%, +88.5%,
 * and +15 points per rung after that, up to the +1000% ceiling.
 * Floor is the highest rung the peak has reached. It never moves down.
 * These are protected floors, not sell targets.
 */

export const PARTIAL_LOCK_TRAIL_START_PCT = 0.03;
/** Retained for the risk snapshot. The live grid is PARTIAL_LOCK_TRAIL_RUNGS. */
export const PARTIAL_LOCK_TRAIL_STEP_THROUGH_48 = 0.075;
/** Retained for the risk snapshot. The live grid is PARTIAL_LOCK_TRAIL_RUNGS. */
export const PARTIAL_LOCK_TRAIL_STEP_AFTER_50 = 0.10;
/** Inclusive ceiling. Later +15-point rungs stop at the last step still <= this. */
export const PARTIAL_LOCK_TRAIL_MAX_PCT = 10;

/** Profit locks only. +3% is the activation threshold and is intentionally absent. */
const PARTIAL_LOCK_TRAIL_LISTED_BPS = Object.freeze([1350, 2750, 4250, 5850, 7350, 8850]);
const PARTIAL_LOCK_TRAIL_STEP_AFTER_LISTED_BPS = 1500;

function buildPartialLockTrailRungs() {
  const rungs = PARTIAL_LOCK_TRAIL_LISTED_BPS.map((bps) => bps / 10000);
  const ceiling = PARTIAL_LOCK_TRAIL_MAX_PCT * 10000;
  for (
    let bps = PARTIAL_LOCK_TRAIL_LISTED_BPS.at(-1) + PARTIAL_LOCK_TRAIL_STEP_AFTER_LISTED_BPS;
    bps <= ceiling;
    bps += PARTIAL_LOCK_TRAIL_STEP_AFTER_LISTED_BPS
  ) {
    rungs.push(bps / 10000);
  }
  return Object.freeze(rungs);
}

export const PARTIAL_LOCK_TRAIL_RUNGS = buildPartialLockTrailRungs();

/**
 * Highest grid rung the peak has printed (inclusive).
 * Null below the 3% arm. From the arm until +13.5%, the floor is breakeven (0).
 */
export function trailFloorFromPeak(peakMfe, rungs = PARTIAL_LOCK_TRAIL_RUNGS) {
  const peak = Number(peakMfe);
  if (!Number.isFinite(peak) || peak < PARTIAL_LOCK_TRAIL_START_PCT) return null;
  let floor = 0;
  for (const rung of rungs) {
    if (rung <= peak + 1e-12) floor = rung;
    else break;
  }
  return floor;
}

/**
 * Pure trail decision shared by ORB / Premarket / EMA-VWAP.
 * Close only after the peak has lifted off the current floor (so printing a
 * new increment does not flatten on the same tick).
 */
export function evaluateSteppedPartialLockTrail({
  pnlFrac,
  mfeFrac,
  hardStopPct = null,
  closeReason,
  activationMfe = PARTIAL_LOCK_TRAIL_START_PCT,
}) {
  const peak = Math.max(
    Number.isFinite(Number(mfeFrac)) ? Number(mfeFrac) : 0,
    Number.isFinite(Number(pnlFrac)) ? Number(pnlFrac) : 0
  );
  const unrealized = Number.isFinite(Number(pnlFrac)) ? Number(pnlFrac) : 0;

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

  const trailFloor = trailFloorFromPeak(peak);
  if (trailFloor == null) {
    return { action: 'hold', inactiveReason: 'below_activation', peakMfe: peak };
  }

  const liftedOffFloor = peak > trailFloor + 1e-12;
  if (liftedOffFloor && unrealized <= trailFloor) {
    return {
      action: 'close_all',
      reason: closeReason,
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
