import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  planUnfilledExit,
  shouldSkipDiscretionaryRetry,
  submitAndSettleFullClose,
  handleLadderPositionMonitor,
  evaluateLadderExit,
  bookNoBrokerPosition,
  isGateRemovedEntry,
} from './ladderExit.js';
import {
  LADDER_CLOSE_REASON,
  LADDER_FORCED_FLATTEN_PRICE,
  LADDER_UNFILLED_EXIT_COOLDOWN_MS,
  LADDER_MILESTONES_PCT,
  LADDER_HARD_STOP_PCT,
  LADDER_INITIAL_STOP_PCT,
  HARD_STOP_LIMIT_WAIT_MS,
  HARD_STOP_LIMIT_BUFFER,
  computeHardStopTriggerPrice,
  computeHardStopCloseLimitPrice,
} from './ladderConfig.js';
import { resetFlattenUntilClosedStateForTests } from './flattenUntilClosed.js';

afterEach(() => {
  resetFlattenUntilClosedStateForTests();
});

describe('planUnfilledExit', () => {
  it('restores the protective stop on an unfilled profit-target (QQQ 709 shape)', () => {
    const plan = planUnfilledExit({
      intendedReason: LADDER_CLOSE_REASON.PROFIT_TARGET,
      isTimeStop: false,
    });
    assert.equal(plan.action, 'restore_stop');
  });

  it('flattens at $0.01 on time-stop leftover discretionary exits', () => {
    const plan = planUnfilledExit({
      intendedReason: LADDER_CLOSE_REASON.PROFIT_TARGET,
      isTimeStop: true,
    });
    assert.equal(plan.action, 'flatten');
    assert.equal(plan.flattenPrice, LADDER_FORCED_FLATTEN_PRICE);
    assert.equal(plan.closeReason, LADDER_CLOSE_REASON.FORCED_CLOSE_EOD);
  });

  it('flattens risk exits (hard/soft/trail) instead of leaving them naked', () => {
    for (const reason of [
      LADDER_CLOSE_REASON.HARD_STOP,
      LADDER_CLOSE_REASON.STOP_LOSS,
      LADDER_CLOSE_REASON.TIME_STOP,
      LADDER_CLOSE_REASON.TRAILING_STOP,
    ]) {
      const plan = planUnfilledExit({ intendedReason: reason, isTimeStop: false });
      assert.equal(plan.action, 'flatten');
      assert.equal(plan.closeReason, reason);
    }
  });
});

describe('shouldSkipDiscretionaryRetry', () => {
  it('skips profit-target retries inside the cooldown window', () => {
    const submitted = new Date(Date.now() - 10_000).toISOString();
    assert.equal(
      shouldSkipDiscretionaryRetry({ pendingCloseSubmittedAt: submitted }),
      true
    );
  });

  it('allows retry after the cooldown', () => {
    const submitted = new Date(
      Date.now() - LADDER_UNFILLED_EXIT_COOLDOWN_MS - 1
    ).toISOString();
    assert.equal(
      shouldSkipDiscretionaryRetry({ pendingCloseSubmittedAt: submitted }),
      false
    );
  });
});

describe('submitAndSettleFullClose fill gate', () => {
  it('does not write the trade log when the STC is submitted but not filled', async () => {
    const closed = [];
    const cancelled = [];
    const stops = [];
    const position = {
      id: 68,
      entry_premium: 0.93,
      contracts_open: 1,
      quantity: 1,
      broker_stop_order_id: 'stop-1',
      exit_phase: 'INITIAL',
    };
    const result = await submitAndSettleFullClose({
      position,
      closeQty: 1,
      currentPremium: 1.23,
      pnlFrac: 0.32,
      intendedReason: LADDER_CLOSE_REASON.PROFIT_TARGET,
      isTimeStop: false,
      brokerStop: {
        enabled: true,
        async cancelStop() {
          position.broker_stop_order_id = null;
        },
        async replaceStop() {
          stops.push('replaced');
          return { placed: true };
        },
      },
      closeBrokerOrder: async () => ({
        orderId: '497831575',
        filled: false,
        fillPrice: null,
        status: 'live',
      }),
      fullClosePosition: async (...args) => {
        closed.push(args);
      },
      cancelExitOrder: async (id) => {
        cancelled.push(id);
      },
      updatePendingClose: async () => {},
    });

    assert.equal(result.pendingClose, true);
    assert.equal(result.brokerFillConfirmed, undefined);
    assert.deepEqual(closed, []);
    assert.deepEqual(cancelled, ['497831575']);
    assert.deepEqual(stops, ['replaced']);
  });

  it('writes the trade log only after a confirmed fill, using fill price not the mark', async () => {
    const closed = [];
    const result = await submitAndSettleFullClose({
      position: {
        id: 67,
        entry_premium: 0.97,
        contracts_open: 1,
        quantity: 1,
      },
      closeQty: 1,
      currentPremium: 1.07,
      pnlFrac: 0.10,
      intendedReason: LADDER_CLOSE_REASON.TRAILING_STOP,
      isTimeStop: false,
      closeBrokerOrder: async () => ({
        orderId: '497821396',
        filled: true,
        fillPrice: 1.07,
        status: 'filled',
      }),
      fullClosePosition: async (...args) => {
        closed.push(args);
      },
      updatePendingClose: async () => {},
    });

    assert.equal(result.brokerFillConfirmed, true);
    assert.equal(result.exitPremium, 1.07);
    assert.equal(closed.length, 1);
    assert.equal(closed[0][1], 1.07);
    assert.equal(closed[0][3], LADDER_CLOSE_REASON.TRAILING_STOP);
  });

  it('does not write the trade log when filled is true but fillPrice is missing', async () => {
    const closed = [];
    const result = await submitAndSettleFullClose({
      position: {
        id: 89,
        entry_premium: 0.715,
        contracts_open: 1,
        quantity: 1,
      },
      closeQty: 1,
      currentPremium: 0.55,
      pnlFrac: -0.23,
      intendedReason: LADDER_CLOSE_REASON.PROFIT_TARGET,
      isTimeStop: false,
      brokerStop: {
        enabled: true,
        async cancelStop() {},
        async replaceStop() {
          return { placed: true };
        },
      },
      closeBrokerOrder: async () => ({
        orderId: 'stc-1',
        filled: true,
        fillPrice: null,
        status: 'filled',
      }),
      fullClosePosition: async (...args) => {
        closed.push(args);
      },
      cancelExitOrder: async () => {},
      updatePendingClose: async () => {},
    });

    assert.equal(result.brokerFillConfirmed, undefined);
    assert.equal(result.pendingClose, true);
    assert.deepEqual(closed, []);
  });

  it('escalates an unfilled hard stop to a $0.01 flatten', async () => {
    const closes = [];
    const flattenCalls = [];
    const result = await submitAndSettleFullClose({
      position: { id: 1, entry_premium: 1, contracts_open: 1, quantity: 1 },
      closeQty: 1,
      currentPremium: 0.9,
      pnlFrac: -0.1,
      intendedReason: LADDER_CLOSE_REASON.HARD_STOP,
      isTimeStop: false,
      closeBrokerOrder: async () => ({
        orderId: 'limit-1',
        filled: false,
      }),
      flattenBrokerOrder: async (_pos, price, qty) => {
        flattenCalls.push({ price, qty });
        return { orderId: 'flat-1', filled: true, fillPrice: 0.01 };
      },
      fullClosePosition: async (...args) => {
        closes.push(args);
      },
      cancelExitOrder: async () => {},
      updatePendingClose: async () => {},
    });

    assert.equal(result.brokerFillConfirmed, true);
    assert.equal(flattenCalls[0].price, 0.01);
    assert.equal(closes[0][1], 0.01);
    assert.equal(closes[0][3], LADDER_CLOSE_REASON.HARD_STOP);
  });

  it('submits the poll hard-stop as a trigger-priced limit, not the slipped mark', async () => {
    const closes = [];
    const closeArgs = [];
    const flattenCalls = [];
    const entry = 0.80;
    const hardStopPct = 0.0175;
    const trigger = computeHardStopTriggerPrice(entry, hardStopPct);
    const limit = computeHardStopCloseLimitPrice(trigger);
    const result = await submitAndSettleFullClose({
      position: { id: 12, entry_premium: entry, contracts_open: 3, quantity: 3 },
      closeQty: 3,
      currentPremium: 0.70,
      pnlFrac: -0.125,
      intendedReason: LADDER_CLOSE_REASON.HARD_STOP,
      hardStopPct,
      closeBrokerOrder: async (_pos, price, qty, opts) => {
        closeArgs.push({ price, qty, opts });
        return { orderId: 'lim-1', filled: true, fillPrice: price };
      },
      flattenBrokerOrder: async (_pos, price, qty) => {
        flattenCalls.push({ price, qty });
        return { filled: false };
      },
      fullClosePosition: async (...args) => {
        closes.push(args);
      },
      updatePendingClose: async () => {},
    });

    assert.equal(trigger, 0.79);
    assert.equal(limit, 0.78);
    assert.equal(closeArgs[0].price, 0.78);
    assert.notEqual(closeArgs[0].price, 0.70);
    assert.equal(closeArgs[0].opts.fillWaitMs, HARD_STOP_LIMIT_WAIT_MS);
    assert.equal(result.escalated, false);
    assert.equal(result.hardStopLimitPrice, 0.78);
    assert.equal(flattenCalls.length, 0);
    assert.equal(closes[0][3], LADDER_CLOSE_REASON.HARD_STOP);
  });

  it('escalates an unfilled hard-stop limit to the market flatten and marks escalated', async () => {
    const closeArgs = [];
    const flattenCalls = [];
    const result = await submitAndSettleFullClose({
      position: { id: 13, entry_premium: 0.80, contracts_open: 1, quantity: 1 },
      closeQty: 1,
      currentPremium: 0.70,
      pnlFrac: -0.125,
      intendedReason: LADDER_CLOSE_REASON.HARD_STOP,
      hardStopPct: 0.0175,
      closeBrokerOrder: async (_pos, price, qty, opts) => {
        closeArgs.push({ price, opts });
        return { orderId: 'lim-1', filled: false };
      },
      flattenBrokerOrder: async (_pos, price, qty) => {
        flattenCalls.push({ price, qty });
        return { orderId: 'mkt-1', filled: true, fillPrice: 0.01 };
      },
      fullClosePosition: async () => {},
      cancelExitOrder: async () => {},
      updatePendingClose: async () => {},
      sleep: async () => {},
    });

    assert.equal(closeArgs[0].price, 0.78);
    assert.equal(closeArgs[0].opts.fillWaitMs, HARD_STOP_LIMIT_WAIT_MS);
    assert.equal(flattenCalls[0].price, 0.01);
    assert.equal(result.escalated, true);
    assert.equal(result.skippedLimitEscalation, false);
    assert.equal(result.brokerFillConfirmed, true);
  });

  it('skips the 3s hard-stop limit and goes to market when gate_removed_entry is true', async () => {
    const closeArgs = [];
    const flattenCalls = [];
    const result = await submitAndSettleFullClose({
      position: {
        id: 74,
        entry_premium: 1.13,
        contracts_open: 1,
        quantity: 1,
        entry_metadata_json: JSON.stringify({ gate_removed_entry: true }),
      },
      closeQty: 1,
      currentPremium: 1.0,
      pnlFrac: -0.115,
      intendedReason: LADDER_CLOSE_REASON.HARD_STOP,
      hardStopPct: 0.0175,
      closeBrokerOrder: async (_pos, price, qty, opts) => {
        closeArgs.push({ price, opts });
        return { orderId: 'lim-should-not-run', filled: false };
      },
      flattenBrokerOrder: async (_pos, price, qty) => {
        flattenCalls.push({ price, qty });
        return { orderId: 'mkt-1', filled: true, fillPrice: 1.0 };
      },
      fullClosePosition: async () => {},
      cancelExitOrder: async () => {},
      updatePendingClose: async () => {},
      sleep: async () => {},
    });

    assert.equal(closeArgs.length, 0);
    assert.equal(flattenCalls.length, 1);
    assert.equal(flattenCalls[0].price, LADDER_FORCED_FLATTEN_PRICE);
    assert.equal(result.escalated, true);
    assert.equal(result.skippedLimitEscalation, true);
    assert.equal(result.hardStopLimitPrice, null);
    assert.equal(result.brokerFillConfirmed, true);
  });

  it('keeps limit-first hard-stop when gate_removed_entry is false', async () => {
    const closeArgs = [];
    const flattenCalls = [];
    const result = await submitAndSettleFullClose({
      position: {
        id: 12,
        entry_premium: 0.80,
        contracts_open: 1,
        quantity: 1,
        entry_metadata_json: JSON.stringify({ gate_removed_entry: false }),
      },
      closeQty: 1,
      currentPremium: 0.70,
      pnlFrac: -0.125,
      intendedReason: LADDER_CLOSE_REASON.HARD_STOP,
      hardStopPct: 0.0175,
      closeBrokerOrder: async (_pos, price, qty, opts) => {
        closeArgs.push({ price, opts });
        return { orderId: 'lim-1', filled: true, fillPrice: price };
      },
      flattenBrokerOrder: async (_pos, price, qty) => {
        flattenCalls.push({ price, qty });
        return { filled: false };
      },
      fullClosePosition: async () => {},
      updatePendingClose: async () => {},
    });

    assert.equal(closeArgs.length, 1);
    assert.equal(closeArgs[0].opts.fillWaitMs, HARD_STOP_LIMIT_WAIT_MS);
    assert.equal(flattenCalls.length, 0);
    assert.equal(result.escalated, false);
    assert.equal(result.skippedLimitEscalation, false);
  });

  it('retries an unfilled flatten until it fills and never restores the stop', async () => {
    const closes = [];
    const flattenCalls = [];
    const stops = [];
    const result = await submitAndSettleFullClose({
      position: { id: 9, entry_premium: 1, contracts_open: 2, quantity: 2 },
      closeQty: 2,
      currentPremium: 0.8,
      pnlFrac: -0.2,
      intendedReason: LADDER_CLOSE_REASON.TIME_STOP,
      isTimeStop: true,
      brokerStop: {
        enabled: true,
        async cancelStop() {},
        async replaceStop() {
          stops.push('replaced');
          return { placed: true };
        },
      },
      closeBrokerOrder: async () => ({ orderId: 'limit-1', filled: false }),
      flattenBrokerOrder: async (_pos, price, qty) => {
        flattenCalls.push({ price, qty });
        if (flattenCalls.length < 4) return { orderId: `flat-${flattenCalls.length}`, filled: false };
        return { orderId: 'flat-4', filled: true, fillPrice: 0.01 };
      },
      fullClosePosition: async (...args) => {
        closes.push(args);
      },
      cancelExitOrder: async () => {},
      updatePendingClose: async () => {},
      sleep: async () => {},
    });

    assert.equal(result.flattenRetry, true);
    assert.equal(result.stopRestored, false);
    assert.equal(result.brokerFillConfirmed, undefined);
    assert.deepEqual(stops, []);

    const deadline = Date.now() + 500;
    while (closes.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(closes.length, 1);
    assert.equal(closes[0][3], LADDER_CLOSE_REASON.TIME_STOP);
    assert.ok(flattenCalls.length >= 4);
    assert.deepEqual(stops, []);
  });
});

describe('hard-stop limit price', () => {
  it('is trigger minus one tick, floored at $0.01', () => {
    assert.equal(HARD_STOP_LIMIT_BUFFER, 0.01);
    assert.equal(HARD_STOP_LIMIT_WAIT_MS, 3_000);
    assert.equal(computeHardStopTriggerPrice(0.80, 0.0175), 0.79);
    assert.equal(computeHardStopCloseLimitPrice(0.79), 0.78);
    assert.equal(computeHardStopCloseLimitPrice(0.01), 0.01);
  });
});

describe('isGateRemovedEntry', () => {
  it('is true only for the boolean tag on metadata or the position', () => {
    assert.equal(isGateRemovedEntry(null), false);
    assert.equal(isGateRemovedEntry({}), false);
    assert.equal(
      isGateRemovedEntry({ entry_metadata_json: JSON.stringify({ gate_removed_entry: false }) }),
      false
    );
    assert.equal(
      isGateRemovedEntry({ entry_metadata_json: JSON.stringify({ gate_removed_entry: true }) }),
      true
    );
    assert.equal(isGateRemovedEntry({ gate_removed_entry: true }), true);
  });
});

describe('handleLadderPositionMonitor close_all fill gate', () => {
  it('does not mark closed at submit when filled=false', async () => {
    const closed = [];
    const result = await handleLadderPositionMonitor(
      {
        id: 68,
        entry_premium: 0.93,
        contracts_open: 1,
        quantity: 1,
        entry_contracts: 1,
        exit_phase: 'INITIAL',
        mfe_pct: 0.32,
        mae_pct: 0,
        trail_peak_pnl_frac: 0,
      },
      {
        currentPremium: 1.23,
        initialStopPct: 0.0225,
        hardStopPct: 0.03,
        isTimeStop: false,
        updateExcursion: async () => {},
        partialCloseLeg: async () => {},
        fullClosePosition: async (...args) => {
          closed.push(args);
        },
        closeBrokerOrder: async () => ({
          orderId: 'x',
          filled: false,
        }),
        cancelExitOrder: async () => {},
        updatePendingClose: async () => {},
      }
    );
    assert.equal(result.pendingClose, true);
    assert.deepEqual(closed, []);
  });

  it('does not poll-close a zero-fill phantom on a hard-stop mark', async () => {
    const closed = [];
    const closeBroker = [];
    const result = await handleLadderPositionMonitor(
      {
        id: 7,
        entry_premium: 0.925,
        contracts_open: 1,
        quantity: 1,
        entry_contracts: 1,
        exit_phase: 'LADDER:0',
        mfe_pct: 0,
        mae_pct: 0,
        trail_peak_pnl_frac: 0,
        entry_metadata_json: JSON.stringify({
          fill_quantity: 0,
          booked_quantity: 1,
          requested_quantity: 1,
        }),
      },
      {
        currentPremium: 0.815,
        initialStopPct: 0.01,
        hardStopPct: 0.0175,
        isTimeStop: false,
        fullPositionExits: true,
        updateExcursion: async () => {},
        partialCloseLeg: async () => {},
        fullClosePosition: async (...args) => {
          closed.push(args);
        },
        closeBrokerOrder: async (...args) => {
          closeBroker.push(args);
          return { filled: false, noBrokerPosition: true, reason: 'entry_unfilled_cancelled' };
        },
        cancelExitOrder: async () => {},
        updatePendingClose: async () => {},
      }
    );
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'entry_not_filled');
    assert.deepEqual(closed, []);
    assert.deepEqual(closeBroker, []);
  });
});

describe('evaluateLadderExit full-position (ORB/Premarket)', () => {
  const base = {
    exitPhase: 'LADDER:0',
    contractsOpen: 5,
    entryContracts: 5,
    initialStopPct: 0.01,
    hardStopPct: 0.0175,
    fullPositionExits: true,
  };

  it('hard stop closes the entire book', () => {
    const d = evaluateLadderExit({ ...base, pnlFrac: -0.02 });
    assert.equal(d.action, 'close_all');
    assert.equal(d.reason, LADDER_CLOSE_REASON.HARD_STOP);
    assert.equal(d.contracts, 5);
  });

  it('does not hard-stop when skipHardStop is set (zero-fill / no broker long)', () => {
    const d = evaluateLadderExit({
      ...base,
      pnlFrac: -0.12,
      skipHardStop: true,
      skipPollStops: true,
    });
    assert.equal(d.action, 'hold');
  });

  it('still time-stops even when skipHardStop is set', () => {
    const d = evaluateLadderExit({
      ...base,
      pnlFrac: -0.12,
      skipHardStop: true,
      skipPollStops: true,
      isTimeStop: true,
    });
    assert.equal(d.action, 'close_all');
    assert.equal(d.reason, LADDER_CLOSE_REASON.TIME_STOP);
  });

  it('soft stop closes the entire book', () => {
    const d = evaluateLadderExit({ ...base, pnlFrac: -0.012 });
    assert.equal(d.action, 'close_all');
    assert.equal(d.reason, LADDER_CLOSE_REASON.STOP_LOSS);
    assert.equal(d.contracts, 5);
  });

  it('time-stop flatten closes the entire book', () => {
    const d = evaluateLadderExit({ ...base, pnlFrac: 0.05, isTimeStop: true });
    assert.equal(d.action, 'close_all');
    assert.equal(d.reason, LADDER_CLOSE_REASON.TIME_STOP);
    assert.equal(d.contracts, 5);
  });

  it('first milestone (+20%) holds so the profit trail can keep ratcheting', () => {
    assert.equal(LADDER_MILESTONES_PCT[0], 0.2);
    const d = evaluateLadderExit({ ...base, pnlFrac: 0.2 });
    assert.equal(d.action, 'hold');
    assert.notEqual(d.reason, LADDER_CLOSE_REASON.PROFIT_TARGET);
    assert.notEqual(d.action, 'scale_out');
  });

  it('bypasses LADDER_SELL_SCHEDULE: 3-contract book at +20% holds, not sell 1', () => {
    const d = evaluateLadderExit({
      ...base,
      contractsOpen: 3,
      entryContracts: 3,
      pnlFrac: 0.21,
    });
    assert.equal(d.action, 'hold');
  });

  it('EMA/Swing without the flag still scale out on the first rung', () => {
    const d = evaluateLadderExit({
      ...base,
      fullPositionExits: false,
      contractsOpen: 3,
      entryContracts: 3,
      pnlFrac: 0.21,
      initialStopPct: LADDER_INITIAL_STOP_PCT,
      hardStopPct: LADDER_HARD_STOP_PCT,
    });
    assert.equal(d.action, 'scale_out');
    assert.equal(d.reason, LADDER_CLOSE_REASON.SCALE_OUT);
    assert.equal(d.contracts, 1);
  });
});

describe('bookNoBrokerPosition', () => {
  const position = { id: 88, entry_premium: 1.11, contracts_open: 1, quantity: 1 };

  it('books the STC print on broker_already_flat, not $0 pnl', () => {
    const booked = bookNoBrokerPosition({
      closeResult: {
        noBrokerPosition: true,
        reason: 'broker_already_flat',
        fillPrice: 1.03,
        filled: true,
      },
      position,
      currentPremium: 0.99,
      pnlFrac: -0.1,
    });
    assert.equal(booked.reason, 'broker_already_flat');
    assert.equal(booked.exitPremium, 1.03);
    assert.ok(Math.abs(booked.pnlFrac - (1.03 - 1.11) / 1.11) < 1e-9);
  });

  it('keeps entry-never-filled as pnl 0', () => {
    const booked = bookNoBrokerPosition({
      closeResult: {
        noBrokerPosition: true,
        reason: 'entry_unfilled_cancelled',
        fillPrice: null,
        filled: false,
      },
      position,
      currentPremium: 0.99,
      pnlFrac: -0.1,
    });
    assert.equal(booked.reason, 'entry_unfilled_cancelled');
    assert.equal(booked.exitPremium, 0.99);
    assert.equal(booked.pnlFrac, 0);
  });
});

describe('submitAndSettleFullClose broker_already_flat', () => {
  it('books the broker STC fill instead of the mark at pnl 0', async () => {
    const closes = [];
    const result = await submitAndSettleFullClose({
      position: { id: 88, entry_premium: 1.11, contracts_open: 1, quantity: 1 },
      closeQty: 1,
      currentPremium: 0.99,
      pnlFrac: -0.11,
      intendedReason: LADDER_CLOSE_REASON.HARD_STOP,
      closeBrokerOrder: async () => ({
        noBrokerPosition: true,
        reason: 'broker_already_flat',
        fillPrice: 1.03,
        filled: true,
      }),
      fullClosePosition: async (...args) => {
        closes.push(args);
      },
      updatePendingClose: async () => {},
    });
    assert.equal(result.reason, 'broker_already_flat');
    assert.equal(result.exitPremium, 1.03);
    assert.equal(closes[0][1], 1.03);
    assert.equal(closes[0][3], 'broker_already_flat');
    assert.ok(closes[0][2] < 0);
  });
});

