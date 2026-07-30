import {
  LADDER_INITIAL_STOP_PCT,
  LADDER_MILESTONES_PCT,
  LADDER_CLOSE_REASON,
  ladderExitPhase,
  parseLadderMilestonesCompleted,
  getLadderSellSchedule,
} from './ladderConfig.js';

/**
 * Ratcheting ladder exit — one action per evaluation (stepped floor, not distance trail).
 */
export function evaluateLadderExit({
  pnlFrac,
  exitPhase,
  contractsOpen,
  entryContracts,
  ratchetStopFrac,
  initialStopPct = LADDER_INITIAL_STOP_PCT,
  isTimeStop = false,
  skipPollStops = false,
}) {
  const open = Number(contractsOpen) || 0;
  if (open <= 0) return { action: 'hold' };

  if (isTimeStop) {
    return { action: 'close_all', reason: LADDER_CLOSE_REASON.TIME_STOP, contracts: open };
  }

  const entrySize = Math.min(5, Math.max(1, Number(entryContracts) || open));
  const sellSchedule = getLadderSellSchedule(entrySize);
  const milestonesCompleted = parseLadderMilestonesCompleted(exitPhase);
  const ratchetStop =
    milestonesCompleted > 0
      ? LADDER_MILESTONES_PCT[milestonesCompleted - 1]
      : (Number(ratchetStopFrac) > 0 ? Number(ratchetStopFrac) : null);

  const stopPct = Number(initialStopPct);
  const effectiveStop =
    Number.isFinite(stopPct) && stopPct > 0 ? stopPct : LADDER_INITIAL_STOP_PCT;

  if (!skipPollStops && milestonesCompleted === 0 && pnlFrac <= -effectiveStop) {
    return { action: 'close_all', reason: LADDER_CLOSE_REASON.STOP_LOSS, contracts: open };
  }

  if (!skipPollStops && milestonesCompleted > 0 && ratchetStop != null && pnlFrac <= ratchetStop) {
    return {
      action: 'close_all',
      reason: LADDER_CLOSE_REASON.TRAILING_STOP,
      contracts: open,
    };
  }

  if (milestonesCompleted < sellSchedule.length) {
    const milestonePct = LADDER_MILESTONES_PCT[milestonesCompleted];
    if (pnlFrac >= milestonePct) {
      const sellQty = Math.min(sellSchedule[milestonesCompleted], open);
      const isFinalMilestone = milestonesCompleted === sellSchedule.length - 1;
      const reason = isFinalMilestone
        ? LADDER_CLOSE_REASON.PROFIT_TARGET
        : LADDER_CLOSE_REASON.SCALE_OUT;

      if (sellQty >= open) {
        return { action: 'close_all', reason, contracts: open };
      }

      return {
        action: 'scale_out',
        reason,
        contracts: sellQty,
        nextMilestonesCompleted: milestonesCompleted + 1,
        ratchetStopFrac: milestonePct,
      };
    }
  }

  return { action: 'hold' };
}

export async function handleLadderPositionMonitor(position, {
  currentPremium,
  initialStopPct = LADDER_INITIAL_STOP_PCT,
  isTimeStop = false,
  updateExcursion,
  updateLadderState,
  partialCloseLeg,
  fullClosePosition,
  closeBrokerOrder,
  onNotify,
  brokerStop = null,
}) {
  const brokerStopActive = !!(brokerStop?.enabled && position.broker_stop_order_id);
  let skipPollStops = brokerStopActive;

  if (brokerStop?.enabled && position.broker_stop_order_id) {
    const fill = await brokerStop.checkFill(position);
    if (fill?.filled) {
      return brokerStop.onStopFilled(position, fill);
    }
    if (fill?.status?.isTerminal && !fill?.filled && brokerStop.clearStopState) {
      await brokerStop.clearStopState(position);
      position.broker_stop_order_id = null;
      skipPollStops = false;
    }
  }

  const entry = Number(position.entry_premium);
  if (!Number.isFinite(entry) || entry <= 0) {
    return { position, skipped: true, reason: 'invalid_entry' };
  }

  const pnlFrac = (currentPremium - entry) / entry;
  const mfePct = Math.max(Number(position.mfe_pct) || 0, pnlFrac);
  const maePct = Math.min(Number(position.mae_pct) || 0, pnlFrac);

  if (mfePct !== position.mfe_pct || maePct !== position.mae_pct) {
    await updateExcursion(position.id, mfePct, maePct);
    position.mfe_pct = mfePct;
    position.mae_pct = maePct;
  }

  const contractsOpen = position.contracts_open ?? position.quantity ?? 0;
  const entryContracts = position.entry_contracts ?? contractsOpen;

  const decision = evaluateLadderExit({
    pnlFrac,
    exitPhase: position.exit_phase,
    contractsOpen,
    entryContracts,
    ratchetStopFrac: position.trail_peak_pnl_frac,
    initialStopPct,
    isTimeStop,
    skipPollStops,
  });

  if (decision.action === 'hold') {
    return { position, pnlFrac, currentPremium, closeReason: null };
  }

  if (decision.action === 'scale_out') {
    const closeQty = decision.contracts;
    if (brokerStopActive) {
      await brokerStop.cancelStop(position);
    }
    const closeResult = await closeBrokerOrder(position, currentPremium, closeQty);
    if (closeResult?.noBrokerPosition) {
      await fullClosePosition(
        position.id,
        currentPremium,
        0,
        closeResult.reason || 'entry_unfilled_cancelled',
        closeQty
      );
      if (onNotify) {
        await onNotify(
          position,
          closeResult.reason || 'entry_unfilled_cancelled',
          0,
          currentPremium,
          closeQty
        );
      }
      return {
        position,
        reason: closeResult.reason || 'entry_unfilled_cancelled',
        pnlFrac: 0,
        exitPremium: currentPremium,
        contractsClosed: closeQty,
        noBrokerPosition: true,
      };
    }
    await partialCloseLeg(position.id, currentPremium, pnlFrac * 100, decision.reason, closeQty, {
      exit_phase: ladderExitPhase(decision.nextMilestonesCompleted),
      trail_peak_pnl_frac: decision.ratchetStopFrac,
      contracts_open: contractsOpen - closeQty,
      quantity: (Number(position.quantity) || contractsOpen) - closeQty,
    });
    if (brokerStop?.enabled) {
      const updatedPosition = {
        ...position,
        exit_phase: ladderExitPhase(decision.nextMilestonesCompleted),
        trail_peak_pnl_frac: decision.ratchetStopFrac,
        contracts_open: contractsOpen - closeQty,
        quantity: (Number(position.quantity) || contractsOpen) - closeQty,
        broker_stop_order_id: null,
      };
      await brokerStop.replaceStop(updatedPosition, decision.ratchetStopFrac);
    }
    if (onNotify) {
      await onNotify(position, decision.reason, pnlFrac, currentPremium, closeQty);
    }
    return {
      position,
      reason: decision.reason,
      pnlFrac,
      exitPremium: currentPremium,
      contractsClosed: closeQty,
    };
  }

  if (decision.action === 'close_all') {
    const closeQty = decision.contracts;
    if (brokerStopActive) {
      await brokerStop.cancelStop(position);
    }
    const closeResult = await closeBrokerOrder(position, currentPremium, closeQty);
    if (closeResult?.noBrokerPosition) {
      await fullClosePosition(
        position.id,
        currentPremium,
        0,
        closeResult.reason || 'entry_unfilled_cancelled',
        closeQty
      );
      if (onNotify) {
        await onNotify(
          position,
          closeResult.reason || 'entry_unfilled_cancelled',
          0,
          currentPremium,
          closeQty
        );
      }
      return {
        position,
        reason: closeResult.reason || 'entry_unfilled_cancelled',
        pnlFrac: 0,
        exitPremium: currentPremium,
        contractsClosed: closeQty,
        noBrokerPosition: true,
      };
    }
    await fullClosePosition(position.id, currentPremium, pnlFrac * 100, decision.reason, closeQty);
    if (onNotify) {
      await onNotify(position, decision.reason, pnlFrac, currentPremium, closeQty);
    }
    return {
      position,
      reason: decision.reason,
      pnlFrac,
      exitPremium: currentPremium,
      contractsClosed: closeQty,
    };
  }

  return { position, pnlFrac, currentPremium, closeReason: null };
}
