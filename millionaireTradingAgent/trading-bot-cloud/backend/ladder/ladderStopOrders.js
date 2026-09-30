import {
  cancelBrokerOrder,
  getBrokerOrderStatus,
  replaceOptionStopOrder,
  submitOptionStopOrder,
} from '../brokerageConnector.js';
import {
  brokerStopFillIsConfirmed,
  hasConfirmedFillPrice,
  isBrokerOrderGoneError,
  isCancelConfirmed,
} from './orderFillStatus.js';
import { ensureInitialBrokerStopUntilProtected } from './initialStopRetry.js';
import {
  STOP_STATE,
  beginInitialStop,
  beginStopCancel,
  beginStopReplace,
  endInitialStop,
  endStopCancel,
  finishStopReplace,
  forgetUnconfirmedStop,
  isExitRequested,
  lookupUnconfirmedStop,
  releaseStopBookIfIdle,
  rememberUnconfirmedStop,
} from './stopBook.js';
import {
  LADDER_CLOSE_REASON,
  computeActiveStopPnlFrac,
  computeStopLimitPrice,
  computeStopTriggerPrice,
  isLadderBrokerStopEnabledForStrategy,
  resolveLadderStopOrderType,
} from './ladderConfig.js';

function inferCloseReasonFromStopPnl(stopPnlFrac) {
  return Number(stopPnlFrac) < 0 ? LADDER_CLOSE_REASON.STOP_LOSS : LADDER_CLOSE_REASON.TRAILING_STOP;
}

/** Distinct event when a stop place fails and no protective stop is resting. */
export const POSITION_UNPROTECTED_NO_RESTING_STOP = 'position_unprotected_no_resting_stop';

async function persistUnprotectedNoRestingStop(strategy, position, details) {
  const eventType = POSITION_UNPROTECTED_NO_RESTING_STOP;
  console.error(
    `[LadderStop][${strategy}] ${eventType} #${position?.id} ${position?.ticker || ''} ` +
      `prior_order=${details?.old_broker_order_id ?? 'none'} ` +
      `place=${details?.place_reason || 'n/a'} restore=${details?.restore_reason || 'n/a'} ` +
      `— no resting stop`
  );
  try {
    const { etDateKey } = await import('../orb/tradierTimesales.js');
    const payload = {
      ticker: position.ticker,
      tradeDate: etDateKey(),
      eventType,
      direction: position.direction || null,
      breakoutLevel: position.breakout_level ?? position.vwap_at_entry ?? null,
      details: {
        type: eventType,
        position_id: position.id,
        strike: position.strike,
        expiration: position.expiration,
        entry_premium: position.entry_premium,
        strategy,
        ...details,
      },
    };
    const key = String(strategy || '').toLowerCase();
    if (key === 'orb') {
      const { logOrbEvent } = await import('../orb/orbDb.js');
      await logOrbEvent(payload);
    } else if (key === 'premarket') {
      const { logPremarketEvent } = await import('../premarketBreakout/premarketDb.js');
      await logPremarketEvent(payload);
    } else if (key === 'emavwap') {
      const { logEmaVwapEvent } = await import('../emaVwapCross/emaVwapDb.js');
      await logEmaVwapEvent(payload);
    }
  } catch (err) {
    console.warn(`[LadderStop] persist ${eventType} failed:`, err.message);
  }
}

function applyPlacedStopToPosition(position, placed) {
  position.broker_stop_order_id = placed.orderId;
  position.broker_stop_trigger_price = placed.stopTrigger;
  position.broker_stop_pnl_frac = placed.stopPnlFrac;
}

/**
 * Finalize close reason for a broker stop fill.
 * When hardStopPct is provided (Premarket passes PREMARKET_HARD_STOP_TRIGGER) and the
 * fill's realized pnl is at/beyond that ceiling, attribute as hard_stop even though the
 * resting order was the soft broker stop — so poll-gap fills past hard are logged/labeled
 * consistently with the poll hard-stop path.
 */
export function resolveBrokerStopCloseReason(pnlFrac, hardStopPct = null) {
  const pnl = Number(pnlFrac);
  const hard = Number(hardStopPct);
  if (Number.isFinite(hard) && hard > 0 && Number.isFinite(pnl) && pnl <= -hard) {
    return LADDER_CLOSE_REASON.HARD_STOP;
  }
  return inferCloseReasonFromStopPnl(pnl);
}

export function buildBrokerStopOrderParams(
  position,
  { initialStopPct, stopPnlFrac = null, milestonesPct } = {}
) {
  const pnlFrac =
    stopPnlFrac ??
    computeActiveStopPnlFrac({
      exitPhase: position.exit_phase,
      ratchetStopFrac: position.trail_peak_pnl_frac,
      initialStopPct,
      milestonesPct,
    });

  const trigger = computeStopTriggerPrice(position.entry_premium, pnlFrac);
  if (trigger == null) return null;

  const orderType = resolveLadderStopOrderType();
  const limitPrice =
    orderType === 'stop_limit' ? computeStopLimitPrice(trigger) : null;

  return {
    stopPnlFrac: pnlFrac,
    stopTrigger: trigger,
    limitPrice,
    orderType,
    quantity: position.contracts_open ?? position.quantity,
  };
}

export async function placeLadderBrokerStop(position, {
  strategy,
  environment,
  initialStopPct,
  stopPnlFrac = null,
  milestonesPct,
  updateBrokerStopState,
}) {
  if (!isLadderBrokerStopEnabledForStrategy(strategy)) {
    return { placed: false, reason: 'disabled' };
  }

  const params = buildBrokerStopOrderParams(position, {
    initialStopPct,
    stopPnlFrac,
    milestonesPct,
  });
  if (!params || !params.quantity) {
    return { placed: false, reason: 'invalid_params' };
  }

  if (isExitRequested(strategy, position.id)) {
    return { placed: false, reason: 'exit_requested' };
  }

  const pending = lookupUnconfirmedStop(strategy, position);
  if (pending?.state === STOP_STATE.ABSENT) {
    forgetUnconfirmedStop(strategy, position, pending.orderId);
  } else if (
    pending?.orderId &&
    (pending.state === STOP_STATE.PLACED_UNCONFIRMED ||
      pending.state === STOP_STATE.UNKNOWN ||
      pending.state === STOP_STATE.CANCEL_REQUESTED_UNCONFIRMED ||
      pending.state === STOP_STATE.FILLED)
  ) {
    if (updateBrokerStopState) {
      await updateBrokerStopState(position.id, {
        broker_stop_order_id: pending.orderId,
        broker_stop_trigger_price: params.stopTrigger,
        broker_stop_pnl_frac: params.stopPnlFrac,
      });
    }
    position.broker_stop_order_id = pending.orderId;
    console.error(
      `[LadderStop][${strategy}] Stop already accepted but unconfirmed #${position.id} ` +
        `order=${pending.orderId} — reconciling, not posting another stop`
    );
    return {
      placed: false,
      unresolved: true,
      reason: 'stop_status_unconfirmed',
      stopProtectionState: pending.state,
      orderId: pending.orderId,
      stopTrigger: params.stopTrigger,
      stopPnlFrac: params.stopPnlFrac,
    };
  }

  try {
    const result = await submitOptionStopOrder(position, {
      quantity: params.quantity,
      stopTrigger: params.stopTrigger,
      limitPrice: params.limitPrice,
      orderType: params.orderType,
      environment,
      strategy,
    });

    if (!result?.resting && !result?.dryRun && !result?.simulated) {
      const unconfirmed =
        Boolean(result?.orderId) &&
        (result.reason === 'stop_status_unconfirmed' ||
          result.stopProtectionState === STOP_STATE.UNKNOWN ||
          result.stopProtectionState === STOP_STATE.PLACED_UNCONFIRMED);
      if (unconfirmed) {
        rememberUnconfirmedStop(strategy, position, result.orderId, STOP_STATE.PLACED_UNCONFIRMED);
        if (updateBrokerStopState) {
          await updateBrokerStopState(position.id, {
            broker_stop_order_id: result.orderId,
            broker_stop_trigger_price: params.stopTrigger,
            broker_stop_pnl_frac: params.stopPnlFrac,
          });
        }
        position.broker_stop_order_id = result.orderId;
        console.error(
          `[LadderStop][${strategy}] Stop accepted but unconfirmed #${position.id} ` +
            `order=${result.orderId} reason=${result.reason || 'stop_status_unconfirmed'} ` +
            `— keeping id, not posting another stop`
        );
        return {
          placed: false,
          unresolved: true,
          reason: 'stop_status_unconfirmed',
          stopProtectionState: STOP_STATE.PLACED_UNCONFIRMED,
          orderId: result.orderId,
          status: result.status ?? null,
          stopTrigger: params.stopTrigger,
          stopPnlFrac: params.stopPnlFrac,
        };
      }
      console.error(
        `[LadderStop][${strategy}] Stop submit not resting #${position.id} ` +
          `order=${result?.orderId || 'none'} reason=${result?.reason || 'not_resting'}`
      );
      return {
        placed: false,
        reason: result?.reason || 'stop_not_resting',
        orderId: result?.orderId ?? null,
        status: result?.status ?? null,
      };
    }

    const confirmedTrigger =
      Number(result.stopTrigger) > 0 ? Number(result.stopTrigger) : params.stopTrigger;
    const confirmedQty =
      Math.floor(Number(result.quantity)) >= 1
        ? Math.floor(Number(result.quantity))
        : params.quantity;

    forgetUnconfirmedStop(strategy, position, result.orderId);
    if (updateBrokerStopState) {
      await updateBrokerStopState(position.id, {
        broker_stop_order_id: result.orderId,
        broker_stop_trigger_price: confirmedTrigger,
        broker_stop_pnl_frac: params.stopPnlFrac,
      });
    }

    console.log(
      `[LadderStop][${strategy}] Placed ${params.orderType} stop #${position.id} ` +
        `qty=${confirmedQty} trigger=$${confirmedTrigger} order=${result.orderId}`
    );

    return {
      placed: true,
      ...params,
      ...result,
      stopTrigger: confirmedTrigger,
      quantity: confirmedQty,
    };
  } catch (err) {
    console.error(`[LadderStop][${strategy}] Failed to place stop for #${position.id}:`, err.message);
    return { placed: false, reason: err.message, error: err };
  }
}

export async function cancelLadderBrokerStop(position, { strategy, environment, updateBrokerStopState }) {
  const orderId = position.broker_stop_order_id;
  if (!orderId) return { cancelled: false, reason: 'no_stop_order' };
  if (!beginStopCancel(strategy, position.id)) {
    return { cancelled: false, reason: 'stop_mutation_in_flight', orderId };
  }

  try {
    const result = await cancelBrokerOrder(orderId, { environment, strategy });
    if (!isCancelConfirmed(result)) {
      rememberUnconfirmedStop(
        strategy,
        position,
        orderId,
        STOP_STATE.CANCEL_REQUESTED_UNCONFIRMED
      );
      console.error(
        `[LadderStop][${strategy}] Cancel not confirmed for #${position.id} order=${orderId} ` +
          `reason=${result?.reason || 'n/a'} — leaving broker_stop_order_id in place`
      );
      return {
        cancelled: false,
        reason: result?.reason || 'cancel_unconfirmed',
        orderId,
        status: result?.status ?? null,
      };
    }
    forgetUnconfirmedStop(strategy, position, orderId);
    if (updateBrokerStopState) {
      await updateBrokerStopState(position.id, {
        broker_stop_order_id: null,
        broker_stop_trigger_price: null,
        broker_stop_pnl_frac: null,
      });
    }
    console.log(`[LadderStop][${strategy}] Cancelled stop order ${orderId} for #${position.id}`);
    return { cancelled: true, orderId };
  } catch (err) {
    rememberUnconfirmedStop(strategy, position, orderId, STOP_STATE.UNKNOWN);
    console.error(`[LadderStop][${strategy}] Cancel failed for #${position.id}:`, err.message);
    return { cancelled: false, reason: err.message, error: err };
  } finally {
    endStopCancel(strategy, position.id);
  }
}

function keptPriorProtectiveStop(position, prior, reason, error = null) {
  position.broker_stop_order_id = prior.broker_stop_order_id;
  position.broker_stop_trigger_price = prior.broker_stop_trigger_price;
  position.broker_stop_pnl_frac = prior.broker_stop_pnl_frac;
  return {
    placed: false,
    reason,
    keptPriorStop: true,
    unprotected: false,
    orderId: prior.broker_stop_order_id,
    stopTrigger: prior.broker_stop_trigger_price,
    stopPnlFrac: prior.broker_stop_pnl_frac,
    error,
  };
}

export async function replaceLadderBrokerStop(position, {
  strategy,
  environment,
  initialStopPct,
  stopPnlFrac,
  milestonesPct,
  updateBrokerStopState,
  replaceStopOrder = replaceOptionStopOrder,
  placeStop = placeLadderBrokerStop,
} = {}) {
  if (!isLadderBrokerStopEnabledForStrategy(strategy)) {
    return { placed: false, reason: 'disabled' };
  }

  const params = buildBrokerStopOrderParams(position, {
    initialStopPct,
    stopPnlFrac,
    milestonesPct,
  });
  if (!params || !params.quantity) {
    return { placed: false, reason: 'invalid_params' };
  }

  const prior = {
    broker_stop_order_id: position.broker_stop_order_id ?? null,
    broker_stop_trigger_price: position.broker_stop_trigger_price ?? null,
    broker_stop_pnl_frac: position.broker_stop_pnl_frac ?? null,
  };

  // A working protective stop stays until Tastytrade accepts the PUT replace.
  // Two resting STCs cannot coexist, so a failed replace must not cancel first
  // and must not POST a second sell. The ratchet retries this same PUT.
  if (isExitRequested(strategy, position.id)) {
    if (prior.broker_stop_order_id) {
      return keptPriorProtectiveStop(position, prior, 'exit_requested');
    }
    return { placed: false, reason: 'exit_requested' };
  }

  if (prior.broker_stop_order_id) {
    if (!beginStopReplace(strategy, position.id)) {
      return keptPriorProtectiveStop(position, prior, 'stop_mutation_in_flight');
    }
    let replaced;
    try {
      replaced = await replaceStopOrder(position, {
        existingOrderId: prior.broker_stop_order_id,
        quantity: params.quantity,
        stopTrigger: params.stopTrigger,
        limitPrice: params.limitPrice,
        orderType: params.orderType,
        environment,
        strategy,
      });
    } catch (err) {
      finishStopReplace(strategy, position.id);
      console.error(
        `[LadderStop][${strategy}] replace failed #${position.id}: ${err.message} ` +
          `— keeping prior protective stop ${prior.broker_stop_order_id} ` +
          `trigger=$${prior.broker_stop_trigger_price ?? 'n/a'}`
      );
      return keptPriorProtectiveStop(position, prior, err.message, err);
    }
    const gate = finishStopReplace(strategy, position.id);
    if (gate.exitRequested) {
      console.error(
        `[LadderStop][${strategy}] replace finished during exit #${position.id} ` +
          `— not adopting ${replaced?.orderId || 'n/a'}; keeping ${prior.broker_stop_order_id}`
      );
      return keptPriorProtectiveStop(position, prior, 'exit_requested_during_replace');
    }
    try {
      if (replaced?.resting || replaced?.dryRun || replaced?.simulated) {
        const placed = {
          placed: true,
          replaced: true,
          ...params,
          ...replaced,
          stopTrigger: replaced.stopTrigger ?? params.stopTrigger,
          stopPnlFrac: params.stopPnlFrac,
        };
        forgetUnconfirmedStop(strategy, position, prior.broker_stop_order_id);
        applyPlacedStopToPosition(position, placed);
        if (updateBrokerStopState) {
          await updateBrokerStopState(position.id, {
            broker_stop_order_id: placed.orderId,
            broker_stop_trigger_price: placed.stopTrigger,
            broker_stop_pnl_frac: placed.stopPnlFrac,
          });
        }
        console.log(
          `[LadderStop][${strategy}] PUT-replaced stop #${position.id} ` +
            `${prior.broker_stop_order_id} → ${placed.orderId} trigger=$${placed.stopTrigger}`
        );
        return placed;
      }
      const unconfirmedReplacement =
        Boolean(replaced?.orderId) &&
        (replaced.reason === 'stop_status_unconfirmed' ||
          replaced.stopProtectionState === STOP_STATE.UNKNOWN ||
          replaced.stopProtectionState === STOP_STATE.PLACED_UNCONFIRMED);
      if (unconfirmedReplacement) {
        forgetUnconfirmedStop(strategy, position, prior.broker_stop_order_id);
        rememberUnconfirmedStop(strategy, position, replaced.orderId, STOP_STATE.PLACED_UNCONFIRMED);
        position.broker_stop_order_id = replaced.orderId;
        position.broker_stop_trigger_price = params.stopTrigger;
        position.broker_stop_pnl_frac = params.stopPnlFrac;
        if (updateBrokerStopState) {
          await updateBrokerStopState(position.id, {
            broker_stop_order_id: replaced.orderId,
            broker_stop_trigger_price: params.stopTrigger,
            broker_stop_pnl_frac: params.stopPnlFrac,
          });
        }
        console.error(
          `[LadderStop][${strategy}] PUT accepted but unconfirmed #${position.id} ` +
            `${prior.broker_stop_order_id} → ${replaced.orderId} — keeping new id, not posting`
        );
        return {
          placed: false,
          unresolved: true,
          replaced: true,
          reason: 'stop_status_unconfirmed',
          stopProtectionState: STOP_STATE.PLACED_UNCONFIRMED,
          orderId: replaced.orderId,
          stopTrigger: params.stopTrigger,
          stopPnlFrac: params.stopPnlFrac,
          keptPriorStop: false,
          unprotected: false,
        };
      }
      console.error(
        `[LadderStop][${strategy}] replace not confirmed #${position.id} ` +
          `reason=${replaced?.reason || 'not_resting'} ` +
          `— keeping prior protective stop ${prior.broker_stop_order_id} ` +
          `trigger=$${prior.broker_stop_trigger_price ?? 'n/a'}`
      );
      return keptPriorProtectiveStop(
        position,
        prior,
        replaced?.reason || 'replace_not_confirmed'
      );
    } catch (err) {
      console.error(
        `[LadderStop][${strategy}] replace failed #${position.id}: ${err.message} ` +
          `— keeping prior protective stop ${prior.broker_stop_order_id} ` +
          `trigger=$${prior.broker_stop_trigger_price ?? 'n/a'}`
      );
      return keptPriorProtectiveStop(position, prior, err.message, err);
    }
  }

  if (!beginStopReplace(strategy, position.id)) {
    return { placed: false, reason: 'stop_mutation_in_flight' };
  }
  let replaceGate = { exitRequested: false };
  const placed = await placeStop(position, {
    strategy,
    environment,
    initialStopPct,
    stopPnlFrac,
    milestonesPct,
    updateBrokerStopState,
  }).finally(() => {
    replaceGate = finishStopReplace(strategy, position.id);
  });
  if (replaceGate.exitRequested) {
    const discoveredId =
      placed?.orderId ||
      (position.broker_stop_order_id &&
      position.broker_stop_order_id !== prior.broker_stop_order_id
        ? position.broker_stop_order_id
        : null);
    position.broker_stop_order_id = prior.broker_stop_order_id;
    position.broker_stop_trigger_price = prior.broker_stop_trigger_price;
    position.broker_stop_pnl_frac = prior.broker_stop_pnl_frac;
    if (discoveredId && !prior.broker_stop_order_id) {
      rememberUnconfirmedStop(
        strategy,
        position,
        discoveredId,
        STOP_STATE.PLACED_UNCONFIRMED
      );
    }
    if (updateBrokerStopState) {
      await updateBrokerStopState(position.id, {
        broker_stop_order_id: prior.broker_stop_order_id,
        broker_stop_trigger_price: prior.broker_stop_trigger_price,
        broker_stop_pnl_frac: prior.broker_stop_pnl_frac,
      });
    }
    return {
      placed: false,
      adopted: false,
      reason: 'exit_requested_during_replace',
      orderId: discoveredId,
      keptPriorStop: false,
      unprotected: !position.broker_stop_order_id,
    };
  }

  if (placed?.placed) {
    applyPlacedStopToPosition(position, placed);
    return { ...placed, replacedVia: 'place' };
  }

  const unprotected = !position.broker_stop_order_id;
  if (unprotected) {
    await persistUnprotectedNoRestingStop(strategy, position, {
      old_broker_order_id: null,
      old_trigger_price: null,
      desired_trigger_price: params.stopTrigger,
      desired_pnl_frac: params.stopPnlFrac,
      place_reason: placed?.reason || 'replace_place_failed',
      restore_reason: 'no_prior_stop',
    });
  }

  return {
    placed: false,
    reason: unprotected
      ? POSITION_UNPROTECTED_NO_RESTING_STOP
      : (placed?.reason || 'replace_place_failed'),
    restored: false,
    restoredOrderId: null,
    unprotected,
    error: placed?.error,
  };
}

export async function checkLadderBrokerStopFill(position, {
  strategy,
  environment,
  hardStopPct = null,
}) {
  const orderId = position.broker_stop_order_id;
  if (!orderId) return { filled: false, stopProtectionState: STOP_STATE.NONE };

  let status;
  try {
    status = await getBrokerOrderStatus(orderId, { environment, strategy });
  } catch (err) {
    if (isBrokerOrderGoneError(err)) {
      return {
        filled: false,
        gone: true,
        stopProtectionState: STOP_STATE.ABSENT,
        status: { isTerminal: true, gone: true, isFilled: false, status: 'not_found' },
      };
    }
    return {
      filled: false,
      unknown: true,
      stopProtectionState: STOP_STATE.UNKNOWN,
      reason: err.message,
    };
  }
  if (!brokerStopFillIsConfirmed(status)) {
    return { filled: false, awaitingFillDetails: Boolean(status?.isFilled), status };
  }

  const fillPrice = status.fillPrice;
  const fillQuantity = Math.floor(Number(status.fillQuantity) || 0);
  const entry = Number(position.entry_premium);
  if (!(Number.isFinite(entry) && entry > 0)) {
    return { filled: false, reason: 'invalid_entry', status };
  }
  const pnlFrac = (fillPrice - entry) / entry;

  const closeReason = resolveBrokerStopCloseReason(pnlFrac, hardStopPct);

  return {
    filled: true,
    fillPrice,
    fillQuantity,
    pnlFrac,
    pnlPct: pnlFrac * 100,
    closeReason,
    status,
  };
}

export function createLadderBrokerStopHandlers({
  strategy,
  environment,
  initialStopPct,
  hardStopPct = null,
  milestonesPct,
  updateBrokerStopState,
  fullClosePosition,
  onNotify,
  resolveCloseReason = null,
}) {
  const enabled = isLadderBrokerStopEnabledForStrategy(strategy);

  function finalizeCloseReason(pnlFrac, position) {
    const defaultReason = resolveBrokerStopCloseReason(pnlFrac, hardStopPct);
    if (typeof resolveCloseReason !== 'function') return defaultReason;
    return resolveCloseReason({ pnlFrac, position, defaultReason }) || defaultReason;
  }

  return {
    enabled,
    strategy,
    async placeInitialStop(position) {
      if (!beginInitialStop(strategy, position?.id)) {
        return {
          placed: false,
          reason: isExitRequested(strategy, position?.id)
            ? 'exit_requested'
            : 'stop_mutation_in_flight',
        };
      }
      try {
        return await placeLadderBrokerStop(position, {
          strategy,
          environment,
          initialStopPct,
          milestonesPct,
          updateBrokerStopState,
        });
      } finally {
        endInitialStop(strategy, position?.id);
      }
    },
    async noteReconciledStop(position) {
      if (!updateBrokerStopState || !position?.broker_stop_order_id) return;
      await updateBrokerStopState(position.id, {
        broker_stop_order_id: position.broker_stop_order_id,
        broker_stop_trigger_price: position.broker_stop_trigger_price ?? null,
        broker_stop_pnl_frac: position.broker_stop_pnl_frac ?? null,
      });
    },
    ensureInitialStopUntilProtected(position, extras = {}) {
      return ensureInitialBrokerStopUntilProtected(position, {
        strategy,
        environment,
        placeStop: (row) =>
          placeLadderBrokerStop(row || position, {
            strategy,
            environment,
            initialStopPct,
            milestonesPct,
            updateBrokerStopState,
          }),
        ...extras,
      });
    },
    async checkFill(position) {
      if (!enabled || !position.broker_stop_order_id) return { filled: false };
      const fill = await checkLadderBrokerStopFill(position, { strategy, environment, hardStopPct });
      if (fill?.filled) {
        fill.closeReason = finalizeCloseReason(fill.pnlFrac, position);
      }
      return fill;
    },
    async onStopFilled(position, fill) {
      if (!hasConfirmedFillPrice(fill) || Math.floor(Number(fill.fillQuantity) || 0) < 1) {
        console.error(
          `[LadderStop][${strategy}] Stop fill missing confirmed price/qty for #${position.id} ` +
            `fill=${fill?.fillPrice ?? 'n/a'} qty=${fill?.fillQuantity ?? 'n/a'} — not booking close`
        );
        return {
          position,
          skipped: true,
          reason: 'stop_fill_unconfirmed',
          closeReason: null,
        };
      }
      const closeQty = Math.floor(Number(fill.fillQuantity));
      const exitPremium = Number(fill.fillPrice);
      const entry = Number(position.entry_premium);
      const pnlFrac =
        Number.isFinite(Number(fill.pnlFrac))
          ? Number(fill.pnlFrac)
          : (exitPremium - entry) / entry;
      // Re-resolve here so attribution stays correct even if checkFill omitted hardStopPct.
      const closeReason = finalizeCloseReason(pnlFrac, position);
      const pnlPct = pnlFrac * 100;

      if (updateBrokerStopState) {
        await updateBrokerStopState(position.id, {
          broker_stop_order_id: null,
          broker_stop_trigger_price: null,
          broker_stop_pnl_frac: null,
        });
      }
      await fullClosePosition(position.id, exitPremium, pnlPct, closeReason, closeQty);
      releaseStopBookIfIdle(strategy, position.id);
      // Same object must not be booked again if this poll continues.
      position.broker_stop_order_id = null;
      position.broker_stop_trigger_price = null;
      position.broker_stop_pnl_frac = null;

      if (onNotify) {
        await onNotify(position, closeReason, pnlFrac, exitPremium, closeQty);
      }

      return {
        position,
        reason: closeReason,
        pnlFrac,
        exitPremium,
        contractsClosed: closeQty,
        brokerStopFill: true,
      };
    },
    async cancelStop(position) {
      return cancelLadderBrokerStop(position, { strategy, environment, updateBrokerStopState });
    },
    async replaceStop(position, stopPnlFrac) {
      return replaceLadderBrokerStop(position, {
        strategy,
        environment,
        initialStopPct,
        stopPnlFrac,
        milestonesPct,
        updateBrokerStopState,
      });
    },
    async clearStopState(position) {
      if (!updateBrokerStopState) return;
      await updateBrokerStopState(position.id, {
        broker_stop_order_id: null,
        broker_stop_trigger_price: null,
        broker_stop_pnl_frac: null,
      });
    },
  };
}
