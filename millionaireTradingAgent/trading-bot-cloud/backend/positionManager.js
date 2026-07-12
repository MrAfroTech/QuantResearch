import {
  getBotState,
  getOpenPositions,
  getOpenPositionCount,
  addMonthlySpend,
  closePosition,
} from './db.js';
import {
  fetchQuote,
  findMonthlyExpiration,
  getOptionPremium,
  closeOptionOrder,
} from './brokerageConnector.js';

const MAX_POSITIONS = 3;
const MAX_MONTHLY_BUDGET = 599;
const PROFIT_TARGET_PCT = 0.30;
const STOP_LOSS_PCT = 0.10;

export async function getBudgetRemaining() {
  const state = await getBotState();
  return Math.max(0, MAX_MONTHLY_BUDGET - state.monthly_spend);
}

export async function canOpenPosition() {
  const openCount = await getOpenPositionCount();
  const budgetRemaining = await getBudgetRemaining();
  return openCount < MAX_POSITIONS && budgetRemaining > 0;
}

export async function calculatePositionSize() {
  const openCount = await getOpenPositionCount();
  const slotsAvailable = MAX_POSITIONS - openCount;
  const budgetRemaining = await getBudgetRemaining();

  if (slotsAvailable <= 0 || budgetRemaining <= 0) return 0;

  return budgetRemaining / slotsAvailable;
}

export async function selectStrike(ticker, direction) {
  const { price } = await fetchQuote(ticker);
  const step = ticker === 'VIX' ? 1 : ticker === 'SOFI' ? 0.5 : 1;
  const atm = Math.round(price / step) * step;

  if (direction === 'CALL') {
    return atm + step;
  }
  return atm - step;
}

export async function buildTradeParams(signal) {
  const expiration = await findMonthlyExpiration();
  const strike = await selectStrike(signal.ticker, signal.direction);
  const premium = await getOptionPremium(signal.ticker, signal.direction, strike, expiration);
  const budgetPerSlot = await calculatePositionSize();
  const contractCost = premium * 100;
  const quantity = Math.max(1, Math.floor(budgetPerSlot / contractCost));

  return {
    ticker: signal.ticker,
    direction: signal.direction,
    strike,
    expiration,
    premium,
    quantity,
    totalCost: premium * quantity * 100,
  };
}

export async function monitorOpenPositions(notifyClose) {
  const positions = await getOpenPositions();
  const actions = [];

  for (const position of positions) {
    const currentPremium = await getOptionPremium(
      position.ticker,
      position.direction,
      position.strike,
      position.expiration
    );

    const pnlPct = (currentPremium - position.entry_premium) / position.entry_premium;
    let closeReason = null;

    if (pnlPct >= PROFIT_TARGET_PCT) {
      closeReason = 'profit_target';
    } else if (pnlPct <= -STOP_LOSS_PCT) {
      closeReason = 'stop_loss';
    }

    if (closeReason) {
      await closeOptionOrder(position, currentPremium);
      await closePosition(position.id, currentPremium, pnlPct * 100, closeReason);
      actions.push({ position, closeReason, pnlPct, exitPremium: currentPremium });
      if (notifyClose) {
        await notifyClose(position, closeReason, pnlPct, currentPremium);
      }
    } else {
      actions.push({ position, pnlPct, currentPremium, closeReason: null });
    }
  }

  return actions;
}

export async function getPositionsWithPnL() {
  const positions = await getOpenPositions();
  const enriched = [];

  for (const position of positions) {
    try {
      const currentPremium = await getOptionPremium(
        position.ticker,
        position.direction,
        position.strike,
        position.expiration
      );
      const pnlPct = ((currentPremium - position.entry_premium) / position.entry_premium) * 100;
      enriched.push({ ...position, currentPremium, pnlPct });
    } catch {
      enriched.push({ ...position, currentPremium: null, pnlPct: null });
    }
  }

  return enriched;
}

export async function recordSpend(amount) {
  await addMonthlySpend(amount);
}

export { MAX_POSITIONS, MAX_MONTHLY_BUDGET, PROFIT_TARGET_PCT, STOP_LOSS_PCT };
