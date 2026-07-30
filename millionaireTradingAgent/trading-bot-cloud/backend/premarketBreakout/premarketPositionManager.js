import { closeOptionOrder, getOptionPremium } from '../brokerageConnector.js';
import {
  getPremarketOpenPositions,
  updatePremarketPositionExcursion,
  updatePremarketPositionPyramidState,
  updatePremarketPositionBrokerStop,
  partialClosePremarketPosition,
  closePremarketPosition,
} from './premarketDb.js';
import { isAtOrAfterTimeStop, isWithinPremarketSession } from './premarketRangeState.js';
import { sendPremarketTradeClosedTelegram } from './premarketTelegram.js';
import { sendCloseFailedTelegram } from '../telegramHandler.js';
import { PREMARKET_STOP_LOSS_PCT } from './premarketConfig.js';
import { handleLadderPositionMonitor } from '../ladder/ladderExit.js';
import { createLadderBrokerStopHandlers } from '../ladder/ladderStopOrders.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';

export async function monitorPremarketPositions() {
  if (!isWithinPremarketSession() && !isAtOrAfterTimeStop()) {
    return [];
  }

  const positions = await getPremarketOpenPositions();
  const environment = await getStrategyEnvironment('premarket');
  const brokerStop = createLadderBrokerStopHandlers({
    strategy: 'premarket',
    environment,
    initialStopPct: PREMARKET_STOP_LOSS_PCT,
    updateBrokerStopState: updatePremarketPositionBrokerStop,
    fullClosePosition: closePremarketPosition,
    onNotify: async (pos, reason, pnlPct) => {
      await sendPremarketTradeClosedTelegram({
        ticker: pos.ticker,
        reason,
        pnlPct,
      });
    },
  });
  const actions = [];
  const timeStop = isAtOrAfterTimeStop();

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
      console.warn(`[Premarket] Premium lookup failed for ${position.ticker}:`, err.message);
      continue;
    }

    try {
      const action = await handleLadderPositionMonitor(position, {
        currentPremium,
        initialStopPct: PREMARKET_STOP_LOSS_PCT,
        isTimeStop: timeStop,
        updateExcursion: updatePremarketPositionExcursion,
        updateLadderState: updatePremarketPositionPyramidState,
        partialCloseLeg: partialClosePremarketPosition,
        fullClosePosition: closePremarketPosition,
        closeBrokerOrder: (position, exitPremium, quantity) =>
          closeOptionOrder(position, exitPremium, quantity, { environment, strategy: 'premarket' }),
        brokerStop,
        onNotify: async (pos, reason, pnlPct) => {
          await sendPremarketTradeClosedTelegram({
            ticker: pos.ticker,
            reason,
            pnlPct,
          });
        },
      });
      actions.push(action);
    } catch (err) {
      console.error(`[Premarket] Close failed for ${position.ticker}:`, err.message);
      await sendCloseFailedTelegram({
        strategy: 'premarket',
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
