import { closeOptionOrder, getOptionPremium } from '../brokerageConnector.js';
import {
  getOrbOpenPositions,
  updateOrbPositionExcursion,
  updateOrbPositionPyramidState,
  updateOrbPositionBrokerStop,
  partialCloseOrbPosition,
  closeOrbPosition,
} from './orbDb.js';
import { isAtOrAfterTimeStop, isWithinOrbSession } from './tradierTimesales.js';
import { sendOrbTradeClosedTelegram } from './orbTelegram.js';
import { sendCloseFailedTelegram } from '../telegramHandler.js';
import { ORB_STOP_LOSS_PCT } from './orbConfig.js';
import { handleLadderPositionMonitor } from '../ladder/ladderExit.js';
import { createLadderBrokerStopHandlers } from '../ladder/ladderStopOrders.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';

async function notifyOrbClose(position, reason, pnlPct, exitPremium) {
  await sendOrbTradeClosedTelegram({
    ticker: position.ticker,
    reason,
    pnlPct,
  });
  return { position, reason, pnlPct, exitPremium };
}

export async function monitorOrbPositions() {
  if (!isWithinOrbSession() && !isAtOrAfterTimeStop()) {
    return [];
  }

  const positions = await getOrbOpenPositions();
  const environment = await getStrategyEnvironment('orb');
  const brokerStop = createLadderBrokerStopHandlers({
    strategy: 'orb',
    environment,
    initialStopPct: ORB_STOP_LOSS_PCT,
    updateBrokerStopState: updateOrbPositionBrokerStop,
    fullClosePosition: closeOrbPosition,
    onNotify: async (pos, reason, pnlPct, exitPremium) => {
      await notifyOrbClose(pos, reason, pnlPct, exitPremium);
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
      console.warn(`[ORB] Premium lookup failed for ${position.ticker}:`, err.message);
      continue;
    }

    try {
      const action = await handleLadderPositionMonitor(position, {
        currentPremium,
        initialStopPct: ORB_STOP_LOSS_PCT,
        isTimeStop: timeStop,
        updateExcursion: updateOrbPositionExcursion,
        updateLadderState: updateOrbPositionPyramidState,
        partialCloseLeg: partialCloseOrbPosition,
        fullClosePosition: closeOrbPosition,
        closeBrokerOrder: (position, exitPremium, quantity) =>
          closeOptionOrder(position, exitPremium, quantity, { environment, strategy: 'orb' }),
        brokerStop,
        onNotify: async (pos, reason, pnlPct, exitPremium) => {
          await notifyOrbClose(pos, reason, pnlPct, exitPremium);
        },
      });
      actions.push(action);
    } catch (err) {
      console.error(`[ORB] Close failed for ${position.ticker}:`, err.message);
      await sendCloseFailedTelegram({
        strategy: 'orb',
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
