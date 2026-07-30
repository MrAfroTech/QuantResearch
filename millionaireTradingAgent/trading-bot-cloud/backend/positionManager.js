import {
  getBotState,
  getOpenPositions,
  getOpenPositionCount,
  closePosition,
  updatePositionExcursion,
  updatePositionPyramidState,
  partialClosePosition,
} from './db.js';
import {
  fetchQuote,
  findMonthlyExpiration,
  getOptionPremium,
  closeOptionOrder,
} from './brokerageConnector.js';
import {
  getSwingBudgetRemaining,
  getSwingTotalAllocated,
  SWING_WEEKLY_TOP_OFF,
} from './budget/budgetAllocations.js';
import { ladderPositionSize } from './ladder/ladderSizing.js';
import { ladderExitPhase, LADDER_MILESTONES_PCT } from './ladder/ladderConfig.js';
import { handleLadderPositionMonitor } from './ladder/ladderExit.js';
import { getStrategyEnvironment } from './strategyEnvironment.js';
import { sendCloseFailedTelegram } from './telegramHandler.js';

const MAX_POSITIONS = 3;
const STOP_LOSS_PCT = 0.10;

export async function getBudgetRemaining() {
  return getSwingBudgetRemaining();
}

export async function getMaxMonthlyBudget() {
  return getSwingTotalAllocated();
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
  const expiration = await findMonthlyExpiration(signal.ticker);
  const strike = await selectStrike(signal.ticker, signal.direction);
  const premium = await getOptionPremium(signal.ticker, signal.direction, strike, expiration);
  const budgetPerSlot = await calculatePositionSize();
  const budgetRemaining = await getBudgetRemaining();
  const sizing = ladderPositionSize(budgetPerSlot, premium);
  const quantity = sizing.quantity;
  const totalCost = sizing.totalCost;

  return {
    ticker: signal.ticker,
    direction: signal.direction,
    strike,
    expiration,
    premium,
    quantity,
    totalCost,
    requiredCost: sizing.requiredCost,
    affordable: sizing.affordable && quantity > 0 && totalCost <= budgetRemaining,
    entryContracts: sizing.entryContracts,
    ladderExitPhase: ladderExitPhase(0),
  };
}

export async function monitorOpenPositions(notifyClose) {
  const positions = await getOpenPositions();
  const environment = await getStrategyEnvironment('swing');
  const actions = [];

  for (const position of positions) {
    let currentPremium;
    try {
      currentPremium = await getOptionPremium(
        position.ticker,
        position.direction,
        position.strike,
        position.expiration
      );
    } catch (err) {
      console.warn(`[Swing] Premium lookup failed for ${position.ticker}:`, err.message);
      continue;
    }

    try {
      const action = await handleLadderPositionMonitor(position, {
        currentPremium,
        initialStopPct: STOP_LOSS_PCT,
        isTimeStop: false,
        updateExcursion: updatePositionExcursion,
        updateLadderState: updatePositionPyramidState,
        partialCloseLeg: partialClosePosition,
        fullClosePosition: closePosition,
        closeBrokerOrder: (position, exitPremium, quantity) =>
          closeOptionOrder(position, exitPremium, quantity, { environment, strategy: 'swing' }),
        onNotify: notifyClose
          ? async (pos, reason, pnlFrac, exitPremium) => {
              await notifyClose(pos, reason, pnlFrac, exitPremium);
            }
          : null,
      });
      actions.push(action);
    } catch (err) {
      console.error(`[Swing] Close failed for ${position.ticker}:`, err.message);
      await sendCloseFailedTelegram({
        strategy: 'swing',
        positionId: position.id,
        ticker: position.ticker,
        direction: position.direction,
        strike: position.strike,
        error: err.message,
      }).catch(() => {});
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

export { MAX_POSITIONS, SWING_WEEKLY_TOP_OFF as MAX_MONTHLY_BUDGET, STOP_LOSS_PCT };
/** Top ladder milestone — retained for analytics/diagnosis references. */
export const PROFIT_TARGET_PCT = LADDER_MILESTONES_PCT[LADDER_MILESTONES_PCT.length - 1];
