import { getBotState, insertPosition, markSignalExecuted, hasSwingEntryExecutedToday, logSignal, updatePositionPyramidState } from './db.js';
import { placeOptionOrder } from './brokerageConnector.js';
import { bookedEntryQuantity, shouldBookConfirmedEntry } from './ladder/orderFillStatus.js';
import { maybeSkipUnfilledOpenInsert } from './ladder/zeroFillEntry.js';
import {
  canOpenPosition,
  buildTradeParams,
} from './positionManager.js';
import { getSwingBudgetRemaining, getSwingTotalAllocated, SWING_WEEKLY_TOP_OFF } from './budget/budgetAllocations.js';
import { getStrategyEnvironment } from './strategyEnvironment.js';
import { checkLiveEntryGate } from './budget/liveEntryGate.js';
import { etDateKey } from './orb/tradierTimesales.js';
import { getSameDayReentryGate } from './entryReentryGate.js';
import { getTickerPauseGate } from './tickerPauses.js';

/** Documented base weekly allocation for swing (DB total_allocated is authoritative at runtime). */
/** @deprecated Use SWING_WEEKLY_TOP_OFF from budget/budgetAllocations.js */
export const SWING_MONTHLY_BUDGET_MAX = SWING_WEEKLY_TOP_OFF;

export async function getMaxMonthlyBudget() {
  return getSwingTotalAllocated();
}

export async function processSignals(signals) {
  const results = [];

  for (const signal of signals) {
    const result = await evaluateAndExecute(signal);
    results.push(result);
  }

  return results;
}

async function evaluateAndExecute(signal) {
  const state = await getBotState();

  if (signal.confidence !== 'HIGH') {
    return { signal, executed: false, reason: 'low_confidence' };
  }

  const tradeDate = etDateKey();
  const breakoutLevel =
    signal.signalType === 'tv_breakout' ? Number(signal.prev_daily_high) : null;
  const alreadyExecuted = await hasSwingEntryExecutedToday({
    ticker: signal.ticker,
    direction: signal.direction,
    signalType: signal.signalType,
    tradeDate,
    breakoutLevel: Number.isFinite(breakoutLevel) ? breakoutLevel : null,
  });
  if (alreadyExecuted) {
    console.log(
      `[tradeExecutor] Skipping duplicate entry (already executed today) for ${signal.ticker} ${signal.direction} ${signal.signalType}`
    );
    await logSignal({
      ticker: signal.ticker,
      signalType: signal.signalType,
      result: 'already_executed_today',
      direction: signal.direction,
      confidence: signal.confidence,
      executed: false,
    });
    return { signal, executed: false, reason: 'already_executed_today' };
  }

  const pause = getTickerPauseGate({
    strategy: 'swing',
    ticker: signal.ticker,
    direction: signal.direction,
  });
  if (pause.blocked) {
    console.log(
      `[tradeExecutor] ${pause.reason} — skipping ${signal.ticker} ${signal.direction}` +
        (pause.note ? ` (${pause.note})` : '')
    );
    await logSignal({
      ticker: signal.ticker,
      signalType: signal.signalType,
      result: pause.reason,
      direction: signal.direction,
      confidence: signal.confidence,
      executed: false,
    });
    return { signal, executed: false, reason: pause.reason };
  }

  const reentry = await getSameDayReentryGate({
    strategy: 'swing',
    ticker: signal.ticker,
    direction: signal.direction,
    tradeDate,
  });
  if (reentry.blocked) {
    console.log(
      `[tradeExecutor] Same-day loss block — skipping ${signal.ticker} ${signal.direction}` +
        ` (last today: ${reentry.lastCloseReason} pnl=${reentry.lastPnl})`
    );
    await logSignal({
      ticker: signal.ticker,
      signalType: signal.signalType,
      result: 'same_day_loss_block',
      direction: signal.direction,
      confidence: signal.confidence,
      executed: false,
    });
    return { signal, executed: false, reason: 'same_day_loss_block', lastPnl: reentry.lastPnl };
  }

  const liveGate = await checkLiveEntryGate('swing');
  if (!liveGate.allowed) {
    console.log(`[tradeExecutor] ${liveGate.reason} — blocking entry for ${signal.ticker}`);
    if (liveGate.reason === 'paper_entry_blocked') {
      await logSignal({
        ticker: signal.ticker,
        signalType: signal.signalType,
        result: 'paper_entry_blocked',
        direction: signal.direction,
        confidence: signal.confidence,
        executed: false,
      });
      return { signal, executed: false, reason: 'paper_entry_blocked' };
    }
    await logSignal({
      ticker: signal.ticker,
      signalType: signal.signalType,
      result: 'daily_loss_limit_reached',
      direction: signal.direction,
      confidence: signal.confidence,
      executed: false,
    });
    return { signal, executed: false, reason: liveGate.reason };
  }

  if (!(await canOpenPosition())) {
    const budget = await getSwingBudgetRemaining();
    if (budget <= 0) {
      return { signal, executed: false, reason: 'budget_exhausted', budgetRemaining: budget };
    }
    return { signal, executed: false, reason: 'max_positions' };
  }

  let tradeParams = await buildTradeParams(signal);

  const budgetRemaining = tradeParams.budgetRemaining;

  if (!tradeParams.affordable) {
    return {
      signal,
      executed: false,
      reason: 'budget_exhausted',
      budgetRemaining,
      requiredCost: tradeParams.requiredCost,
      perSlot: tradeParams.perSlot,
      slots: tradeParams.slots,
      openCount: tradeParams.openCount,
    };
  }

  if (tradeParams.totalCost > budgetRemaining) {
    return {
      signal,
      executed: false,
      reason: 'budget_exhausted',
      budgetRemaining,
      requiredCost: tradeParams.totalCost,
      perSlot: tradeParams.perSlot,
      slots: tradeParams.slots,
      openCount: tradeParams.openCount,
    };
  }

  if (state.execution_mode === 'MANUAL') {
    return { signal, executed: false, reason: 'manual_mode', tradeParams };
  }

  return executeTrade(signal, tradeParams);
}

export async function executeTrade(signal, tradeParams) {
  try {
    const environment = await getStrategyEnvironment('swing');
    const order = await placeOptionOrder({
      ticker: tradeParams.ticker,
      direction: tradeParams.direction,
      strike: tradeParams.strike,
      expiration: tradeParams.expiration,
      quantity: tradeParams.quantity,
      premium: tradeParams.premium,
      environment,
      strategy: 'swing',
    });

    const bookedQty = bookedEntryQuantity({
      requestedQuantity: tradeParams.quantity,
      fillQuantity: order.fillQuantity,
    });
    const unfilledSkip = await maybeSkipUnfilledOpenInsert({
      order,
      bookedQty,
      environment,
      strategy: 'swing',
      ticker: tradeParams.ticker,
      direction: tradeParams.direction,
    });
    if (unfilledSkip.skipped) {
      return { signal, executed: false, reason: unfilledSkip.reason, order, tradeParams };
    }
    if (
      !shouldBookConfirmedEntry({
        fillQuantity: order.fillQuantity,
        bookedQuantity: bookedQty,
        fillPrice: order.fillPrice,
        dryRun: order.dryRun,
        simulated: order.simulated,
      })
    ) {
      console.error(
        `[Swing] ${tradeParams.ticker} filled qty=${bookedQty} without a confirmed fill price ` +
          `— refusing to book the selection quote $${tradeParams.premium}`
      );
      return { signal, executed: false, reason: 'entry_fill_price_missing', order, tradeParams };
    }
    const bookedPremium = Number(order.fillPrice);

    const positionId = await insertPosition({
      ticker: tradeParams.ticker,
      direction: tradeParams.direction,
      strike: tradeParams.strike,
      expiration: tradeParams.expiration,
      entry_premium: bookedPremium,
      quantity: bookedQty,
      order_id: order.orderId,
      broker: order.broker || 'schwab',
      signal_type: signal.signalType,
      breakout_level:
        signal.signalType === 'tv_breakout' && Number.isFinite(Number(signal.prev_daily_high))
          ? Number(signal.prev_daily_high)
          : null,
      entry_contracts: bookedQty,
      pyramid_tier: 'ladder',
    });

    await updatePositionPyramidState(positionId, {
      exit_phase: tradeParams.ladderExitPhase,
      trail_peak_pnl_frac: 0,
      contracts_open: bookedQty,
    });

    console.log(
      `[Swing] Opened ${tradeParams.ticker} qty=${bookedQty} ` +
        `(requested=${tradeParams.quantity} filled=${order.fillQuantity ?? 'n/a'}) ` +
        `premium=$${bookedPremium} ladder entry_contracts=${bookedQty}`
    );

    await markSignalExecuted(signal.ticker, signal.signalType);

    return {
      signal,
      executed: true,
      positionId,
      order,
      tradeParams,
    };
  } catch (err) {
    console.error('Trade execution failed:', err.message);
    return { signal, executed: false, reason: 'execution_error', error: err.message };
  }
}

export async function manualClosePosition(position, notifyClose) {
  const { getOptionPremium, closeOptionOrder } = await import('./brokerageConnector.js');
  const { closePosition } = await import('./db.js');

  const exitPremium = await getOptionPremium(
    position.ticker,
    position.direction,
    position.strike,
    position.expiration
  );

  const environment = await getStrategyEnvironment('swing');
  await closeOptionOrder(position, exitPremium, null, { environment, strategy: 'swing' });
  const pnlPct = ((exitPremium - position.entry_premium) / position.entry_premium) * 100;
  await closePosition(position.id, exitPremium, pnlPct, 'manual_close');

  if (notifyClose) {
    await notifyClose(position, 'manual_close', pnlPct / 100, exitPremium);
  }

  return { position, exitPremium, pnlPct };
}

export { SWING_MONTHLY_BUDGET_MAX as MAX_MONTHLY_BUDGET };
