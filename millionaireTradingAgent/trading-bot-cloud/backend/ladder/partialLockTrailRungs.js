/**
 * Shared 0DTE profit-trail rungs.
 * Arm at +3%, then +7.5 percentage points through +48%:
 *   +3%, +10.5%, +18%, +25.5%, +33%, +40.5%, +48%.
 * Once the ratchet is in the 50% range, floors increase by +10 points:
 *   +58%, +68%, … up to the +1000% ceiling.
 * Floor is the highest rung the peak has reached. It never moves down.
 * These are protected floors, not sell targets.
 */

export const PARTIAL_LOCK_TRAIL_START_PCT = 0.03;
export const PARTIAL_LOCK_TRAIL_STEP_THROUGH_48 = 0.075;
export const PARTIAL_LOCK_TRAIL_STEP_AFTER_50 = 0.10;
/** Inclusive ceiling. The last +10 rung at or below this is 9.98 (998%). */
export const PARTIAL_LOCK_TRAIL_MAX_PCT = 10;

function buildPartialLockTrailRungs() {
  const rungs = [];
  // Basis points avoid 0.075 binary drift (300, 1050, …, 4800, then 5800, 6800, …).
  for (let bps = 300; bps <= 4800; bps += 750) rungs.push(bps / 10000);
  for (let bps = 5800; bps <= PARTIAL_LOCK_TRAIL_MAX_PCT * 10000; bps += 1000) {
    rungs.push(bps / 10000);
  }
  return Object.freeze(rungs);
}

export const PARTIAL_LOCK_TRAIL_RUNGS = buildPartialLockTrailRungs();

/**
 * Highest grid rung the peak has printed (inclusive). Null below the 3% arm.
 */
export function trailFloorFromPeak(peakMfe, rungs = PARTIAL_LOCK_TRAIL_RUNGS) {
  const peak = Number(peakMfe);
  if (!Number.isFinite(peak) || peak < PARTIAL_LOCK_TRAIL_START_PCT) return null;
  let floor = PARTIAL_LOCK_TRAIL_START_PCT;
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
