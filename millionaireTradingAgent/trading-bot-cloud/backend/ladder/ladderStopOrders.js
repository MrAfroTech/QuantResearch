import {
  cancelBrokerOrder,
  getBrokerOrderStatus,
  replaceOptionStopOrder,
  submitOptionStopOrder,
  verifyBrokerOrderTerminated,
} from '../brokerageConnector.js';
import {
  brokerStopFillIsConfirmed,
  hasConfirmedFillPrice,
  isCancelConfirmed,
} from './orderFillStatus.js';
import { ensureInitialBrokerStopUntilProtected } from './initialStopRetry.js';
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

/** Distinct event when cancel/place and restore both fail — position has no resting stop. */
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

  try {
    const result = await cancelBrokerOrder(orderId, { environment, strategy });
    if (!isCancelConfirmed(result)) {
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
    console.error(`[LadderStop][${strategy}] Cancel failed for #${position.id}:`, err.message);
    return { cancelled: false, reason: err.message, error: err };
  }
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
  cancelStop = cancelLadderBrokerStop,
  verifyTerminated = verifyBrokerOrderTerminated,
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

  // Prefer Tastytrade PUT replace — atomic, no naked window, no second STC.
  if (prior.broker_stop_order_id) {
    try {
      const replaced = await replaceStopOrder(position, {
        existingOrderId: prior.broker_stop_order_id,
        quantity: params.quantity,
        stopTrigger: params.stopTrigger,
        limitPrice: params.limitPrice,
        orderType: params.orderType,
        environment,
        strategy,
      });
      if (replaced?.resting || replaced?.dryRun || replaced?.simulated) {
        const placed = {
          placed: true,
          replaced: true,
          ...params,
          ...replaced,
          stopTrigger: replaced.stopTrigger ?? params.stopTrigger,
          stopPnlFrac: params.stopPnlFrac,
        };
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
      console.warn(
        `[LadderStop][${strategy}] PUT replace not resting #${position.id} ` +
          `reason=${replaced?.reason || 'unknown'} — falling back to cancel-verify-place`
      );
    } catch (err) {
      console.warn(
        `[LadderStop][${strategy}] PUT replace failed #${position.id}: ${err.message} ` +
          `— falling back to cancel-verify-place`
      );
    }
  }

  // Fallback: two resting STCs cannot coexist (live 422 cannot_close / uncovered).
  // Cancel, confirm the old order is fully terminated, then POST the new stop.
  let cancelled = { cancelled: false };
  if (prior.broker_stop_order_id) {
    cancelled = await cancelStop(position, {
      strategy,
      environment,
      updateBrokerStopState,
    });
    if (cancelled?.cancelled) {
      position.broker_stop_order_id = null;
      position.broker_stop_trigger_price = null;
      position.broker_stop_pnl_frac = null;
    } else {
      return {
        placed: false,
        reason: cancelled?.reason || 'prior_stop_cancel_unconfirmed',
        cancelled: false,
      };
    }

    const released = await verifyTerminated(prior.broker_stop_order_id, {
      environment,
      strategy,
    });
    if (released?.filled) {
      return {
        placed: false,
        reason: 'prior_stop_filled',
        cancelled: true,
        filled: true,
      };
    }
    if (!released?.terminated) {
      return {
        placed: false,
        reason: released?.reason || 'prior_stop_still_working',
        cancelled: true,
        verified: false,
      };
    }
  }

  const placed = await placeStop(position, {
    strategy,
    environment,
    initialStopPct,
    stopPnlFrac,
    milestonesPct,
    updateBrokerStopState,
  });

  if (placed?.placed) {
    applyPlacedStopToPosition(position, placed);
    return { ...placed, replacedVia: prior.broker_stop_order_id ? 'cancel_verify_place' : 'place' };
  }

  let restored = { placed: false };
  if (prior.broker_stop_pnl_frac != null) {
    console.error(
      `[LadderStop][${strategy}] replace place failed #${position.id} ` +
        `reason=${placed?.reason || 'unknown'} — restoring prior stop ` +
        `pnlFrac=${prior.broker_stop_pnl_frac}`
    );
    restored = await placeStop(position, {
      strategy,
      environment,
      initialStopPct,
      stopPnlFrac: prior.broker_stop_pnl_frac,
      milestonesPct,
      updateBrokerStopState,
    });
    if (restored?.placed) {
      applyPlacedStopToPosition(position, restored);
    }
  }

  const unprotected = !restored?.placed && !position.broker_stop_order_id;
  if (unprotected) {
    await persistUnprotectedNoRestingStop(strategy, position, {
      old_broker_order_id: prior.broker_stop_order_id,
      old_trigger_price: prior.broker_stop_trigger_price,
      desired_trigger_price: params.stopTrigger,
      desired_pnl_frac: params.stopPnlFrac,
      place_reason: placed?.reason || 'replace_place_failed',
      restore_reason: restored?.reason || (prior.broker_stop_pnl_frac == null ? 'no_prior_frac' : 'restore_failed'),
    });
  }

  return {
    placed: false,
    reason: unprotected
      ? POSITION_UNPROTECTED_NO_RESTING_STOP
      : (placed?.reason || 'replace_place_failed'),
    restored: Boolean(restored?.placed),
    restoredOrderId: restored?.orderId ?? null,
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
  if (!orderId) return { filled: false };

  const status = await getBrokerOrderStatus(orderId, { environment, strategy });
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
    async placeInitialStop(position) {
      return placeLadderBrokerStop(position, {
        strategy,
        environment,
        initialStopPct,
        milestonesPct,
        updateBrokerStopState,
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
