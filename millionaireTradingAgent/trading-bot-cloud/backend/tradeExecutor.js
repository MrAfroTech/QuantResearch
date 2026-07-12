import { getBotState, insertPosition, markSignalExecuted } from './db.js';
import { placeOptionOrder } from './brokerageConnector.js';
import {
  canOpenPosition,
  buildTradeParams,
  recordSpend,
  getBudgetRemaining,
  MAX_MONTHLY_BUDGET,
} from './positionManager.js';
import {
  sendTradeOpened,
  sendSignalNotExecuted,
  sendBudgetExhausted,
} from './smsHandler.js';

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
    await sendSignalNotExecuted(signal, `Confidence is ${signal.confidence}, not HIGH`);
    return { signal, executed: false, reason: 'low_confidence' };
  }

  if (!(await canOpenPosition())) {
    const budget = await getBudgetRemaining();
    if (budget <= 0) {
      await sendBudgetExhausted();
      return { signal, executed: false, reason: 'budget_exhausted' };
    }
    await sendSignalNotExecuted(signal, 'Max open positions (3) reached');
    return { signal, executed: false, reason: 'max_positions' };
  }

  const tradeParams = await buildTradeParams(signal);
  const budgetRemaining = await getBudgetRemaining();

  if (tradeParams.totalCost > budgetRemaining) {
    await sendBudgetExhausted();
    return { signal, executed: false, reason: 'insufficient_budget' };
  }

  if (state.execution_mode === 'MANUAL') {
    await sendSignalNotExecuted(signal, 'Bot is in MANUAL mode — awaiting approval');
    return { signal, executed: false, reason: 'manual_mode', tradeParams };
  }

  return executeTrade(signal, tradeParams);
}

export async function executeTrade(signal, tradeParams) {
  try {
    const order = await placeOptionOrder({
      ticker: tradeParams.ticker,
      direction: tradeParams.direction,
      strike: tradeParams.strike,
      expiration: tradeParams.expiration,
      quantity: tradeParams.quantity,
      premium: tradeParams.premium,
    });

    const positionId = await insertPosition({
      ticker: tradeParams.ticker,
      direction: tradeParams.direction,
      strike: tradeParams.strike,
      expiration: tradeParams.expiration,
      entry_premium: tradeParams.premium,
      quantity: tradeParams.quantity,
      order_id: order.orderId,
      broker: order.broker || 'schwab',
    });

    await recordSpend(tradeParams.totalCost);
    await markSignalExecuted(signal.ticker, signal.signalType);

    await sendTradeOpened({
      ...tradeParams,
      orderId: order.orderId,
      paper: order.paper,
    });

    return {
      signal,
      executed: true,
      positionId,
      order,
      tradeParams,
    };
  } catch (err) {
    console.error('Trade execution failed:', err.message);
    await sendSignalNotExecuted(signal, `Execution error: ${err.message}`);
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

  await closeOptionOrder(position, exitPremium);
  const pnlPct = ((exitPremium - position.entry_premium) / position.entry_premium) * 100;
  await closePosition(position.id, exitPremium, pnlPct, 'manual_close');

  if (notifyClose) {
    await notifyClose(position, 'manual_close', pnlPct / 100, exitPremium);
  }

  return { position, exitPremium, pnlPct };
}

export { MAX_MONTHLY_BUDGET };
