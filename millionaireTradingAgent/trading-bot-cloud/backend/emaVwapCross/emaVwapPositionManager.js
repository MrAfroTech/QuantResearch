import { closeOptionOrder, getOptionPremium } from '../brokerageConnector.js';
import {
  getEmaVwapOpenPositions,
  updateEmaVwapPositionExcursion,
  updateEmaVwapPositionPyramidState,
  updateEmaVwapPositionBrokerStop,
  partialCloseEmaVwapPosition,
  closeEmaVwapPosition,
} from './emaVwapDb.js';
import { isAtOrAfterTimeStop, isWithinOrbSession } from '../orb/tradierTimesales.js';
import { sendEmaVwapTradeClosedTelegram } from './emaVwapTelegram.js';
import { sendCloseFailedTelegram } from '../telegramHandler.js';
import { EMA_VWAP_STOP_LOSS_PCT } from './emaVwapConfig.js';
import { handleLadderPositionMonitor } from '../ladder/ladderExit.js';
import { createLadderBrokerStopHandlers } from '../ladder/ladderStopOrders.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';

export async function monitorEmaVwapPositions() {
  if (!isWithinOrbSession() && !isAtOrAfterTimeStop()) {
    return [];
  }

  const positions = await getEmaVwapOpenPositions();
  const environment = await getStrategyEnvironment('emavwap');
  const brokerStop = createLadderBrokerStopHandlers({
    strategy: 'emavwap',
    environment,
    initialStopPct: EMA_VWAP_STOP_LOSS_PCT,
    updateBrokerStopState: updateEmaVwapPositionBrokerStop,
    fullClosePosition: closeEmaVwapPosition,
    onNotify: async (pos, reason, pnlPct) => {
      await sendEmaVwapTradeClosedTelegram({
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
      console.warn(`[EMA/VWAP] Premium lookup failed for ${position.ticker}:`, err.message);
      continue;
    }

    try {
      const action = await handleLadderPositionMonitor(position, {
        currentPremium,
        initialStopPct: EMA_VWAP_STOP_LOSS_PCT,
        isTimeStop: timeStop,
        updateExcursion: updateEmaVwapPositionExcursion,
        updateLadderState: updateEmaVwapPositionPyramidState,
        partialCloseLeg: partialCloseEmaVwapPosition,
        fullClosePosition: closeEmaVwapPosition,
        closeBrokerOrder: (position, exitPremium, quantity) =>
          closeOptionOrder(position, exitPremium, quantity, { environment, strategy: 'emavwap' }),
        brokerStop,
        onNotify: async (pos, reason, pnlPct) => {
          await sendEmaVwapTradeClosedTelegram({
            ticker: pos.ticker,
            reason,
            pnlPct,
          });
        },
      });
      actions.push(action);
    } catch (err) {
      console.error(`[EMA/VWAP] Close failed for ${position.ticker}:`, err.message);
      await sendCloseFailedTelegram({
        strategy: 'emavwap',
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
