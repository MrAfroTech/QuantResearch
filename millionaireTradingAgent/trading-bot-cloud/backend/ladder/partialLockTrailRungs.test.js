import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARTIAL_LOCK_TRAIL_MAX_PCT,
  PARTIAL_LOCK_TRAIL_RUNGS,
  PARTIAL_LOCK_TRAIL_START_PCT,
  PARTIAL_LOCK_TRAIL_STEP_AFTER_50,
  PARTIAL_LOCK_TRAIL_STEP_THROUGH_48,
  evaluateSteppedPartialLockTrail,
  trailFloorFromPeak,
} from './partialLockTrailRungs.js';

describe('partial-lock trail rungs', () => {
  it('starts at +3%, steps +7.5 points through +48%, then +10 points from +58%', () => {
    assert.equal(PARTIAL_LOCK_TRAIL_START_PCT, 0.03);
    assert.equal(PARTIAL_LOCK_TRAIL_STEP_THROUGH_48, 0.075);
    assert.equal(PARTIAL_LOCK_TRAIL_STEP_AFTER_50, 0.1);
    assert.equal(PARTIAL_LOCK_TRAIL_MAX_PCT, 10);
    assert.deepEqual(PARTIAL_LOCK_TRAIL_RUNGS.slice(0, 7), [
      0.03, 0.105, 0.18, 0.255, 0.33, 0.405, 0.48,
    ]);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS[7], 0.58);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS[8], 0.68);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS.at(-1), 9.98);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS.includes(0.5), false);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS.includes(1), false);
  });

  it('locks the highest rung the peak has reached and does not skip ahead', () => {
    assert.equal(trailFloorFromPeak(0.029), null);
    assert.equal(trailFloorFromPeak(0.03), 0.03);
    assert.equal(trailFloorFromPeak(0.08), 0.03);
    assert.equal(trailFloorFromPeak(0.105), 0.105);
    assert.equal(trailFloorFromPeak(0.12), 0.105);
    assert.equal(trailFloorFromPeak(0.18), 0.18);
    assert.equal(trailFloorFromPeak(0.255), 0.255);
    assert.equal(trailFloorFromPeak(0.33), 0.33);
    assert.equal(trailFloorFromPeak(0.405), 0.405);
    assert.equal(trailFloorFromPeak(0.48), 0.48);
    assert.equal(trailFloorFromPeak(0.5), 0.48);
    assert.equal(trailFloorFromPeak(0.58), 0.58);
    assert.equal(trailFloorFromPeak(0.63), 0.58);
    assert.equal(trailFloorFromPeak(0.68), 0.68);
    assert.equal(trailFloorFromPeak(9.98), 9.98);
  });

  it('a confirmed +18% peak has passed +3%, +10.5%, and +18% and stops on +18%', () => {
    const passed = PARTIAL_LOCK_TRAIL_RUNGS.filter((rung) => rung <= 0.18 + 1e-12);
    assert.deepEqual(passed, [0.03, 0.105, 0.18]);
    assert.equal(trailFloorFromPeak(0.18), 0.18);
    assert.equal(trailFloorFromPeak(0.12), 0.105);
  });

  it('does not flatten on the tick that first prints an increment', () => {
    const at3 = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.03,
      mfeFrac: 0.03,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(at3.action, 'hold');
    assert.equal(at3.trailFloor, 0.03);

    const pullback = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.105,
      mfeFrac: 0.12,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(pullback.action, 'close_all');
    assert.equal(pullback.trailFloor, 0.105);

    const past20 = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.22,
      mfeFrac: 0.22,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(past20.action, 'hold');
    assert.equal(past20.trailFloor, 0.18);

    const past58 = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.63,
      mfeFrac: 0.63,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(past58.action, 'hold');
    assert.equal(past58.trailFloor, 0.58);
  });
});
