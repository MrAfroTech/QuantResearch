import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrokerStopOrderParams } from '../ladder/ladderStopOrders.js';
import {
  PREMARKET_HARD_STOP_TRIGGER,
  PREMARKET_STOP_LOSS_PCT,
  computePremarketIvStopPcts,
} from './premarketConfig.js';

describe('Premarket resting broker stop tracks soft + hard levels', () => {
  it('hard trigger is 13.5% and distinct from soft 8%', () => {
    assert.equal(PREMARKET_HARD_STOP_TRIGGER, 0.135);
    assert.equal(PREMARKET_STOP_LOSS_PCT, 0.08);
    const iv = computePremarketIvStopPcts(0.1583);
    assert.equal(iv.hardStopPct, PREMARKET_HARD_STOP_TRIGGER);
    assert.equal(iv.softStopPct, PREMARKET_STOP_LOSS_PCT);
  });

  it('placeInitialStop params at soft = 8% off entry (same path as executor)', () => {
    const entry = 0.925;
    // Executor/monitor pass soft PREMARKET_STOP_LOSS_PCT for the resting broker stop.
    const params = buildBrokerStopOrderParams(
      {
        entry_premium: entry,
        quantity: 5,
        contracts_open: 5,
        exit_phase: 'LADDER:0',
        trail_peak_pnl_frac: 0,
      },
      { initialStopPct: PREMARKET_STOP_LOSS_PCT }
    );
    assert.ok(params);
    assert.equal(params.stopPnlFrac, -PREMARKET_STOP_LOSS_PCT);
    const expectedTrigger = Math.max(
      0.01,
      Math.round(entry * (1 - PREMARKET_STOP_LOSS_PCT) * 100) / 100
    );
    assert.equal(params.stopTrigger, expectedTrigger);
    // 0.925 * 0.92 = 0.851 → 0.85
    assert.equal(params.stopTrigger, 0.85);
    assert.notEqual(
      params.stopTrigger,
      Math.max(0.01, Math.round(entry * (1 - PREMARKET_HARD_STOP_TRIGGER) * 100) / 100)
    );
  });

  it('hard 13.5% poll price is below the soft 8% resting price', () => {
    const entry = 0.925;
    const hard = buildBrokerStopOrderParams(
      { entry_premium: entry, quantity: 1, contracts_open: 1, exit_phase: 'LADDER:0' },
      { initialStopPct: PREMARKET_HARD_STOP_TRIGGER }
    );
    const soft = buildBrokerStopOrderParams(
      { entry_premium: entry, quantity: 1, contracts_open: 1, exit_phase: 'LADDER:0' },
      { initialStopPct: PREMARKET_STOP_LOSS_PCT }
    );
    // 0.925 * 0.865 = 0.800125 → 0.80 ; soft → 0.85
    assert.equal(hard.stopTrigger, 0.80);
    assert.equal(soft.stopTrigger, 0.85);
    assert.ok(hard.stopTrigger < soft.stopTrigger);
  });

  it('replaceStop baseline after LADDER:0 uses soft when no ratchet frac passed', () => {
    const params = buildBrokerStopOrderParams(
      {
        entry_premium: 1.0,
        quantity: 1,
        contracts_open: 1,
        exit_phase: 'LADDER:0',
        trail_peak_pnl_frac: 0,
      },
      { initialStopPct: PREMARKET_STOP_LOSS_PCT }
    );
    assert.equal(params.stopPnlFrac, -0.08);
    assert.equal(params.stopTrigger, 0.92); // 1.0 * 0.92 → 0.92
  });
});
