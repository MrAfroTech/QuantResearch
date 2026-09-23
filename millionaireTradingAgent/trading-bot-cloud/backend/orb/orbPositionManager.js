import { closeOptionOrder, getOptionPremium, cancelBrokerOrder, getBrokerOrderStatus } from '../brokerageConnector.js';
import {
  getOrbOpenPositions,
  updateOrbPositionExcursion,
  updateOrbPositionPyramidState,
  updateOrbPositionBrokerStop,
  updateOrbPositionPendingClose,
  partialCloseOrbPosition,
  closeOrbPosition,
  logOrbEvent,
} from './orbDb.js';
import { isAtOrAfterTimeStop, isWithinOrbSession, etDateKey } from './tradierTimesales.js';
import { sendOrbTradeClosedTelegram } from './orbTelegram.js';
import { sendCloseFailedTelegram } from '../telegramHandler.js';
import {
  ORB_STOP_LOSS_PCT,
  ORB_HARD_STOP_PCT,
  ORB_PARTIAL_LOCK_ACTIVATION_MFE,
  ORB_PARTIAL_LOCK_CLOSE_REASON,
} from './orbConfig.js';
import {
  evaluateOrbPartialLockTrail,
  shouldRaiseOrbPartialLockBrokerStop,
  resolveOrbPartialLockStopFillReason,
} from './orbPartialLockTrail.js';
import { handleLadderPositionMonitor, submitAndSettleFullClose } from '../ladder/ladderExit.js';
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

async function notifyOrbClose(position, reason, pnlPct, exitPremium) {
  await sendOrbTradeClosedTelegram({
    ticker: position.ticker,
    reason,
    pnlPct,
  });
  return { position, reason, pnlPct, exitPremium };
}

/**
 * ORB hard-stop slippage audit — mirrors Premarket's hard_stop_slippage event.
 * Writes to orb_event_log only.
 */
async function logOrbHardStopSlippage(position, { exitPremium, pnlFrac, quantity, escalated = false, limitPrice = null, skippedLimitEscalation = false }) {
  const entry = Number(position.entry_premium);
  const fill = Number(exitPremium);
  if (!(entry > 0) || !Number.isFinite(fill)) return;

  const triggerPrice = Math.max(
    0.01,
    Math.round(entry * (1 - ORB_HARD_STOP_PCT) * 100) / 100
  );
  const qty = Number(quantity) || Number(position.contracts_open) || Number(position.quantity) || 1;
  const slipDollarsPerContract = fill - triggerPrice;
  const slipDollars = slipDollarsPerContract * 100 * qty;
  const slipPctOfEntry = (fill - triggerPrice) / entry;
  const realizedLossPct = Number.isFinite(pnlFrac) ? pnlFrac : (fill - entry) / entry;
  const didEscalate = escalated === true;
  const didSkipLimit = skippedLimitEscalation === true;

  await logOrbEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType: 'hard_stop_slippage',
    direction: position.direction,
    breakoutLevel: position.breakout_level,
    details: {
      type: 'hard_stop_slippage',
      position_id: position.id,
      hard_stop_trigger_pct: ORB_HARD_STOP_PCT,
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
    `[ORB] hard_stop_slippage ${position.ticker} trigger=$${triggerPrice} ` +
      `limit=$${limitPrice ?? 'n/a'} fill=$${fill} ` +
      `slip=${(slipPctOfEntry * 100).toFixed(2)}% ($${slipDollars.toFixed(2)}) ` +
      `escalated=${didEscalate} skipped_limit_escalation=${didSkipLimit}`
  );
}

async function notifyOrbCloseWithSlippage(position, reason, pnlPct, exitPremium, closeQty, meta) {
  if (reason === LADDER_CLOSE_REASON.HARD_STOP) {
    await logOrbHardStopSlippage(position, {
      exitPremium,
      pnlFrac: pnlPct,
      quantity: closeQty,
      escalated: meta?.escalated === true,
      limitPrice: meta?.hardStopLimitPrice ?? null,
      skippedLimitEscalation: meta?.skippedLimitEscalation === true,
    }).catch((err) => {
      console.warn(`[ORB] hard_stop_slippage log failed:`, err.message);
    });
  }
  await notifyOrbClose(position, reason, pnlPct, exitPremium);
}

async function logOrbPartialLockStopReplace(position, {
  peakMfe,
  trailFloor,
  oldTrigger,
  newTrigger,
  oldOrderId,
  newOrderId,
  attempt = null,
}) {
  await logOrbEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType: 'partial_lock_stop_replace',
    direction: position.direction,
    breakoutLevel: position.breakout_level,
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

async function logOrbPartialLockStopReplaceFailed(position, {
  peakMfe,
  trailFloor,
  oldTrigger,
  oldOrderId,
  desiredTrigger,
  reason,
  attempt,
  eventType = PARTIAL_LOCK_STOP_REPLACE_FAILED,
}) {
  await logOrbEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType,
    direction: position.direction,
    breakoutLevel: position.breakout_level,
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

async function logOrbPartialLockTrailEvent(position, {
  exitPremium,
  peakMfe,
  trailFloor,
  pnlFrac,
  quantity,
}) {
  await logOrbEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType: ORB_PARTIAL_LOCK_CLOSE_REASON,
    direction: position.direction,
    breakoutLevel: position.breakout_level,
    details: {
      type: ORB_PARTIAL_LOCK_CLOSE_REASON,
      position_id: position.id,
      activation_mfe: ORB_PARTIAL_LOCK_ACTIVATION_MFE,
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
 * Failures write partial_lock_stop_replace_failed and retry with e1311e9 backoff.
 */
async function syncOrbPartialLockBrokerStop(position, { decision, brokerStop, environment, onNotify }) {
  if (!brokerStop?.enabled || typeof brokerStop.replaceStop !== 'function') return null;
  if (!shouldArmPartialLockBrokerStop(decision)) return null;

  const trailFloor = decision.trailFloor;
  const check = shouldRaiseOrbPartialLockBrokerStop(position, trailFloor);
  if (!check.raise) return null;

  return syncPartialLockBrokerStopWithRetry(position, {
    strategy: 'orb',
    trailFloor,
    peakMfe: decision.peakMfe,
    replaceStop: (pos, floor) => brokerStop.replaceStop(pos, floor),
    shouldRaise: shouldRaiseOrbPartialLockBrokerStop,
    getOpenPosition: async () => {
      const open = await getOrbOpenPositions();
      return open.find((p) => Number(p.id) === Number(position.id)) || null;
    },
    ...buildPartialLockBrokerLiveChecks(position, {
      environment,
      strategy: 'orb',
      fullClosePosition: closeOrbPosition,
      onNotify,
    }),
    logLabel: 'ORB',
    onSuccess: async (payload) => {
      await logOrbPartialLockStopReplace(position, payload).catch((err) => {
        console.warn(`[ORB] partial_lock_stop_replace event log failed:`, err.message);
      });
    },
    onFailure: async (payload) => {
      await logOrbPartialLockStopReplaceFailed(position, payload).catch((err) => {
        console.warn(`[ORB] ${PARTIAL_LOCK_STOP_REPLACE_FAILED} event log failed:`, err.message);
      });
    },
  });
}

/**
 * Arm peak/2 BEFORE ladder exits so a hard-stop / scale-out continue cannot
 * skip the raise when MFE is already ≥ activation and current pnl is still
 * above the hard ceiling.
 */
async function armOrbPartialLockBeforeLadder(position, {
  currentPremium,
  brokerStop,
  hardStopPct,
  environment,
  onNotify,
}) {
  const entry = Number(position.entry_premium);
  if (!(entry > 0) || !Number.isFinite(Number(currentPremium))) return null;

  const pnlFrac = (Number(currentPremium) - entry) / entry;
  const mfeFrac = Math.max(Number(position.mfe_pct) || 0, pnlFrac);
  const maeFrac = Math.min(Number(position.mae_pct) || 0, pnlFrac);
  if (mfeFrac !== position.mfe_pct || maeFrac !== position.mae_pct) {
    await updateOrbPositionExcursion(position.id, mfeFrac, maeFrac);
    position.mfe_pct = mfeFrac;
    position.mae_pct = maeFrac;
  }

  const decision = evaluateOrbPartialLockTrail({
    pnlFrac,
    mfeFrac,
    exitPhase: position.exit_phase,
    hardStopPct,
  });
  if (!shouldArmPartialLockBrokerStop(decision)) return null;
  return syncOrbPartialLockBrokerStop(position, { decision, brokerStop, environment, onNotify });
}

/**
 * ORB-only pre-milestone partial-lock: raise resting stop to peak/2, and
 * poll-close if already through the floor. Caller must run shared ladder first.
 * Returns an action object if closed, else null.
 */
async function tryOrbPartialLockTrailClose(position, {
  currentPremium,
  environment,
  brokerStop,
}) {
  const entry = Number(position.entry_premium);
  if (!(entry > 0) || !Number.isFinite(Number(currentPremium))) return null;

  const pnlFrac = (Number(currentPremium) - entry) / entry;
  const priorMfe = Number(position.mfe_pct) || 0;
  const priorMae = Number(position.mae_pct) || 0;
  const mfeFrac = Math.max(priorMfe, pnlFrac);
  const maeFrac = Math.min(priorMae, pnlFrac);

  if (mfeFrac !== position.mfe_pct || maeFrac !== position.mae_pct) {
    await updateOrbPositionExcursion(position.id, mfeFrac, maeFrac);
    position.mfe_pct = mfeFrac;
    position.mae_pct = maeFrac;
  }

  const decision = evaluateOrbPartialLockTrail({
    pnlFrac,
    mfeFrac,
    exitPhase: position.exit_phase,
    hardStopPct: ORB_HARD_STOP_PCT,
  });

  if (decision.action !== 'close_all') {
    if (
      decision.trailFloor != null &&
      decision.inactiveReason !== 'below_activation' &&
      decision.inactiveReason !== 'hard_stop_owns_exit'
    ) {
      await syncOrbPartialLockBrokerStop(position, {
        decision,
        brokerStop,
        environment,
        onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
          await notifyOrbCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
        },
      });
    }
    return null;
  }

  const closeQty = position.contracts_open ?? position.quantity ?? 0;
  if (!(closeQty > 0)) return null;

  const settled = await submitAndSettleFullClose({
    position,
    closeQty,
    currentPremium,
    pnlFrac,
    intendedReason: ORB_PARTIAL_LOCK_CLOSE_REASON,
    isTimeStop: false,
    brokerStop,
    closeBrokerOrder: (pos, exitPremium, quantity) =>
      closeOptionOrder(pos, exitPremium, quantity, { environment, strategy: 'orb' }),
    flattenBrokerOrder: (pos, exitPremium, quantity) =>
      closeOptionOrder(pos, exitPremium, quantity, { environment, strategy: 'orb' }),
    fullClosePosition: closeOrbPosition,
    cancelExitOrder: (orderId) =>
      cancelBrokerOrder(orderId, { environment, strategy: 'orb' }),
    updatePendingClose: updateOrbPositionPendingClose,
    restoreStopPnlFrac: decision.trailFloor,
    getOpenPosition: async () => {
      const open = await getOrbOpenPositions();
      return open.find((p) => Number(p.id) === Number(position.id)) || null;
    },
    onNotify: async (pos, reason, settledPnl, exitPremium) => {
      if (reason === ORB_PARTIAL_LOCK_CLOSE_REASON) {
        await logOrbPartialLockTrailEvent(pos, {
          exitPremium,
          peakMfe: decision.peakMfe,
          trailFloor: decision.trailFloor,
          pnlFrac: settledPnl,
          quantity: closeQty,
        }).catch((err) => {
          console.warn(`[ORB] partial_lock_trail event log failed:`, err.message);
        });
        console.log(
          `[ORB] partial_lock_trail ${pos.ticker} peak=${(decision.peakMfe * 100).toFixed(1)}% ` +
            `floor=${(decision.trailFloor * 100).toFixed(1)}% exit=${(settledPnl * 100).toFixed(1)}% ` +
            `@ $${Number(exitPremium).toFixed(2)}`
        );
      }
      await sendOrbTradeClosedTelegram({
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
    hardStopPct: ORB_HARD_STOP_PCT,
    updateBrokerStopState: updateOrbPositionBrokerStop,
    fullClosePosition: closeOrbPosition,
    onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
      await notifyOrbCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
    },
    resolveCloseReason: ({ position: pos, defaultReason }) =>
      resolveOrbPartialLockStopFillReason({
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
          strategy: 'orb',
          position,
          getOpenPositions: getOrbOpenPositions,
          environment,
          fullClosePosition: closeOrbPosition,
          onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
            await notifyOrbCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
          },
        })
      );
    }

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
      // Arm peak/2 before ladder exits can continue past post-ladder trail sync.
      if (!timeStop) {
        await armOrbPartialLockBeforeLadder(position, {
          currentPremium,
          brokerStop,
          hardStopPct: ORB_HARD_STOP_PCT,
          environment,
          onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
            await notifyOrbCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
          },
        });
      }

      // Ladder: broker-stop fill check + hard stop + soft stop + milestones.
      // Partial-lock software *close* must NOT run before this.
      const action = await handleLadderPositionMonitor(position, {
        currentPremium,
        initialStopPct: ORB_STOP_LOSS_PCT,
        hardStopPct: ORB_HARD_STOP_PCT,
        isTimeStop: timeStop,
        fullPositionExits: true,
        updateExcursion: updateOrbPositionExcursion,
        updateLadderState: updateOrbPositionPyramidState,
        partialCloseLeg: partialCloseOrbPosition,
        fullClosePosition: closeOrbPosition,
        closeBrokerOrder: (position, exitPremium, quantity, closeOpts) =>
          closeOptionOrder(position, exitPremium, quantity, {
            environment,
            strategy: 'orb',
            ...closeOpts,
          }),
        flattenBrokerOrder: (position, exitPremium, quantity) =>
          closeOptionOrder(position, exitPremium, quantity, { environment, strategy: 'orb' }),
        cancelExitOrder: (orderId) =>
          cancelBrokerOrder(orderId, { environment, strategy: 'orb' }),
        getExitOrderStatus: (orderId) =>
          getBrokerOrderStatus(orderId, { environment, strategy: 'orb' }),
        updatePendingClose: updateOrbPositionPendingClose,
        getOpenPosition: async () => {
          const open = await getOrbOpenPositions();
          return open.find((p) => Number(p.id) === Number(position.id)) || null;
        },
        brokerStop,
        onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
          await notifyOrbCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
        },
        settleIfBrokerFlat: (pos) =>
          settleDbOpenIfBrokerFlat(pos, {
            environment,
            strategy: 'orb',
            fullClosePosition: closeOrbPosition,
            onNotify: async (p, reason, pnlPct, exitPremium, closeQty, meta) => {
              await notifyOrbCloseWithSlippage(p, reason, pnlPct, exitPremium, closeQty, meta);
            },
          }),
      });

      // Ladder already acted (close / scale-out / skip) — do not run partial-lock.
      if (action?.reason || action?.skipped || action?.pendingClose) {
        actions.push(action);
        continue;
      }

      // ORB-only: pre-milestone partial-lock after ladder hold.
      // Profit trail after ladder hold (3%→1000% ratchet). Skipped on time-stop.
      if (!timeStop) {
        const partialLockAction = await tryOrbPartialLockTrailClose(position, {
          currentPremium,
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
