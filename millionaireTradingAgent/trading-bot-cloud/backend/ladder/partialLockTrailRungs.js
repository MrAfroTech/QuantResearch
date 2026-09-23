/**
 * Shared 0DTE profit-trail rungs: arm at +3%, then +5% steps through +100%,
 * then +10% steps through +1000%. Floor is the highest rung the peak has reached.
 * Ratchets up on new highs only; never lowers.
 */

export const PARTIAL_LOCK_TRAIL_START_PCT = 0.03;
export const PARTIAL_LOCK_TRAIL_STEP_TO_100 = 0.05;
export const PARTIAL_LOCK_TRAIL_STEP_AFTER_100 = 0.10;
export const PARTIAL_LOCK_TRAIL_MAX_PCT = 10;

function roundPct(value) {
  return Math.round(value * 10000) / 10000;
}

export function buildPartialLockTrailRungs() {
  const rungs = [PARTIAL_LOCK_TRAIL_START_PCT];
  for (let pct = PARTIAL_LOCK_TRAIL_STEP_TO_100; pct <= 1.0000001; pct += PARTIAL_LOCK_TRAIL_STEP_TO_100) {
    rungs.push(roundPct(pct));
  }
  for (
    let pct = 1 + PARTIAL_LOCK_TRAIL_STEP_AFTER_100;
    pct <= PARTIAL_LOCK_TRAIL_MAX_PCT + 1e-12;
    pct += PARTIAL_LOCK_TRAIL_STEP_AFTER_100
  ) {
    rungs.push(roundPct(pct));
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
