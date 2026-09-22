import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';
import {
  ZERO_DTE_POSITION_MONITOR_CRON,
  isZeroDteMonitorInFlight,
  markZeroDteMonitorInFlightForTests,
  resetZeroDteMonitorLockForTests,
  runZeroDtePositionMonitorCycle,
} from './scheduler.js';

afterEach(() => {
  resetZeroDteMonitorLockForTests();
});

describe('0DTE position monitor cadence', () => {
  it('defaults to a 10-second tick so intra-minute MFE highs can re-tighten the trail', () => {
    assert.equal(ZERO_DTE_POSITION_MONITOR_CRON, '*/10 * * * * 1-5');
    assert.equal(cron.validate(ZERO_DTE_POSITION_MONITOR_CRON), true);
  });

  it('skips overlapping ticks instead of stacking a second monitor while a replace is in flight', async () => {
    markZeroDteMonitorInFlightForTests();
    assert.equal(isZeroDteMonitorInFlight(), true);
    const result = await runZeroDtePositionMonitorCycle();
    assert.deepEqual(result, { skipped: true, reason: 'in_flight' });
  });
});
