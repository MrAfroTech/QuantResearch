import {
  closeOptionOrder,
  getZeroDteOptionObservation,
  cancelBrokerOrder,
  getBrokerOrderStatus,
} from '../brokerageConnector.js';
import {
  getEmaVwapOpenPositions,
  updateEmaVwapPositionExcursion,
  updateEmaVwapPositionPyramidState,
  updateEmaVwapPositionBrokerStop,
  updateEmaVwapPositionPendingClose,
  partialCloseEmaVwapPosition,
  closeEmaVwapPosition,
  logEmaVwapEvent,
} from './emaVwapDb.js';
import { isAtOrAfterTimeStop, isWithinOrbSession, etDateKey } from '../orb/tradierTimesales.js';
import { sendEmaVwapTradeClosedTelegram } from './emaVwapTelegram.js';
import { sendCloseFailedTelegram } from '../telegramHandler.js';
import {
  EMA_VWAP_STOP_LOSS_PCT,
  EMA_VWAP_HARD_STOP_PCT,
  EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE,
  EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON,
} from './emaVwapConfig.js';
import {
  evaluateEmaVwapPartialLockTrail,
  shouldRaiseEmaVwapPartialLockBrokerStop,
  resolveEmaVwapPartialLockStopFillReason,
} from './emaVwapPartialLockTrail.js';
import { handleLadderPositionMonitor, reconcileFilledBrokerStop, submitAndSettleFullClose } from '../ladder/ladderExit.js';
import { createLadderBrokerStopHandlers } from '../ladder/ladderStopOrders.js';
import { kickInitialStopUntilProtected, buildInitialStopRetryExtras } from '../ladder/initialStopRetry.js';
import { settleDbOpenIfBrokerFlat } from '../ladder/brokerFlatSync.js';
import {
  PARTIAL_LOCK_STOP_REPLACE_FAILED,
  buildPartialLockBrokerLiveChecks,
  shouldArmPartialLockBrokerStop,
  syncPartialLockBrokerStopWithRetry,
} from '../ladder/partialLockStopReplace.js';
import { shouldKickInitialStop, isFlattenRetryInFlight } from '../ladder/flattenUntilClosed.js';
import { positionHasConfirmedBrokerLong } from '../ladder/orderFillStatus.js';
import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { LADDER_CLOSE_REASON } from '../ladder/ladderConfig.js';
import {
  clearMfeFailure,
  planExcursionUpdate,
  resolveMonitorPremiums,
  takeMfeFailureEvent,
} from '../ladder/mfePrice.js';

async function notifyEmaVwapClose(position, reason, pnlPct, exitPremium) {
  await sendEmaVwapTradeClosedTelegram({
    ticker: position.ticker,
    reason,
    pnlPct,
  });
  return { position, reason, pnlPct, exitPremium };
}

/**
 * EMA/VWAP hard-stop slippage audit — mirrors ORB/Premarket hard_stop_slippage.
 * Writes to emavwap_event_log only.
 */
async function logEmaVwapHardStopSlippage(position, { exitPremium, pnlFrac, quantity, escalated = false, limitPrice = null, skippedLimitEscalation = false }) {
  const entry = Number(position.entry_premium);
  const fill = Number(exitPremium);
  if (!(entry > 0) || !Number.isFinite(fill)) return;

  const triggerPrice = Math.max(
    0.01,
    Math.round(entry * (1 - EMA_VWAP_HARD_STOP_PCT) * 100) / 100
  );
  const qty = Number(quantity) || Number(position.contracts_open) || Number(position.quantity) || 1;
  const slipDollarsPerContract = fill - triggerPrice;
  const slipDollars = slipDollarsPerContract * 100 * qty;
  const slipPctOfEntry = (fill - triggerPrice) / entry;
  const realizedLossPct = Number.isFinite(pnlFrac) ? pnlFrac : (fill - entry) / entry;
  const didEscalate = escalated === true;
  const didSkipLimit = skippedLimitEscalation === true;

  await logEmaVwapEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType: 'hard_stop_slippage',
    direction: position.direction,
    breakoutLevel: position.vwap_at_entry ?? null,
    details: {
      type: 'hard_stop_slippage',
      position_id: position.id,
      hard_stop_trigger_pct: EMA_VWAP_HARD_STOP_PCT,
      entry_premium: entry,
      trigger_price: triggerPrice,
      limit_price: limitPrice ?? null,
      fill_price: fill,
      quantity: qty,
      slippage_pct_of_entry: slipPctOfEntry,
      slippage_dollars: slipDollars,
      realized_pnl_pct: realizedLossPct,
      escalated: didEscalate,
      skipped_limit_escalation: didSkipLimit,
      strike: position.strike,
      expiration: position.expiration,
    },
  });

  console.log(
    `[EMA/VWAP] hard_stop_slippage ${position.ticker} trigger=$${triggerPrice} ` +
      `limit=$${limitPrice ?? 'n/a'} fill=$${fill} ` +
      `slip=${(slipPctOfEntry * 100).toFixed(2)}% ($${slipDollars.toFixed(2)}) ` +
      `escalated=${didEscalate} skipped_limit_escalation=${didSkipLimit}`
  );
}

async function notifyEmaVwapCloseWithSlippage(position, reason, pnlPct, exitPremium, closeQty, meta) {
  if (reason === LADDER_CLOSE_REASON.HARD_STOP) {
    await logEmaVwapHardStopSlippage(position, {
      exitPremium,
      pnlFrac: pnlPct,
      quantity: closeQty,
      escalated: meta?.escalated === true,
      limitPrice: meta?.hardStopLimitPrice ?? null,
      skippedLimitEscalation: meta?.skippedLimitEscalation === true,
    }).catch((err) => {
      console.warn(`[EMA/VWAP] hard_stop_slippage log failed:`, err.message);
    });
  }
  await notifyEmaVwapClose(position, reason, pnlPct, exitPremium);
}

async function logEmaVwapPartialLockStopReplace(position, {
  peakMfe,
  trailFloor,
  oldTrigger,
  newTrigger,
  oldOrderId,
  newOrderId,
  attempt = null,
}) {
  await logEmaVwapEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType: 'partial_lock_stop_replace',
    direction: position.direction,
    breakoutLevel: position.vwap_at_entry ?? null,
    details: {
      type: 'partial_lock_stop_replace',
      position_id: position.id,
      peak_mfe: peakMfe,
      trail_floor: trailFloor,
      old_trigger_price: oldTrigger,
      new_trigger_price: newTrigger,
      old_broker_order_id: oldOrderId ?? null,
      new_broker_order_id: newOrderId ?? null,
      attempt,
      strike: position.strike,
      expiration: position.expiration,
      entry_premium: position.entry_premium,
    },
  });
}

async function logEmaVwapPartialLockStopReplaceFailed(position, {
  peakMfe,
  trailFloor,
  oldTrigger,
  oldOrderId,
  desiredTrigger,
  reason,
  attempt,
  eventType = PARTIAL_LOCK_STOP_REPLACE_FAILED,
}) {
  await logEmaVwapEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType,
    direction: position.direction,
    breakoutLevel: position.vwap_at_entry ?? null,
    details: {
      type: eventType,
      position_id: position.id,
      peak_mfe: peakMfe,
      trail_floor: trailFloor,
      old_trigger_price: oldTrigger ?? null,
      desired_trigger_price: desiredTrigger ?? null,
      old_broker_order_id: oldOrderId ?? null,
      reason: reason || 'unknown',
      attempt: attempt ?? null,
      strike: position.strike,
      expiration: position.expiration,
      entry_premium: position.entry_premium,
    },
  });
}

async function logEmaVwapMfeObservation(position, details) {
  if (!details) return;
  await logEmaVwapEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType: details.type,
    direction: position.direction,
    breakoutLevel: position.breakout_level,
    details: {
      ...details,
      position_id: position.id,
      strike: position.strike,
      expiration: position.expiration,
    },
  });
}

async function applyEmaVwapExcursion(position, { ratchetPremium, markPremium, selection }) {
  const planned = planExcursionUpdate(position, { ratchetPremium, markPremium, selection });
  if (!planned) return null;
  if (planned.changed) {
    await updateEmaVwapPositionExcursion(position.id, planned.mfeFrac, planned.maeFrac);
    position.mfe_pct = planned.mfeFrac;
    position.mae_pct = planned.maeFrac;
  }
  if (planned.advanceEvent) {
    await logEmaVwapMfeObservation(position, planned.advanceEvent).catch((err) => {
      console.warn(`[EMA/VWAP] mfe_advance event log failed:`, err.message);
    });
  }
  return planned;
}

async function logEmaVwapPartialLockTrailEvent(position, {
  exitPremium,
  peakMfe,
  trailFloor,
  pnlFrac,
  quantity,
}) {
  await logEmaVwapEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType: EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON,
    direction: position.direction,
    breakoutLevel: position.vwap_at_entry ?? null,
    details: {
      type: EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON,
      position_id: position.id,
      activation_mfe: EMA_VWAP_PARTIAL_LOCK_ACTIVATION_MFE,
      peak_mfe: peakMfe,
      trail_floor: trailFloor,
      exit_price: exitPremium,
      pnl_frac: pnlFrac,
      quantity,
      strike: position.strike,
      expiration: position.expiration,
      entry_premium: position.entry_premium,
    },
  });
}

/**
 * Raise the single resting broker stop to peak/2 when that trigger is tighter
 * than the current order (loss-stop or a previous lower floor). Never lowers it.
 * Failures write partial_lock_stop_replace_failed and retry with the shared backoff.
 */
async function syncEmaVwapPartialLockBrokerStop(position, { decision, brokerStop, environment, onNotify }) {
  if (!brokerStop?.enabled || typeof brokerStop.replaceStop !== 'function') return null;
  if (!shouldArmPartialLockBrokerStop(decision)) return null;

  const trailFloor = decision.trailFloor;
  const check = shouldRaiseEmaVwapPartialLockBrokerStop(position, trailFloor);
  if (!check.raise) return null;

  return syncPartialLockBrokerStopWithRetry(position, {
    strategy: 'emavwap',
    trailFloor,
    peakMfe: decision.peakMfe,
    replaceStop: (pos, floor) => brokerStop.replaceStop(pos, floor),
    shouldRaise: shouldRaiseEmaVwapPartialLockBrokerStop,
    getOpenPosition: async () => {
      const open = await getEmaVwapOpenPositions();
      return open.find((p) => Number(p.id) === Number(position.id)) || null;
    },
    ...buildPartialLockBrokerLiveChecks(position, {
      environment,
      strategy: 'emavwap',
      fullClosePosition: closeEmaVwapPosition,
      onNotify,
    }),
    logLabel: 'EMA/VWAP',
    onSuccess: async (payload) => {
      await logEmaVwapPartialLockStopReplace(position, payload).catch((err) => {
        console.warn(`[EMA/VWAP] partial_lock_stop_replace event log failed:`, err.message);
      });
    },
    onFailure: async (payload) => {
      await logEmaVwapPartialLockStopReplaceFailed(position, payload).catch((err) => {
        console.warn(`[EMA/VWAP] ${PARTIAL_LOCK_STOP_REPLACE_FAILED} event log failed:`, err.message);
      });
    },
  });
}

/**
 * Arm peak/2 BEFORE ladder exits so a hard-stop / full-exit continue cannot
 * skip the raise when MFE is already ≥ activation and current pnl is still
 * above the hard ceiling.
 */
async function armEmaVwapPartialLockBeforeLadder(position, {
  currentPremium,
  markPremium = null,
  selection = null,
  brokerStop,
  hardStopPct,
  environment,
  onNotify,
}) {
  const planned = await applyEmaVwapExcursion(position, {
    ratchetPremium: currentPremium,
    markPremium,
    selection,
  });
  if (!planned) return null;

  const decision = evaluateEmaVwapPartialLockTrail({
    pnlFrac: planned.pnlFrac,
    mfeFrac: planned.mfeFrac,
    exitPhase: position.exit_phase,
    hardStopPct,
  });
  if (!shouldArmPartialLockBrokerStop(decision)) return null;
  return syncEmaVwapPartialLockBrokerStop(position, { decision, brokerStop, environment, onNotify });
}

/**
 * EMA/VWAP pre-milestone partial-lock: raise resting stop to peak/2, and
 * poll-close if already through the floor. Caller must run shared ladder first.
 * Returns an action object if closed, else null.
 */
async function tryEmaVwapPartialLockTrailClose(position, {
  currentPremium,
  closePremium = null,
  markPremium = null,
  selection = null,
  environment,
  brokerStop,
}) {
  const planned = await applyEmaVwapExcursion(position, {
    ratchetPremium: currentPremium,
    markPremium: markPremium ?? closePremium,
    selection,
  });
  if (!planned) return null;
  const pnlFrac = planned.pnlFrac;
  const orderPremium = Number.isFinite(Number(closePremium)) ? Number(closePremium) : Number(currentPremium);

  const decision = evaluateEmaVwapPartialLockTrail({
    pnlFrac,
    mfeFrac: planned.mfeFrac,
    exitPhase: position.exit_phase,
    hardStopPct: EMA_VWAP_HARD_STOP_PCT,
  });

  if (decision.action !== 'close_all') {
    if (
      decision.trailFloor != null &&
      decision.inactiveReason !== 'below_activation' &&
      decision.inactiveReason !== 'hard_stop_owns_exit'
    ) {
      await syncEmaVwapPartialLockBrokerStop(position, {
        decision,
        brokerStop,
        environment,
        onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
          await notifyEmaVwapCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
        },
      });
    }
    return null;
  }

  const closeQty = position.contracts_open ?? position.quantity ?? 0;
  if (!(closeQty > 0)) return null;

  const settled = await submitAndSettleFullClose({
    position,
    strategy: 'emavwap',
    closeQty,
    currentPremium: orderPremium,
    pnlFrac,
    intendedReason: EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON,
    isTimeStop: false,
    brokerStop,
    closeBrokerOrder: (pos, exitPremium, quantity) =>
      closeOptionOrder(pos, exitPremium, quantity, { environment, strategy: 'emavwap' }),
    flattenBrokerOrder: (pos, exitPremium, quantity) =>
      closeOptionOrder(pos, exitPremium, quantity, { environment, strategy: 'emavwap' }),
    fullClosePosition: closeEmaVwapPosition,
    cancelExitOrder: (orderId) =>
      cancelBrokerOrder(orderId, { environment, strategy: 'emavwap' }),
    updatePendingClose: updateEmaVwapPositionPendingClose,
    restoreStopPnlFrac: decision.trailFloor,
    getOpenPosition: async () => {
      const open = await getEmaVwapOpenPositions();
      return open.find((p) => Number(p.id) === Number(position.id)) || null;
    },
    onNotify: async (pos, reason, settledPnl, exitPremium) => {
      if (reason === EMA_VWAP_PARTIAL_LOCK_CLOSE_REASON) {
        await logEmaVwapPartialLockTrailEvent(pos, {
          exitPremium,
          peakMfe: decision.peakMfe,
          trailFloor: decision.trailFloor,
          pnlFrac: settledPnl,
          quantity: closeQty,
        }).catch((err) => {
          console.warn(`[EMA/VWAP] partial_lock_trail event log failed:`, err.message);
        });
        console.log(
          `[EMA/VWAP] partial_lock_trail ${pos.ticker} peak=${(decision.peakMfe * 100).toFixed(1)}% ` +
            `floor=${(decision.trailFloor * 100).toFixed(1)}% exit=${(settledPnl * 100).toFixed(1)}% ` +
            `@ $${Number(exitPremium).toFixed(2)}`
        );
      }
      await sendEmaVwapTradeClosedTelegram({
        ticker: pos.ticker,
        reason,
        pnlPct: settledPnl,
      });
    },
  });

  if (settled?.pendingClose) return settled;

  return {
    ...settled,
    peakMfe: decision.peakMfe,
    trailFloor: decision.trailFloor,
    partialLockTrail: true,
  };
}

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
    hardStopPct: EMA_VWAP_HARD_STOP_PCT,
    updateBrokerStopState: updateEmaVwapPositionBrokerStop,
    fullClosePosition: closeEmaVwapPosition,
    onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
      await notifyEmaVwapCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
    },
    resolveCloseReason: ({ position: pos, defaultReason }) =>
      resolveEmaVwapPartialLockStopFillReason({
        position: pos,
        defaultReason,
      }),
  });
  const actions = [];
  const timeStop = isAtOrAfterTimeStop();

  for (const position of positions) {
    if (
      shouldKickInitialStop({
        brokerStopOrderId: position.broker_stop_order_id,
        pendingCloseReason: position.pending_close_reason,
        isTimeStop: timeStop,
        flattenInFlight: isFlattenRetryInFlight(position.id),
      }) &&
      positionHasConfirmedBrokerLong(position)
    ) {
      kickInitialStopUntilProtected(
        brokerStop,
        position,
        buildInitialStopRetryExtras({
          strategy: 'emavwap',
          position,
          getOpenPositions: getEmaVwapOpenPositions,
          environment,
          fullClosePosition: closeEmaVwapPosition,
          onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
            await notifyEmaVwapCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
          },
        })
      );
    }

    // Filled protective stop is detected from broker_stop_order_id, not the option quote.
    let stopReconcile = { booked: null };
    try {
      stopReconcile = await reconcileFilledBrokerStop(position, brokerStop);
    } catch (err) {
      console.warn(`[EMA/VWAP] Broker stop fill check failed for ${position.ticker}:`, err.message);
    }
    if (stopReconcile?.booked) {
      actions.push(stopReconcile.booked);
      continue;
    }

    let observation;
    try {
      observation = await getZeroDteOptionObservation(
        position.ticker,
        position.direction,
        position.strike,
        position.expiration
      );
    } catch (err) {
      console.warn(`[EMA/VWAP] Premium lookup failed for ${position.ticker}:`, err.message);
      const failed = takeMfeFailureEvent(`emavwap:${position.id}`, err.message);
      if (failed) {
        await logEmaVwapMfeObservation(position, failed).catch((logErr) => {
          console.warn(`[EMA/VWAP] mfe_observation_failed event log failed:`, logErr.message);
        });
      }
      continue;
    }

    const premiums = resolveMonitorPremiums(observation);
    if (premiums.ladderPremium == null && premiums.ratchetPremium == null) {
      console.warn(`[EMA/VWAP] Premium lookup failed for ${position.ticker}: no quote`);
      const failed = takeMfeFailureEvent(`emavwap:${position.id}`, observation.error || 'no_mfe_price');
      if (failed) {
        await logEmaVwapMfeObservation(position, failed).catch((logErr) => {
          console.warn(`[EMA/VWAP] mfe_observation_failed event log failed:`, logErr.message);
        });
      }
      continue;
    }
    if (premiums.quoteMissing) {
      const failed = takeMfeFailureEvent(
        `emavwap:${position.id}`,
        observation.error || observation.reason || 'quote_fields_unavailable'
      );
      if (failed) {
        await logEmaVwapMfeObservation(position, failed).catch((logErr) => {
          console.warn(`[EMA/VWAP] mfe_observation_failed event log failed:`, logErr.message);
        });
      }
    } else {
      clearMfeFailure(`emavwap:${position.id}`);
    }
    const currentPremium = premiums.ladderPremium ?? premiums.ratchetPremium;
    const ratchetPremium = premiums.ratchetPremium ?? currentPremium;

    try {
      if (!timeStop) {
        await armEmaVwapPartialLockBeforeLadder(position, {
          currentPremium: ratchetPremium,
          markPremium: currentPremium,
          selection: observation,
          brokerStop,
          hardStopPct: EMA_VWAP_HARD_STOP_PCT,
          environment,
          onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
            await notifyEmaVwapCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
          },
        });
      }
      const mfeLockedByRatchet = timeStop ? null : (Number(position.mfe_pct) || 0);

      const action = await handleLadderPositionMonitor(position, {
        strategy: 'emavwap',
        currentPremium,
        initialStopPct: EMA_VWAP_STOP_LOSS_PCT,
        hardStopPct: EMA_VWAP_HARD_STOP_PCT,
        isTimeStop: timeStop,
        fullPositionExits: true,
        updateExcursion: updateEmaVwapPositionExcursion,
        updateLadderState: updateEmaVwapPositionPyramidState,
        partialCloseLeg: partialCloseEmaVwapPosition,
        fullClosePosition: closeEmaVwapPosition,
        closeBrokerOrder: (position, exitPremium, quantity, closeOpts) =>
          closeOptionOrder(position, exitPremium, quantity, {
            environment,
            strategy: 'emavwap',
            ...closeOpts,
          }),
        flattenBrokerOrder: (position, exitPremium, quantity) =>
          closeOptionOrder(position, exitPremium, quantity, { environment, strategy: 'emavwap' }),
        cancelExitOrder: (orderId) =>
          cancelBrokerOrder(orderId, { environment, strategy: 'emavwap' }),
        getExitOrderStatus: (orderId) =>
          getBrokerOrderStatus(orderId, { environment, strategy: 'emavwap' }),
        updatePendingClose: updateEmaVwapPositionPendingClose,
        getOpenPosition: async () => {
          const open = await getEmaVwapOpenPositions();
          return open.find((p) => Number(p.id) === Number(position.id)) || null;
        },
        brokerStop,
        onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
          await notifyEmaVwapCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
        },
        settleIfBrokerFlat: (pos) =>
          settleDbOpenIfBrokerFlat(pos, {
            environment,
            strategy: 'emavwap',
            fullClosePosition: closeEmaVwapPosition,
            onNotify: async (p, reason, pnlPct, exitPremium, closeQty, meta) => {
              await notifyEmaVwapCloseWithSlippage(p, reason, pnlPct, exitPremium, closeQty, meta);
            },
          }),
      });

      if (
        mfeLockedByRatchet != null &&
        (Number(position.mfe_pct) || 0) > mfeLockedByRatchet + 1e-12
      ) {
        await updateEmaVwapPositionExcursion(position.id, mfeLockedByRatchet, position.mae_pct);
        position.mfe_pct = mfeLockedByRatchet;
      }

      if (action?.reason || action?.skipped || action?.pendingClose) {
        actions.push(action);
        continue;
      }

      if (!timeStop) {
        const partialLockAction = await tryEmaVwapPartialLockTrailClose(position, {
          currentPremium: ratchetPremium,
          closePremium: currentPremium,
          markPremium: currentPremium,
          selection: observation,
          environment,
          brokerStop,
        });
        if (partialLockAction) {
          actions.push(partialLockAction);
          continue;
        }
      }

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
