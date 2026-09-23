import {
  LADDER_INITIAL_STOP_PCT,
  LADDER_HARD_STOP_PCT,
  LADDER_MILESTONES_PCT,
  LADDER_CLOSE_REASON,
  LADDER_UNFILLED_EXIT_COOLDOWN_MS,
  LADDER_FORCED_FLATTEN_PRICE,
  HARD_STOP_LIMIT_WAIT_MS,
  HARD_STOP_LIMIT_POLL_MS,
  ladderExitPhase,
  parseLadderMilestonesCompleted,
  getLadderSellSchedule,
  computeActiveStopPnlFrac,
  computeHardStopTriggerPrice,
  computeHardStopCloseLimitPrice,
  isRiskExitReason,
} from './ladderConfig.js';
import {
  isFlattenRetryInFlight,
  syncFlattenUntilClosed,
} from './flattenUntilClosed.js';
import { ensurePartialLockBrokerStopRaised } from './partialLockStopReplace.js';
import { closeFillIsConfirmed, hasConfirmedFillPrice, parseEntryMetadata, positionHasConfirmedBrokerLong } from './orderFillStatus.js';

/**
 * Explosive-bar admits are tagged gate_removed_entry on insert metadata.
 * Hard-stop for those skips the 3s trigger-minus-tick limit and goes to market.
 */
export function isGateRemovedEntry(position) {
  if (!position) return false;
  if (position.gate_removed_entry === true) return true;
  const meta =
    parseEntryMetadata(position.entry_metadata_json) ||
    parseEntryMetadata(position.entry_metadata);
  return meta?.gate_removed_entry === true;
}

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
  hardStopPct = LADDER_HARD_STOP_PCT,
  isTimeStop = false,
  skipPollStops = false,
  /** Skip the hard-stop poll too (zero-fill: nothing owned yet). */
  skipHardStop = false,
  /** ORB / Premarket: close the full book at the first firing trigger; no scale-outs. */
  fullPositionExits = false,
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
  const hardPct = Number(hardStopPct);
  const effectiveHardStop =
    Number.isFinite(hardPct) && hardPct > 0 ? hardPct : LADDER_HARD_STOP_PCT;

  // Hard ceiling — never skipped by a resting broker-stop bypass, but skipped
  // when no broker long exists yet (zero-fill phantom). Primary 6.5% remains the target.
  if (!skipHardStop && pnlFrac <= -effectiveHardStop) {
    return { action: 'close_all', reason: LADDER_CLOSE_REASON.HARD_STOP, contracts: open };
  }

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
      // Same trigger % as before. ORB/Premarket flatten the whole book instead of
      // LADDER_SELL_SCHEDULE partials (which cannot map onto variable entry size).
      if (fullPositionExits) {
        // Profit trail (3%→1000% ratchet) owns winners. Do not flatten at +20%.
        return { action: 'hold' };
      }

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

export function shouldSkipDiscretionaryRetry({
  pendingCloseSubmittedAt,
  nowMs = Date.now(),
  cooldownMs = LADDER_UNFILLED_EXIT_COOLDOWN_MS,
} = {}) {
  if (!pendingCloseSubmittedAt) return false;
  const submitted = Date.parse(pendingCloseSubmittedAt);
  if (!Number.isFinite(submitted)) return false;
  return nowMs - submitted < cooldownMs;
}

/**
 * What to do when an STC was submitted but the broker did not confirm a fill.
 * Discretionary profit-takes restore the protective stop (cannot rest a limit
 * STC and a stop STC on the same OCC symbol). Risk / time-stop exits flatten.
 */
export function planUnfilledExit({ intendedReason, isTimeStop = false } = {}) {
  const reason = String(intendedReason || '');
  if (isTimeStop && !isRiskExitReason(reason)) {
    return {
      action: 'flatten',
      flattenPrice: LADDER_FORCED_FLATTEN_PRICE,
      closeReason: LADDER_CLOSE_REASON.FORCED_CLOSE_EOD,
    };
  }
  if (isRiskExitReason(reason) || isTimeStop) {
    return {
      action: 'flatten',
      flattenPrice: LADDER_FORCED_FLATTEN_PRICE,
      closeReason: reason || LADDER_CLOSE_REASON.TIME_STOP,
    };
  }
  return { action: 'restore_stop' };
}

function pnlFracFromFill(position, exitPremium, fallbackPnlFrac) {
  const entry = Number(position.entry_premium);
  const exit = Number(exitPremium);
  if (Number.isFinite(entry) && entry > 0 && Number.isFinite(exit)) {
    return (exit - entry) / entry;
  }
  return Number.isFinite(Number(fallbackPnlFrac)) ? Number(fallbackPnlFrac) : 0;
}

/**
 * noBrokerPosition is two different stories: entry never filled (pnl 0) vs
 * broker already flat after a real STC (book the print, not $0).
 */
export function bookNoBrokerPosition({ closeResult, position, currentPremium, pnlFrac }) {
  const reason = closeResult?.reason || 'entry_unfilled_cancelled';
  if (reason === 'broker_already_flat') {
    const fillPrice = Number(closeResult?.fillPrice);
    const hasFill = hasConfirmedFillPrice(closeResult);
    if (hasFill) {
      return {
        exitPremium: fillPrice,
        pnlFrac: pnlFracFromFill(position, fillPrice, pnlFrac),
        reason,
      };
    }
    return {
      exitPremium: currentPremium,
      pnlFrac: pnlFracFromFill(position, currentPremium, 0),
      reason,
    };
  }
  return {
    exitPremium: currentPremium,
    pnlFrac: 0,
    reason,
  };
}

async function persistPending(updatePendingClose, position, fields) {
  const next = {
    pending_close_order_id:
      fields.pending_close_order_id === undefined
        ? (position.pending_close_order_id ?? null)
        : fields.pending_close_order_id,
    pending_close_reason:
      fields.pending_close_reason === undefined
        ? (position.pending_close_reason ?? null)
        : fields.pending_close_reason,
    pending_close_submitted_at:
      fields.pending_close_submitted_at === undefined
        ? (position.pending_close_submitted_at ?? null)
        : fields.pending_close_submitted_at,
  };
  if (updatePendingClose) {
    await updatePendingClose(position.id, next);
  }
  Object.assign(position, next);
}

async function restoreProtectiveStop(
  position,
  brokerStop,
  restoreStopPnlFrac,
  { getOpenPosition = null, logLabel = 'LadderExit' } = {}
) {
  if (!brokerStop?.enabled || !brokerStop.replaceStop) return { restored: false };
  const frac =
    restoreStopPnlFrac ??
    computeActiveStopPnlFrac({
      exitPhase: position.exit_phase,
      ratchetStopFrac: position.trail_peak_pnl_frac,
    });
  const result = await brokerStop.replaceStop(position, frac);
  if (result?.placed) return { restored: true, result };

  // One-shot replace failed — keep retrying until the floor rests or the row closes.
  if (typeof getOpenPosition === 'function') {
    const background = ensurePartialLockBrokerStopRaised(position, {
      strategy: 'restore_stop',
      trailFloor: frac,
      replaceStop: (pos, floor) => brokerStop.replaceStop(pos, floor),
      getOpenPosition,
      logLabel,
      maxAttempts: null,
    });
    if (background && typeof background.catch === 'function') {
      background.catch((err) => {
        console.error(
          `[${logLabel}] restore-stop retry crashed #${position?.id}:`,
          err.message
        );
      });
    }
    return { restored: false, retrying: true, result };
  }

  return { restored: false, result };
}

async function closeNow({
  position,
  exitPremium,
  pnlFrac,
  reason,
  closeQty,
  fullClosePosition,
  onNotify,
  updatePendingClose,
  notifyMeta = null,
}) {
  await persistPending(updatePendingClose, position, {
    pending_close_order_id: null,
    pending_close_reason: null,
    pending_close_submitted_at: null,
  });
  await fullClosePosition(position.id, exitPremium, pnlFrac * 100, reason, closeQty);
  if (onNotify) {
    await onNotify(position, reason, pnlFrac, exitPremium, closeQty, notifyMeta);
  }
  return {
    position,
    reason,
    pnlFrac,
    exitPremium,
    contractsClosed: closeQty,
    brokerFillConfirmed: true,
  };
}

function attachHardStopCloseMeta(result, meta) {
  if (!meta?.isHardStop || !result) return result;
  return {
    ...result,
    escalated: Boolean(meta.escalated),
    hardStopLimitPrice: meta.hardStopLimitPrice ?? null,
    hardStopTriggerPrice: meta.hardStopTriggerPrice ?? null,
    skippedLimitEscalation: meta.skippedLimitEscalation === true,
  };
}

function buildHardStopNotifyMeta({
  escalated,
  hardStopLimitPrice,
  hardStopTriggerPrice,
  skippedLimitEscalation,
}) {
  return {
    escalated: escalated === true,
    hardStopLimitPrice: hardStopLimitPrice ?? null,
    hardStopTriggerPrice: hardStopTriggerPrice ?? null,
    skippedLimitEscalation: skippedLimitEscalation === true,
  };
}

/**
 * Submit an STC and only write the trade log after a broker fill.
 * Unfilled discretionary limits: cancel the limit, restore the stop, stay OPEN.
 * Unfilled risk/time-stop limits: flatten at LADDER_FORCED_FLATTEN_PRICE.
 */
export async function submitAndSettleFullClose({
  position,
  closeQty,
  currentPremium,
  pnlFrac,
  intendedReason,
  isTimeStop = false,
  brokerStop = null,
  closeBrokerOrder,
  flattenBrokerOrder = null,
  fullClosePosition,
  onNotify,
  cancelExitOrder = null,
  updatePendingClose = null,
  restoreStopPnlFrac = null,
  getOpenPosition = null,
  sleep = null,
  hardStopPct = null,
}) {
  const brokerStopActive = !!(brokerStop?.enabled && position.broker_stop_order_id);
  if (brokerStopActive) {
    await brokerStop.cancelStop(position);
    position.broker_stop_order_id = null;
  }

  const isHardStop = intendedReason === LADDER_CLOSE_REASON.HARD_STOP;
  const skipLimitEscalation = isHardStop && isGateRemovedEntry(position);
  const hardStopTriggerPrice = isHardStop
    ? computeHardStopTriggerPrice(position.entry_premium, hardStopPct)
    : null;
  const hardStopLimitPrice =
    isHardStop && !skipLimitEscalation
      ? computeHardStopCloseLimitPrice(hardStopTriggerPrice)
      : null;
  const firstPrice = hardStopLimitPrice ?? currentPremium;
  const hardStopMeta = {
    isHardStop,
    hardStopLimitPrice,
    hardStopTriggerPrice,
    skippedLimitEscalation: skipLimitEscalation,
  };

  const submittedAt = new Date().toISOString();
  await persistPending(updatePendingClose, position, {
    pending_close_order_id: null,
    pending_close_reason: intendedReason,
    pending_close_submitted_at: submittedAt,
  });

  let closeResult;
  if (skipLimitEscalation) {
    console.log(
      `[LadderExit] hard_stop skip_limit #${position.id} gate_removed_entry ` +
        `trigger=$${hardStopTriggerPrice} — market flatten immediately ` +
        `(skipped_limit_escalation=true)`
    );
    closeResult = { filled: false, orderId: null, reason: 'skipped_limit_escalation' };
  } else {
    if (isHardStop) {
      console.log(
        `[LadderExit] hard_stop limit #${position.id} trigger=$${hardStopTriggerPrice} ` +
          `limit=$${hardStopLimitPrice} wait=${HARD_STOP_LIMIT_WAIT_MS}ms ` +
          `(skipped_limit_escalation=false)`
      );
    }
    try {
      closeResult = await closeBrokerOrder(
        position,
        firstPrice,
        closeQty,
        isHardStop
          ? { fillWaitMs: HARD_STOP_LIMIT_WAIT_MS, fillPollMs: HARD_STOP_LIMIT_POLL_MS }
          : undefined
      );
    } catch (err) {
      console.error(
        `[LadderExit] closeBrokerOrder threw for #${position.id}:`,
        err.message
      );
      closeResult = { filled: false, orderId: null, reason: err.message };
    }
  }

  if (closeResult?.noBrokerPosition) {
    const booked = bookNoBrokerPosition({
      closeResult,
      position,
      currentPremium,
      pnlFrac,
    });
    return closeNow({
      position,
      exitPremium: booked.exitPremium,
      pnlFrac: booked.pnlFrac,
      reason: booked.reason,
      closeQty,
      fullClosePosition,
      onNotify,
      updatePendingClose,
    });
  }

  if (closeResult?.orderId) {
    await persistPending(updatePendingClose, position, {
      pending_close_order_id: String(closeResult.orderId),
      pending_close_reason: intendedReason,
      pending_close_submitted_at: submittedAt,
    });
  }

  if (closeResult?.filled && !closeFillIsConfirmed(closeResult)) {
    console.error(
      `[LadderExit] STC reported filled without a confirmed fill price #${position.id} ` +
        `order=${closeResult.orderId || 'none'} — not booking`
    );
    closeResult = { ...closeResult, filled: false, reason: 'fill_price_unconfirmed' };
  }

  if (closeFillIsConfirmed(closeResult)) {
    const exitPremium = closeResult.fillPrice;
    const fillPnl = pnlFracFromFill(position, exitPremium, pnlFrac);
    if (isHardStop) {
      console.log(
        `[LadderExit] hard_stop limit FILLED #${position.id} fill=$${exitPremium} escalated=false`
      );
    }
    return attachHardStopCloseMeta(
      await closeNow({
        position,
        exitPremium,
        pnlFrac: fillPnl,
        reason: intendedReason,
        closeQty,
        fullClosePosition,
        onNotify,
        updatePendingClose,
        notifyMeta: isHardStop
          ? buildHardStopNotifyMeta({
              escalated: false,
              hardStopLimitPrice,
              hardStopTriggerPrice,
              skippedLimitEscalation: skipLimitEscalation,
            })
          : null,
      }),
      { ...hardStopMeta, escalated: false }
    );
  }

  const plan = planUnfilledExit({ intendedReason, isTimeStop });
  const orderId = closeResult?.orderId ? String(closeResult.orderId) : null;

  if (isHardStop) {
    if (skipLimitEscalation) {
      console.log(
        `[LadderExit] hard_stop market flatten #${position.id} ` +
          `skipped_limit_escalation=true at $${LADDER_FORCED_FLATTEN_PRICE}`
      );
    } else {
      console.log(
        `[LadderExit] hard_stop limit UNFILLED #${position.id} order=${orderId || 'none'} ` +
          `— escalating to market flatten at $${LADDER_FORCED_FLATTEN_PRICE} ` +
          `(skipped_limit_escalation=false)`
      );
    }
  }

  const settleFlattenFill = async (flattenResult) => {
    if (!flattenResult?.noBrokerPosition && !closeFillIsConfirmed(flattenResult)) {
      console.error(
        `[LadderExit] flatten reported filled without a confirmed fill price #${position.id} ` +
          `— not booking`
      );
      return {
        position,
        pendingClose: true,
        flattenRetry: true,
        intendedReason,
        closeReason: null,
        reason: 'fill_price_unconfirmed',
      };
    }
    const booked = flattenResult.noBrokerPosition
      ? bookNoBrokerPosition({
          closeResult: flattenResult,
          position,
          currentPremium,
          pnlFrac,
        })
      : {
          exitPremium: flattenResult.fillPrice,
          pnlFrac: pnlFracFromFill(position, flattenResult.fillPrice, pnlFrac),
          reason: plan.closeReason,
        };
    const exitPremium = booked.exitPremium;
    const fillPnl = booked.pnlFrac;
    const reason = booked.reason;
    if (isHardStop && !flattenResult.noBrokerPosition) {
      console.log(
        `[LadderExit] hard_stop market FILLED #${position.id} fill=$${exitPremium} escalated=true`
      );
    }
    return attachHardStopCloseMeta(
      await closeNow({
        position,
        exitPremium,
        pnlFrac: fillPnl,
        reason,
        closeQty,
        fullClosePosition,
        onNotify,
        updatePendingClose,
        notifyMeta: isHardStop
          ? buildHardStopNotifyMeta({
              escalated: true,
              hardStopLimitPrice,
              hardStopTriggerPrice,
              skippedLimitEscalation: skipLimitEscalation,
            })
          : null,
      }),
      { ...hardStopMeta, escalated: true }
    );
  };

  if (plan.action === 'flatten') {
    if (orderId && cancelExitOrder) {
      try {
        await cancelExitOrder(orderId);
      } catch (err) {
        console.warn(`[LadderExit] cancel unfilled STC ${orderId} failed:`, err.message);
      }
    }
    const flatten = flattenBrokerOrder || closeBrokerOrder;
    const flattenResult = await syncFlattenUntilClosed(position, {
      flattenBrokerOrder: flatten,
      flattenPrice: plan.flattenPrice,
      closeQty,
      getOpenPosition,
      logLabel: 'LadderExit',
      ...(sleep ? { sleep } : {}),
      settleFilled: async (filled) => {
        await settleFlattenFill(filled);
      },
    });
    if (flattenResult?.noBrokerPosition || closeFillIsConfirmed(flattenResult)) {
      return settleFlattenFill(flattenResult);
    }
    await persistPending(updatePendingClose, position, {
      pending_close_order_id: null,
      pending_close_reason: intendedReason,
      pending_close_submitted_at: submittedAt,
    });
    console.error(
      `[LadderExit] Flatten still unfilled for #${position.id} — ` +
        `background retry until closed (stop NOT restored)`
    );
    return {
      position,
      reason: null,
      skipped: false,
      pendingClose: true,
      flattenRetry: true,
      intendedReason,
      exitOrderId: null,
      stopRestored: false,
      closeReason: null,
      ...(isHardStop
        ? {
            escalated: true,
            hardStopLimitPrice,
            hardStopTriggerPrice,
            skippedLimitEscalation: skipLimitEscalation,
          }
        : {}),
    };
  }

  if (orderId && cancelExitOrder) {
    try {
      await cancelExitOrder(orderId);
    } catch (err) {
      console.warn(`[LadderExit] cancel unfilled STC ${orderId} failed:`, err.message);
    }
  }

  await persistPending(updatePendingClose, position, {
    pending_close_order_id: null,
    pending_close_reason: intendedReason,
    pending_close_submitted_at: submittedAt,
  });
  const restored = await restoreProtectiveStop(position, brokerStop, restoreStopPnlFrac, {
    getOpenPosition,
  });
  console.warn(
    `[LadderExit] STC not filled for #${position.id} reason=${intendedReason} ` +
      `order=${orderId || 'none'} — trade log NOT closed; stopRestored=${restored.restored}` +
      `${restored.retrying ? ' restoreRetrying=true' : ''}`
  );
  return {
    position,
    reason: null,
    skipped: false,
    pendingClose: true,
    intendedReason,
    exitOrderId: orderId,
    stopRestored: restored.restored,
    restoreRetrying: Boolean(restored.retrying),
    closeReason: null,
  };
}

async function settlePendingCloseOrder({
  position,
  currentPremium,
  pnlFrac,
  isTimeStop,
  brokerStop,
  flattenBrokerOrder,
  closeBrokerOrder,
  fullClosePosition,
  onNotify,
  cancelExitOrder,
  getExitOrderStatus,
  updatePendingClose,
  getOpenPosition = null,
  hardStopPct = null,
}) {
  const orderId = position.pending_close_order_id;
  if (!orderId || !getExitOrderStatus) return null;

  let status;
  try {
    status = await getExitOrderStatus(orderId);
  } catch (err) {
    console.warn(`[LadderExit] pending close status failed for ${orderId}:`, err.message);
    return null;
  }

  const closeQty = position.contracts_open ?? position.quantity;
  const intendedReason = position.pending_close_reason || LADDER_CLOSE_REASON.PROFIT_TARGET;
  const isHardStop = intendedReason === LADDER_CLOSE_REASON.HARD_STOP;
  const hardStopNotifyMeta = isHardStop
    ? buildHardStopNotifyMeta({
        escalated: false,
        hardStopTriggerPrice: computeHardStopTriggerPrice(position.entry_premium, hardStopPct),
        hardStopLimitPrice: computeHardStopCloseLimitPrice(
          computeHardStopTriggerPrice(position.entry_premium, hardStopPct)
        ),
        skippedLimitEscalation: false,
      })
    : null;

  if (status?.isFilled && !closeFillIsConfirmed(status)) {
    console.error(
      `[LadderExit] pending STC ${orderId} filled without a confirmed fill price ` +
        `#${position.id} — not booking`
    );
    return null;
  }

  if (closeFillIsConfirmed(status)) {
    const exitPremium = status.fillPrice;
    const fillPnl = pnlFracFromFill(position, exitPremium, pnlFrac);
    return attachHardStopCloseMeta(
      await closeNow({
        position,
        exitPremium,
        pnlFrac: fillPnl,
        reason: intendedReason,
        closeQty,
        fullClosePosition,
        onNotify,
        updatePendingClose,
        notifyMeta: hardStopNotifyMeta,
      }),
      {
        isHardStop,
        escalated: false,
        hardStopLimitPrice: hardStopNotifyMeta?.hardStopLimitPrice,
        hardStopTriggerPrice: hardStopNotifyMeta?.hardStopTriggerPrice,
        skippedLimitEscalation: false,
      }
    );
  }

  const working = status && !status.isTerminal;
  const plan = planUnfilledExit({ intendedReason, isTimeStop });

  if (working && plan.action === 'flatten') {
    try {
      if (cancelExitOrder) await cancelExitOrder(orderId);
    } catch (err) {
      console.warn(`[LadderExit] cancel pending STC ${orderId} failed:`, err.message);
    }
    const flatten = flattenBrokerOrder || closeBrokerOrder;
    const flattenResult = await syncFlattenUntilClosed(position, {
      flattenBrokerOrder: flatten,
      flattenPrice: plan.flattenPrice,
      closeQty,
      getOpenPosition,
      logLabel: 'LadderExit',
      settleFilled: async (filled) => {
        if (!filled?.noBrokerPosition && !closeFillIsConfirmed(filled)) {
          console.error(
            `[LadderExit] pending flatten without confirmed fill price #${position.id} — not booking`
          );
          return;
        }
        const booked = filled.noBrokerPosition
          ? bookNoBrokerPosition({
              closeResult: filled,
              position,
              currentPremium,
              pnlFrac,
            })
          : {
              exitPremium: filled.fillPrice,
              pnlFrac: pnlFracFromFill(position, filled.fillPrice, pnlFrac),
              reason: plan.closeReason,
            };
        await closeNow({
          position,
          exitPremium: booked.exitPremium,
          pnlFrac: booked.pnlFrac,
          reason: booked.reason,
          closeQty,
          fullClosePosition,
          onNotify,
          updatePendingClose,
          notifyMeta: isHardStop ? { ...hardStopNotifyMeta, escalated: true } : null,
        });
      },
    });
    if (
      flattenResult?.noBrokerPosition ||
      closeFillIsConfirmed(flattenResult)
    ) {
      const booked = flattenResult.noBrokerPosition
        ? bookNoBrokerPosition({
            closeResult: flattenResult,
            position,
            currentPremium,
            pnlFrac,
          })
        : {
            exitPremium: flattenResult.fillPrice,
            pnlFrac: pnlFracFromFill(position, flattenResult.fillPrice, pnlFrac),
            reason: plan.closeReason,
          };
      return attachHardStopCloseMeta(
        await closeNow({
          position,
          exitPremium: booked.exitPremium,
          pnlFrac: booked.pnlFrac,
          reason: booked.reason,
          closeQty,
          fullClosePosition,
          onNotify,
          updatePendingClose,
          notifyMeta: isHardStop ? { ...hardStopNotifyMeta, escalated: true } : null,
        }),
        {
          isHardStop,
          escalated: true,
          hardStopLimitPrice: hardStopNotifyMeta?.hardStopLimitPrice,
          hardStopTriggerPrice: hardStopNotifyMeta?.hardStopTriggerPrice,
          skippedLimitEscalation: false,
        }
      );
    }
    await persistPending(updatePendingClose, position, {
      pending_close_order_id: null,
      pending_close_reason: intendedReason,
      pending_close_submitted_at: position.pending_close_submitted_at,
    });
    return {
      position,
      pendingClose: true,
      flattenRetry: true,
      intendedReason,
      stopRestored: false,
      closeReason: null,
    };
  }

  if (!working || plan.action === 'restore_stop') {
    if (working && cancelExitOrder) {
      try {
        await cancelExitOrder(orderId);
      } catch (err) {
        console.warn(`[LadderExit] cancel pending STC ${orderId} failed:`, err.message);
      }
    }
    await persistPending(updatePendingClose, position, {
      pending_close_order_id: null,
      pending_close_reason: intendedReason,
      pending_close_submitted_at: position.pending_close_submitted_at,
    });
    await restoreProtectiveStop(position, brokerStop, null, { getOpenPosition });
    return {
      position,
      pendingClose: true,
      intendedReason,
      stopRestored: true,
      closeReason: null,
    };
  }

  return null;
}

export async function handleLadderPositionMonitor(position, {
  currentPremium,
  initialStopPct = LADDER_INITIAL_STOP_PCT,
  hardStopPct = LADDER_HARD_STOP_PCT,
  isTimeStop = false,
  updateExcursion,
  updateLadderState,
  partialCloseLeg,
  fullClosePosition,
  closeBrokerOrder,
  flattenBrokerOrder = null,
  onNotify,
  brokerStop = null,
  cancelExitOrder = null,
  getExitOrderStatus = null,
  updatePendingClose = null,
  fullPositionExits = false,
  getOpenPosition = null,
  settleIfBrokerFlat = null,
}) {
  if (isFlattenRetryInFlight(position.id)) {
    return {
      position,
      pendingClose: true,
      flattenRetryInFlight: true,
      closeReason: null,
    };
  }

  if (typeof settleIfBrokerFlat === 'function') {
    try {
      const settled = await settleIfBrokerFlat(position);
      if (settled?.settled) {
        return {
          position,
          reason: settled.reason,
          closeReason: settled.reason,
          exitPremium: settled.exitPremium,
          pnlFrac: settled.pnlFrac,
          brokerAlreadyFlat: true,
          brokerFillConfirmed: settled.exitPremium != null,
        };
      }
    } catch (err) {
      console.warn(
        `[LadderExit] broker-flat settle failed #${position.id}:`,
        err.message
      );
    }
  }

  const brokerStopActive = !!(brokerStop?.enabled && position.broker_stop_order_id);
  let skipPollStops = brokerStopActive;

  const confirmedLong = positionHasConfirmedBrokerLong(position);

  if (position.pending_close_order_id) {
    const settled = await settlePendingCloseOrder({
      position,
      currentPremium,
      pnlFrac: null,
      isTimeStop,
      brokerStop,
      flattenBrokerOrder,
      closeBrokerOrder,
      fullClosePosition,
      onNotify,
      cancelExitOrder,
      getExitOrderStatus,
      updatePendingClose,
      getOpenPosition,
      hardStopPct,
    });
    if (settled?.brokerFillConfirmed || settled?.reason) {
      return settled;
    }
  }

  // Zero-fill: no broker long yet — skip poll exits including hard stop.
  // Time-stop still proceeds so a leftover working BTO is cancelled at EOD.
  if (!confirmedLong && !isTimeStop) {
    return {
      position,
      skipped: true,
      reason: 'entry_not_filled',
      closeReason: null,
    };
  }

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

  let decision = evaluateLadderExit({
    pnlFrac,
    exitPhase: position.exit_phase,
    contractsOpen,
    entryContracts,
    ratchetStopFrac: position.trail_peak_pnl_frac,
    initialStopPct,
    hardStopPct,
    isTimeStop,
    skipPollStops: skipPollStops || !confirmedLong,
    skipHardStop: !confirmedLong,
    fullPositionExits,
  });

  const skipDiscretionary =
    !isTimeStop &&
    shouldSkipDiscretionaryRetry({
      pendingCloseSubmittedAt: position.pending_close_submitted_at,
    }) &&
    decision.action !== 'hold' &&
    !isRiskExitReason(decision.reason);

  if (skipDiscretionary) {
    decision = { action: 'hold' };
  }

  if (decision.action === 'hold') {
    return { position, pnlFrac, currentPremium, closeReason: null };
  }

  if (decision.action === 'scale_out') {
    const closeQty = decision.contracts;
    if (brokerStopActive) {
      await brokerStop.cancelStop(position);
      position.broker_stop_order_id = null;
    }
    const closeResult = await closeBrokerOrder(position, currentPremium, closeQty);
    if (closeResult?.noBrokerPosition) {
      const booked = bookNoBrokerPosition({
        closeResult,
        position,
        currentPremium,
        pnlFrac,
      });
      return closeNow({
        position,
        exitPremium: booked.exitPremium,
        pnlFrac: booked.pnlFrac,
        reason: booked.reason,
        closeQty,
        fullClosePosition,
        onNotify,
        updatePendingClose,
      });
    }
    if (!closeFillIsConfirmed(closeResult)) {
      const orderId = closeResult?.orderId ? String(closeResult.orderId) : null;
      if (orderId && cancelExitOrder) {
        try {
          await cancelExitOrder(orderId);
        } catch (err) {
          console.warn(`[LadderExit] cancel unfilled scale-out ${orderId} failed:`, err.message);
        }
      }
      await persistPending(updatePendingClose, position, {
        pending_close_order_id: null,
        pending_close_reason: decision.reason,
        pending_close_submitted_at: new Date().toISOString(),
      });
      await restoreProtectiveStop(position, brokerStop, null, { getOpenPosition });
      console.warn(
        `[LadderExit] scale-out STC not filled for #${position.id} — partial log NOT written; stop restored`
      );
      return {
        position,
        pendingClose: true,
        intendedReason: decision.reason,
        stopRestored: true,
        closeReason: null,
      };
    }
    const exitPremium = closeResult.fillPrice;
    const fillPnl = pnlFracFromFill(position, exitPremium, pnlFrac);
    await partialCloseLeg(position.id, exitPremium, fillPnl * 100, decision.reason, closeQty, {
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
      await onNotify(position, decision.reason, fillPnl, exitPremium, closeQty);
    }
    return {
      position,
      reason: decision.reason,
      pnlFrac: fillPnl,
      exitPremium,
      contractsClosed: closeQty,
      brokerFillConfirmed: true,
    };
  }

  if (decision.action === 'close_all') {
    return submitAndSettleFullClose({
      position,
      closeQty: decision.contracts,
      currentPremium,
      pnlFrac,
      intendedReason: decision.reason,
      isTimeStop,
      brokerStop,
      closeBrokerOrder,
      flattenBrokerOrder,
      fullClosePosition,
      onNotify,
      cancelExitOrder,
      updatePendingClose,
      getOpenPosition,
      hardStopPct,
    });
  }

  return { position, pnlFrac, currentPremium, closeReason: null };
}
