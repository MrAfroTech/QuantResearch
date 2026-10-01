import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeStopTriggerPrice } from './ladderConfig.js';
import { ORB_HARD_STOP_PCT } from '../orb/orbConfig.js';
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
  it('activates at +3%, then locks +13.5% and +15 points after +88.5%', () => {
    assert.equal(PARTIAL_LOCK_TRAIL_START_PCT, 0.03);
    assert.equal(PARTIAL_LOCK_TRAIL_STEP_THROUGH_48, 0.075);
    assert.equal(PARTIAL_LOCK_TRAIL_STEP_AFTER_50, 0.1);
    assert.equal(PARTIAL_LOCK_TRAIL_MAX_PCT, 10);
    assert.deepEqual(PARTIAL_LOCK_TRAIL_RUNGS.slice(0, 7), [
      0.135, 0.275, 0.425, 0.585, 0.735, 0.885, 1.035,
    ]);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS.includes(0.03), false);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS.includes(0.5), false);
    assert.equal(PARTIAL_LOCK_TRAIL_RUNGS.includes(1), false);
    assert.equal(Math.round(PARTIAL_LOCK_TRAIL_RUNGS.at(-1) * 10000), 98850);
  });

  it('locks breakeven at +3% and the highest profit rung the peak has reached', () => {
    assert.equal(trailFloorFromPeak(0.029), null);
    assert.equal(trailFloorFromPeak(0.03), 0);
    assert.equal(trailFloorFromPeak(0.08), 0);
    assert.equal(trailFloorFromPeak(0.12), 0);
    assert.equal(trailFloorFromPeak(0.135), 0.135);
    assert.equal(trailFloorFromPeak(0.18), 0.135);
    assert.equal(trailFloorFromPeak(0.275), 0.275);
    assert.equal(trailFloorFromPeak(0.3), 0.275);
    assert.equal(trailFloorFromPeak(0.425), 0.425);
    assert.equal(trailFloorFromPeak(0.5), 0.425);
    assert.equal(trailFloorFromPeak(0.585), 0.585);
    assert.equal(trailFloorFromPeak(0.6), 0.585);
    assert.equal(trailFloorFromPeak(0.735), 0.735);
    assert.equal(trailFloorFromPeak(0.8), 0.735);
    assert.equal(trailFloorFromPeak(0.885), 0.885);
    assert.equal(trailFloorFromPeak(0.9), 0.885);
    assert.equal(trailFloorFromPeak(1.1), 1.035);
  });

  it('a +18% peak has passed only the +13.5% profit rung', () => {
    const passed = PARTIAL_LOCK_TRAIL_RUNGS.filter((rung) => rung <= 0.18 + 1e-12);
    assert.deepEqual(passed, [0.135]);
    assert.equal(trailFloorFromPeak(0.18), 0.135);
    assert.equal(trailFloorFromPeak(0.12), 0);
  });

  it('does not flatten on the tick that first prints an increment', () => {
    const at3 = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.03,
      mfeFrac: 0.03,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(at3.action, 'hold');
    assert.equal(at3.trailFloor, 0);

    const at135 = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.135,
      mfeFrac: 0.135,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(at135.action, 'hold');
    assert.equal(at135.trailFloor, 0.135);

    const past135 = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.16,
      mfeFrac: 0.16,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(past135.action, 'hold');
    assert.equal(past135.trailFloor, 0.135);

    const giveback = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.135,
      mfeFrac: 0.16,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(giveback.action, 'close_all');
    assert.equal(giveback.trailFloor, 0.135);

    const past275 = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.3,
      mfeFrac: 0.3,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(past275.action, 'hold');
    assert.equal(past275.trailFloor, 0.275);
  });
});

describe('breakeven arm and the +13.5% ratchet', () => {
  const entry = 1.55;

  it('reaching +3% activates and rests the stop at entry, not at +3%', () => {
    const armed = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.03,
      mfeFrac: 0.03,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(armed.action, 'hold');
    assert.equal(armed.trailFloor, 0);
    assert.equal(computeStopTriggerPrice(entry, armed.trailFloor), entry);
    assert.equal(computeStopTriggerPrice(entry, 0.03), 1.6);
    assert.notEqual(computeStopTriggerPrice(entry, armed.trailFloor), 1.6);
  });

  it('holds a pullback above entry and exits at or below entry', () => {
    const above = evaluateSteppedPartialLockTrail({
      pnlFrac: (1.57 - entry) / entry,
      mfeFrac: 0.04,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(above.action, 'hold');
    assert.equal(above.trailFloor, 0);

    const atEntry = evaluateSteppedPartialLockTrail({
      pnlFrac: 0,
      mfeFrac: 0.04,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(atEntry.action, 'close_all');
    assert.equal(atEntry.trailFloor, 0);

    const below = evaluateSteppedPartialLockTrail({
      pnlFrac: (1.54 - entry) / entry,
      mfeFrac: 0.04,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(below.action, 'close_all');
    assert.equal(below.trailFloor, 0);
  });

  it('replaces breakeven with +13.5% and keeps later rungs on the same rule', () => {
    const before = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.12,
      mfeFrac: 0.12,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(before.action, 'hold');
    assert.equal(before.trailFloor, 0);

    const locked = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.16,
      mfeFrac: 0.16,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(locked.action, 'hold');
    assert.equal(locked.trailFloor, 0.135);
    assert.equal(computeStopTriggerPrice(entry, locked.trailFloor), 1.76);

    const next = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.3,
      mfeFrac: 0.3,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(next.action, 'hold');
    assert.equal(next.trailFloor, 0.275);
    const backTo275 = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.275,
      mfeFrac: 0.3,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(backTo275.action, 'close_all');
    assert.equal(backTo275.trailFloor, 0.275);
  });

  it('leaves behavior below +3% unchanged', () => {
    const below = evaluateSteppedPartialLockTrail({
      pnlFrac: 0.02,
      mfeFrac: 0.025,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(below.action, 'hold');
    assert.equal(below.inactiveReason, 'below_activation');
    assert.equal(below.trailFloor, undefined);
  });

  it('leaves the current hard stop in force and lets it own a loss at that level', () => {
    assert.equal(ORB_HARD_STOP_PCT, 0.135);
    const owned = evaluateSteppedPartialLockTrail({
      pnlFrac: -ORB_HARD_STOP_PCT,
      mfeFrac: 0.05,
      hardStopPct: ORB_HARD_STOP_PCT,
      closeReason: 'partial_lock_trail',
    });
    assert.equal(owned.action, 'hold');
    assert.equal(owned.inactiveReason, 'hard_stop_owns_exit');
  });
});
