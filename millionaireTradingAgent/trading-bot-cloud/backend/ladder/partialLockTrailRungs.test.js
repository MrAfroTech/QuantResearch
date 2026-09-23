import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARTIAL_LOCK_TRAIL_MAX_PCT,
  PARTIAL_LOCK_TRAIL_RUNGS,
  PARTIAL_LOCK_TRAIL_START_PCT,
  PARTIAL_LOCK_TRAIL_STEP_AFTER_100,
  PARTIAL_LOCK_TRAIL_STEP_TO_100,
  evaluateSteppedPartialLockTrail,
  trailFloorFromPeak,
} from './partialLockTrailRungs.js';

describe('partial-lock trail rungs', () => {
  it('starts at 3%, steps 5% through 100%, then 10% through 1000%', () => {
    assert.equal(PARTIAL_LOCK_TRAIL_START_PCT, 0.03);
    assert.equal(PARTIAL_LOCK_TRAIL_STEP_TO_100, 0.05);
    assert.equal(PARTIAL_LOCK_TRAIL_STEP_AFTER_100, 0.1);
    assert.equal(PARTIAL_LOCK_TRAIL_MAX_PCT, 10);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS[0], 0.03);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS[1], 0.05);
    assert.ok(PARTIAL_LOCK_TRAIL_RUNGS.includes(1));
    assert.ok(PARTIAL_LOCK_TRAIL_RUNGS.includes(1.1));
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS[PARTIAL_LOCK_TRAIL_RUNGS.length - 1], 10);
    const at100 = PARTIAL_LOCK_TRAIL_RUNGS.indexOf(1);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS[at100 + 1], 1.1);
  });

  it('locks the last increment printed and ratchets only on new highs', () => {
    assert.equal(trailFloorFromPeak(0.029), null);
    assert.equal(trailFloorFromPeak(0.03), 0.03);
    assert.equal(trailFloorFromPeak(0.07), 0.05);
    assert.equal(trailFloorFromPeak(0.1), 0.1);
    assert.equal(trailFloorFromPeak(0.99), 0.95);
    assert.equal(trailFloorFromPeak(1), 1);
    assert.equal(trailFloorFromPeak(1.05), 1);
    assert.equal(trailFloorFromPeak(1.1), 1.1);
    assert.equal(trailFloorFromPeak(10), 10);
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
      pnlFrac: 0.03,
      mfeFrac: 0.07,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(pullback.action, 'close_all');
    assert.equal(pullback.trailFloor, 0.05);

    const past20 = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.22,
      mfeFrac: 0.22,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(past20.action, 'hold');
    assert.equal(past20.trailFloor, 0.2);

    const past110 = evaluateSteppedPartialLockTrail({
      pnlFrac: 1.15,
      mfeFrac: 1.15,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(past110.action, 'hold');
    assert.equal(past110.trailFloor, 1.1);
  });
});
