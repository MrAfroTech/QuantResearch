import {
  cancelBrokerOrder,
  getBrokerOrderStatus,
  submitOptionStopOrder,
} from '../brokerageConnector.js';
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

export function buildBrokerStopOrderParams(position, { initialStopPct, stopPnlFrac = null } = {}) {
  const pnlFrac =
    stopPnlFrac ??
    computeActiveStopPnlFrac({
      exitPhase: position.exit_phase,
      ratchetStopFrac: position.trail_peak_pnl_frac,
      initialStopPct,
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
  updateBrokerStopState,
}) {
  if (!isLadderBrokerStopEnabledForStrategy(strategy)) {
    return { placed: false, reason: 'disabled' };
  }

  const params = buildBrokerStopOrderParams(position, { initialStopPct, stopPnlFrac });
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

    if (updateBrokerStopState) {
      await updateBrokerStopState(position.id, {
        broker_stop_order_id: result.orderId,
        broker_stop_trigger_price: params.stopTrigger,
        broker_stop_pnl_frac: params.stopPnlFrac,
      });
    }

    console.log(
      `[LadderStop][${strategy}] Placed ${params.orderType} stop #${position.id} qty=${params.quantity} trigger=$${params.stopTrigger} order=${result.orderId}`
    );

    return { placed: true, ...params, ...result };
  } catch (err) {
    console.error(`[LadderStop][${strategy}] Failed to place stop for #${position.id}:`, err.message);
    return { placed: false, reason: err.message, error: err };
  }
}

export async function cancelLadderBrokerStop(position, { strategy, environment, updateBrokerStopState }) {
  const orderId = position.broker_stop_order_id;
  if (!orderId) return { cancelled: false, reason: 'no_stop_order' };

  try {
    await cancelBrokerOrder(orderId, { environment, strategy });
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
  updateBrokerStopState,
}) {
  await cancelLadderBrokerStop(position, { strategy, environment, updateBrokerStopState });
  return placeLadderBrokerStop(position, {
    strategy,
    environment,
    initialStopPct,
    stopPnlFrac,
    updateBrokerStopState,
  });
}

export async function checkLadderBrokerStopFill(position, { strategy, environment }) {
  const orderId = position.broker_stop_order_id;
  if (!orderId) return { filled: false };

  const status = await getBrokerOrderStatus(orderId, { environment, strategy });
  if (!status.isFilled) {
    return { filled: false, status };
  }

  const fillPrice = status.fillPrice;
  const entry = Number(position.entry_premium);
  const pnlFrac =
    fillPrice != null && Number.isFinite(entry) && entry > 0
      ? (fillPrice - entry) / entry
      : Number(position.broker_stop_pnl_frac) || 0;

  const closeReason = inferCloseReasonFromStopPnl(position.broker_stop_pnl_frac ?? pnlFrac);

  return {
    filled: true,
    fillPrice,
    fillQuantity: status.fillQuantity,
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
  updateBrokerStopState,
  fullClosePosition,
  onNotify,
}) {
  const enabled = isLadderBrokerStopEnabledForStrategy(strategy);

  return {
    enabled,
    async placeInitialStop(position) {
      return placeLadderBrokerStop(position, {
        strategy,
        environment,
        initialStopPct,
        updateBrokerStopState,
      });
    },
    async checkFill(position) {
      if (!enabled || !position.broker_stop_order_id) return { filled: false };
      return checkLadderBrokerStopFill(position, { strategy, environment });
    },
    async onStopFilled(position, fill) {
      const closeQty = position.contracts_open ?? position.quantity;
      const exitPremium = fill.fillPrice ?? position.broker_stop_trigger_price;
      const pnlPct = fill.pnlPct ?? (Number(position.broker_stop_pnl_frac) || 0) * 100;

      if (updateBrokerStopState) {
        await updateBrokerStopState(position.id, {
          broker_stop_order_id: null,
          broker_stop_trigger_price: null,
          broker_stop_pnl_frac: null,
        });
      }
      await fullClosePosition(position.id, exitPremium, pnlPct, fill.closeReason, closeQty);

      if (onNotify) {
        await onNotify(position, fill.closeReason, fill.pnlFrac ?? pnlPct / 100, exitPremium, closeQty);
      }

      return {
        position,
        reason: fill.closeReason,
        pnlFrac: fill.pnlFrac,
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
