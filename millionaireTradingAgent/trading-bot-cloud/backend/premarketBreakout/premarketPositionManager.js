import { closeOptionOrder, getOptionPremium, cancelBrokerOrder, getBrokerOrderStatus } from '../brokerageConnector.js';
import {
  getPremarketOpenPositions,
  updatePremarketPositionExcursion,
  updatePremarketPositionPyramidState,
  updatePremarketPositionBrokerStop,
  updatePremarketPositionPendingClose,
  partialClosePremarketPosition,
  closePremarketPosition,
  logPremarketEvent,
} from './premarketDb.js';
import { isAtOrAfterTimeStop, isWithinPremarketSession } from './premarketRangeState.js';
import { sendPremarketTradeClosedTelegram } from './premarketTelegram.js';
import { sendCloseFailedTelegram } from '../telegramHandler.js';
import {
  computePremarketIvStopPcts,
  PREMARKET_HARD_STOP_TRIGGER,
  PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
  PREMARKET_PARTIAL_LOCK_CLOSE_REASON,
} from './premarketConfig.js';
import {
  evaluatePremarketPartialLockTrail,
  shouldRaisePartialLockBrokerStop,
  resolvePremarketPartialLockStopFillReason,
} from './premarketPartialLockTrail.js';
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
import { etDateKey } from '../orb/tradierTimesales.js';
import {
  LADDER_CLOSE_REASON,
  parseLadderMilestonesCompleted,
} from '../ladder/ladderConfig.js';

/**
 * Premarket-only hard-stop slippage audit. Writes to premarket_event_log only —
 * does not touch ORB / EMA / Swing log schemas.
 */
async function logPremarketHardStopSlippage(position, { exitPremium, pnlFrac, quantity, escalated = false, limitPrice = null, skippedLimitEscalation = false }) {
  const entry = Number(position.entry_premium);
  const fill = Number(exitPremium);
  if (!(entry > 0) || !Number.isFinite(fill)) return;

  const triggerPrice = Math.max(
    0.01,
    Math.round(entry * (1 - PREMARKET_HARD_STOP_TRIGGER) * 100) / 100
  );
  const qty = Number(quantity) || Number(position.contracts_open) || Number(position.quantity) || 1;
  const slipDollarsPerContract = fill - triggerPrice;
  const slipDollars = slipDollarsPerContract * 100 * qty;
  const slipPctOfEntry = (fill - triggerPrice) / entry;
  const realizedLossPct = Number.isFinite(pnlFrac) ? pnlFrac : (fill - entry) / entry;
  const didEscalate = escalated === true;
  const didSkipLimit = skippedLimitEscalation === true;

  await logPremarketEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType: 'hard_stop_slippage',
    direction: position.direction,
    breakoutLevel: position.breakout_level,
    details: {
      type: 'hard_stop_slippage',
      position_id: position.id,
      hard_stop_trigger_pct: PREMARKET_HARD_STOP_TRIGGER,
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
    `[Premarket] hard_stop_slippage ${position.ticker} trigger=$${triggerPrice} ` +
      `limit=$${limitPrice ?? 'n/a'} fill=$${fill} ` +
      `slip=${(slipPctOfEntry * 100).toFixed(2)}% ($${slipDollars.toFixed(2)}) ` +
      `escalated=${didEscalate} skipped_limit_escalation=${didSkipLimit}`
  );
}

async function notifyPremarketCloseWithSlippage(position, reason, pnlPct, exitPremium, closeQty, meta) {
  if (reason === LADDER_CLOSE_REASON.HARD_STOP) {
    await logPremarketHardStopSlippage(position, {
      exitPremium,
      pnlFrac: pnlPct,
      quantity: closeQty,
      escalated: meta?.escalated === true,
      limitPrice: meta?.hardStopLimitPrice ?? null,
      skippedLimitEscalation: meta?.skippedLimitEscalation === true,
    }).catch((err) => {
      console.warn(`[Premarket] hard_stop_slippage log failed:`, err.message);
    });
  }
  await sendPremarketTradeClosedTelegram({
    ticker: position.ticker,
    reason,
    pnlPct,
  });
}

async function logPremarketPartialLockStopReplace(position, {
  peakMfe,
  trailFloor,
  oldTrigger,
  newTrigger,
  oldOrderId,
  newOrderId,
  attempt = null,
}) {
  await logPremarketEvent({
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

async function logPremarketPartialLockStopReplaceFailed(position, {
  peakMfe,
  trailFloor,
  oldTrigger,
  oldOrderId,
  desiredTrigger,
  reason,
  attempt,
  eventType = PARTIAL_LOCK_STOP_REPLACE_FAILED,
}) {
  await logPremarketEvent({
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

async function logPremarketPartialLockTrailEvent(position, {
  exitPremium,
  peakMfe,
  trailFloor,
  pnlFrac,
  quantity,
}) {
  await logPremarketEvent({
    ticker: position.ticker,
    tradeDate: etDateKey(),
    eventType: PREMARKET_PARTIAL_LOCK_CLOSE_REASON,
    direction: position.direction,
    breakoutLevel: position.breakout_level,
    details: {
      type: PREMARKET_PARTIAL_LOCK_CLOSE_REASON,
      position_id: position.id,
      activation_mfe: PREMARKET_PARTIAL_LOCK_ACTIVATION_MFE,
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
async function syncPremarketPartialLockBrokerStop(position, { decision, brokerStop, environment, onNotify }) {
  if (!brokerStop?.enabled || typeof brokerStop.replaceStop !== 'function') return null;
  if (!shouldArmPartialLockBrokerStop(decision)) return null;

  const trailFloor = decision.trailFloor;
  const check = shouldRaisePartialLockBrokerStop(position, trailFloor);
  if (!check.raise) return null;

  return syncPartialLockBrokerStopWithRetry(position, {
    strategy: 'premarket',
    trailFloor,
    peakMfe: decision.peakMfe,
    replaceStop: (pos, floor) => brokerStop.replaceStop(pos, floor),
    shouldRaise: shouldRaisePartialLockBrokerStop,
    getOpenPosition: async () => {
      const open = await getPremarketOpenPositions();
      return open.find((p) => Number(p.id) === Number(position.id)) || null;
    },
    ...buildPartialLockBrokerLiveChecks(position, {
      environment,
      strategy: 'premarket',
      fullClosePosition: closePremarketPosition,
      onNotify,
    }),
    logLabel: 'Premarket',
    onSuccess: async (payload) => {
      await logPremarketPartialLockStopReplace(position, payload).catch((err) => {
        console.warn(`[Premarket] partial_lock_stop_replace event log failed:`, err.message);
      });
    },
    onFailure: async (payload) => {
      await logPremarketPartialLockStopReplaceFailed(position, payload).catch((err) => {
        console.warn(`[Premarket] ${PARTIAL_LOCK_STOP_REPLACE_FAILED} event log failed:`, err.message);
      });
    },
  });
}

/**
 * Arm peak/2 BEFORE ladder exits so a hard-stop / scale-out continue cannot
 * skip the raise when MFE is already ≥ activation and current pnl is still
 * above the hard ceiling. Soft loss stop still needs replacing in that window.
 */
async function armPremarketPartialLockBeforeLadder(position, {
  currentPremium,
  brokerStop,
  hardStopPct,
  environment,
  onNotify,
}) {
  const entry = Number(position.entry_premium);
  if (!(entry > 0) || !Number.isFinite(Number(currentPremium))) return null;
  if (parseLadderMilestonesCompleted(position.exit_phase) > 0) return null;

  const pnlFrac = (Number(currentPremium) - entry) / entry;
  const mfeFrac = Math.max(Number(position.mfe_pct) || 0, pnlFrac);
  const maeFrac = Math.min(Number(position.mae_pct) || 0, pnlFrac);
  if (mfeFrac !== position.mfe_pct || maeFrac !== position.mae_pct) {
    await updatePremarketPositionExcursion(position.id, mfeFrac, maeFrac);
    position.mfe_pct = mfeFrac;
    position.mae_pct = maeFrac;
  }

  const decision = evaluatePremarketPartialLockTrail({
    pnlFrac,
    mfeFrac,
    exitPhase: position.exit_phase,
    hardStopPct,
  });
  if (!shouldArmPartialLockBrokerStop(decision)) return null;
  return syncPremarketPartialLockBrokerStop(position, { decision, brokerStop, environment, onNotify });
}

/**
 * Premarket-only pre-milestone partial-lock: raise resting stop to peak/2, and
 * poll-close if already through the floor. Caller must run shared ladder first.
 * Returns an action object if closed, else null.
 */
async function tryPremarketPartialLockTrailClose(position, {
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
    await updatePremarketPositionExcursion(position.id, mfeFrac, maeFrac);
    position.mfe_pct = mfeFrac;
    position.mae_pct = maeFrac;
  }

  const decision = evaluatePremarketPartialLockTrail({
    pnlFrac,
    mfeFrac,
    exitPhase: position.exit_phase,
    hardStopPct: PREMARKET_HARD_STOP_TRIGGER,
  });

  if (decision.action !== 'close_all') {
    if (
      decision.trailFloor != null &&
      decision.inactiveReason !== 'post_milestone_ladder_owns_trail' &&
      decision.inactiveReason !== 'below_activation' &&
      decision.inactiveReason !== 'hard_stop_owns_exit'
    ) {
      await syncPremarketPartialLockBrokerStop(position, {
        decision,
        brokerStop,
        environment,
        onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
          await notifyPremarketCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
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
    intendedReason: PREMARKET_PARTIAL_LOCK_CLOSE_REASON,
    isTimeStop: false,
    brokerStop,
    closeBrokerOrder: (pos, exitPremium, quantity) =>
      closeOptionOrder(pos, exitPremium, quantity, { environment, strategy: 'premarket' }),
    flattenBrokerOrder: (pos, exitPremium, quantity) =>
      closeOptionOrder(pos, exitPremium, quantity, { environment, strategy: 'premarket' }),
    fullClosePosition: closePremarketPosition,
    cancelExitOrder: (orderId) =>
      cancelBrokerOrder(orderId, { environment, strategy: 'premarket' }),
    updatePendingClose: updatePremarketPositionPendingClose,
    restoreStopPnlFrac: decision.trailFloor,
    getOpenPosition: async () => {
      const open = await getPremarketOpenPositions();
      return open.find((p) => Number(p.id) === Number(position.id)) || null;
    },
    onNotify: async (pos, reason, settledPnl, exitPremium) => {
      if (reason === PREMARKET_PARTIAL_LOCK_CLOSE_REASON) {
        await logPremarketPartialLockTrailEvent(pos, {
          exitPremium,
          peakMfe: decision.peakMfe,
          trailFloor: decision.trailFloor,
          pnlFrac: settledPnl,
          quantity: closeQty,
        }).catch((err) => {
          console.warn(`[Premarket] partial_lock_trail event log failed:`, err.message);
        });
        console.log(
          `[Premarket] partial_lock_trail ${pos.ticker} peak=${(decision.peakMfe * 100).toFixed(1)}% ` +
            `floor=${(decision.trailFloor * 100).toFixed(1)}% exit=${(settledPnl * 100).toFixed(1)}% ` +
            `@ $${Number(exitPremium).toFixed(2)}`
        );
      }
      await sendPremarketTradeClosedTelegram({
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

export async function monitorPremarketPositions() {
  if (!isWithinPremarketSession() && !isAtOrAfterTimeStop()) {
    return [];
  }

  const positions = await getPremarketOpenPositions();
  const environment = await getStrategyEnvironment('premarket');
  const actions = [];
  const timeStop = isAtOrAfterTimeStop();

  for (const position of positions) {
    const ivStops = computePremarketIvStopPcts(position.entry_iv);
    const brokerStop = createLadderBrokerStopHandlers({
      strategy: 'premarket',
      environment,
      // Premarket: resting broker / replaceStop baseline tracks flat SOFT (1%);
      // hard 1.75% is fill-attribution / poll backstop. After +3% MFE, partial-lock
      // raises this same order to peak/2 (pre-milestone only).
      initialStopPct: ivStops.softStopPct,
      // Fills past this ceiling (e.g. stop_market slip) attribute as hard_stop + slippage log.
      hardStopPct: PREMARKET_HARD_STOP_TRIGGER,
      updateBrokerStopState: updatePremarketPositionBrokerStop,
      fullClosePosition: closePremarketPosition,
      onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
        await notifyPremarketCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
      },
      resolveCloseReason: ({ position: pos, defaultReason }) =>
        resolvePremarketPartialLockStopFillReason({
          position: pos,
          defaultReason,
        }),
    });

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
          strategy: 'premarket',
          position,
          getOpenPositions: getPremarketOpenPositions,
          environment,
          fullClosePosition: closePremarketPosition,
          onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
            await notifyPremarketCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
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
      console.warn(`[Premarket] Premium lookup failed for ${position.ticker}:`, err.message);
      continue;
    }

    try {
      // Arm peak/2 as soon as MFE activates — before ladder hard-stop / scale-out
      // can continue past the post-ladder trail sync. Does not run when current
      // pnl is already past hard (hard_stop_owns_exit): that exit stays ladder's.
      if (!timeStop) {
        await armPremarketPartialLockBeforeLadder(position, {
          currentPremium,
          brokerStop,
          hardStopPct: PREMARKET_HARD_STOP_TRIGGER,
          environment,
          onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
            await notifyPremarketCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
          },
        });
      }

      // Ladder: broker-stop fill check + hard stop + soft stop + milestones.
      // Partial-lock software *close* must NOT run before this — otherwise a
      // deep-red poll is claimed as partial_lock_trail (trades 48/49 diagnostic).
      const action = await handleLadderPositionMonitor(position, {
        currentPremium,
        initialStopPct: ivStops.softStopPct,
        // Premarket-only constant — not shared LADDER_HARD_STOP_PCT.
        hardStopPct: PREMARKET_HARD_STOP_TRIGGER,
        isTimeStop: timeStop,
        fullPositionExits: true,
        updateExcursion: updatePremarketPositionExcursion,
        updateLadderState: updatePremarketPositionPyramidState,
        partialCloseLeg: partialClosePremarketPosition,
        fullClosePosition: closePremarketPosition,
        closeBrokerOrder: (position, exitPremium, quantity, closeOpts) =>
          closeOptionOrder(position, exitPremium, quantity, {
            environment,
            strategy: 'premarket',
            ...closeOpts,
          }),
        flattenBrokerOrder: (position, exitPremium, quantity) =>
          closeOptionOrder(position, exitPremium, quantity, { environment, strategy: 'premarket' }),
        cancelExitOrder: (orderId) =>
          cancelBrokerOrder(orderId, { environment, strategy: 'premarket' }),
        getExitOrderStatus: (orderId) =>
          getBrokerOrderStatus(orderId, { environment, strategy: 'premarket' }),
        updatePendingClose: updatePremarketPositionPendingClose,
        getOpenPosition: async () => {
          const open = await getPremarketOpenPositions();
          return open.find((p) => Number(p.id) === Number(position.id)) || null;
        },
        brokerStop,
        onNotify: async (pos, reason, pnlPct, exitPremium, closeQty, meta) => {
          await notifyPremarketCloseWithSlippage(pos, reason, pnlPct, exitPremium, closeQty, meta);
        },
        settleIfBrokerFlat: (pos) =>
          settleDbOpenIfBrokerFlat(pos, {
            environment,
            strategy: 'premarket',
            fullClosePosition: closePremarketPosition,
            onNotify: async (p, reason, pnlPct, exitPremium, closeQty, meta) => {
              await notifyPremarketCloseWithSlippage(p, reason, pnlPct, exitPremium, closeQty, meta);
            },
          }),
      });

      // Ladder already acted (close / scale-out / skip) — do not run partial-lock.
      if (action?.reason || action?.skipped || action?.pendingClose) {
        actions.push(action);
        continue;
      }

      // Premarket-only: pre-milestone partial-lock after ladder hold.
      // Hard-gated to milestonesCompleted === 0 so it never overrides post-milestone
      // stepped-floor trail. Skipped on time-stop (ladder owns EOD).
      const milestonesCompleted = parseLadderMilestonesCompleted(position.exit_phase);
      if (!timeStop && milestonesCompleted === 0) {
        const partialLockAction = await tryPremarketPartialLockTrailClose(position, {
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
