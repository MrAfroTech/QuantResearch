import {
  PYRAMID_EXIT_PHASE,
  PYRAMID_CLOSE_REASON,
  PYRAMID_TIER,
} from './pyramidConfig.js';

function usesPyramidExit(position) {
  if (position.pyramid_tier === PYRAMID_TIER.LEGACY || position.exit_phase === 'LEGACY') {
    return false;
  }
  if (position.pyramid_tier === PYRAMID_TIER.FULL || position.pyramid_tier === PYRAMID_TIER.PARTIAL) {
    return true;
  }
  // Pre-tier rows: trailing phase or multi-contract entries use pyramid logic.
  if (position.exit_phase === PYRAMID_EXIT_PHASE.TRAILING) return true;
  if (Number(position.entry_contracts) > 1) return true;
  if (Number(position.contracts_open) > 1) return true;
  return true;
}

/** Pre-pyramid single-contract exit: fixed profit-target and stop-loss (0DTE: time-stop). */
export function evaluateLegacyExit({
  pnlFrac,
  profitPct,
  stopLossPct,
  isTimeStop = false,
  contractsOpen,
}) {
  const open = Number(contractsOpen) || 0;
  if (open <= 0) return { action: 'hold' };

  if (isTimeStop) {
    return { action: 'close_all', reason: 'time_stop', contracts: open };
  }
  if (pnlFrac >= profitPct) {
    return { action: 'close_all', reason: 'profit_target', contracts: open };
  }
  if (pnlFrac <= -stopLossPct) {
    return { action: 'close_all', reason: 'stop_loss', contracts: open };
  }
  return { action: 'hold' };
}

/**
 * Pure decision engine for pyramid scale-out + trailing runners.
 * Swing: no time-stop branch. 0DTE: time-stop force-flattens all remaining contracts.
 */
export function evaluatePyramidExit({
  pnlFrac,
  exitPhase,
  contractsOpen,
  trailPeakPnlFrac,
  profitPct,
  stopLossPct,
  trailPullbackPct,
  isTimeStop = false,
}) {
  const phase = exitPhase || PYRAMID_EXIT_PHASE.INITIAL;
  const open = Number(contractsOpen) || 0;
  const peak = Number(trailPeakPnlFrac) || 0;

  if (open <= 0) {
    return { action: 'hold' };
  }

  if (isTimeStop) {
    return {
      action: 'close_all',
      reason: 'time_stop',
      contracts: open,
    };
  }

  if (phase === PYRAMID_EXIT_PHASE.INITIAL) {
    if (pnlFrac <= -stopLossPct) {
      return { action: 'close_all', reason: 'stop_loss', contracts: open };
    }
    if (pnlFrac >= profitPct && open > 1) {
      return {
        action: 'scale_out',
        reason: PYRAMID_CLOSE_REASON.SCALE_OUT,
        contracts: 1,
        nextPhase: PYRAMID_EXIT_PHASE.TRAILING,
        trailPeakPnlFrac: pnlFrac,
      };
    }
    if (pnlFrac >= profitPct && open === 1) {
      return { action: 'close_all', reason: 'profit_target', contracts: open };
    }
    return { action: 'hold' };
  }

  // TRAILING: fixed profit-target no longer caps runners; trailing stop governs exit.
  if (trailPullbackPct == null || !Number.isFinite(trailPullbackPct)) {
    return {
      action: 'hold',
      configError: 'TRAILING_PULLBACK_PCT not configured',
    };
  }

  const newPeak = Math.max(peak, pnlFrac);
  const trailStop = newPeak - trailPullbackPct;

  if (pnlFrac <= trailStop) {
    return {
      action: 'close_all',
      reason: PYRAMID_CLOSE_REASON.TRAILING_STOP,
      contracts: open,
    };
  }

  return {
    action: 'hold',
    trailPeakPnlFrac: newPeak,
  };
}

/**
 * Shared monitor handler — telemetry (MFE/MAE) stays separate from trail_peak_pnl_frac.
 */
export async function handlePyramidPositionMonitor(position, {
  currentPremium,
  profitPct,
  stopLossPct,
  trailPullbackPct,
  isTimeStop,
  updateExcursion,
  updatePyramidState,
  partialCloseLeg,
  fullClosePosition,
  closeBrokerOrder,
  onNotify,
}) {
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
  const decision = evaluatePyramidExit({
    pnlFrac,
    exitPhase: position.exit_phase,
    contractsOpen,
    trailPeakPnlFrac: position.trail_peak_pnl_frac,
    profitPct,
    stopLossPct,
    trailPullbackPct,
    isTimeStop,
  });

  if (decision.configError) {
    console.warn(`[Pyramid] ${position.ticker}: ${decision.configError} — holding position`);
    return { position, pnlFrac, currentPremium, closeReason: null, configError: decision.configError };
  }

  if (decision.action === 'hold') {
    if (decision.trailPeakPnlFrac != null && decision.trailPeakPnlFrac !== position.trail_peak_pnl_frac) {
      await updatePyramidState(position.id, {
        trail_peak_pnl_frac: decision.trailPeakPnlFrac,
      });
      position.trail_peak_pnl_frac = decision.trailPeakPnlFrac;
    }
    return { position, pnlFrac, currentPremium, closeReason: null };
  }

  if (decision.action === 'scale_out') {
    const closeQty = decision.contracts;
    await closeBrokerOrder(position, currentPremium, closeQty);
    await partialCloseLeg(position.id, currentPremium, pnlFrac * 100, decision.reason, closeQty, {
      exit_phase: decision.nextPhase,
      trail_peak_pnl_frac: decision.trailPeakPnlFrac,
      contracts_open: contractsOpen - closeQty,
      quantity: (Number(position.quantity) || contractsOpen) - closeQty,
    });
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
    await closeBrokerOrder(position, currentPremium, closeQty);
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

export async function handleLegacyPositionMonitor(position, {
  currentPremium,
  profitPct,
  stopLossPct,
  isTimeStop = false,
  updateExcursion,
  fullClosePosition,
  closeBrokerOrder,
  onNotify,
}) {
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
  const decision = evaluateLegacyExit({
    pnlFrac,
    profitPct,
    stopLossPct,
    isTimeStop,
    contractsOpen,
  });

  if (decision.action === 'hold') {
    return { position, pnlFrac, currentPremium, closeReason: null };
  }

  if (decision.action === 'close_all') {
    const closeQty = decision.contracts;
    await closeBrokerOrder(position, currentPremium, closeQty);
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

/** Routes to pyramid or legacy monitor based on entry tier. */
export async function handleTieredPositionMonitor(position, opts) {
  if (usesPyramidExit(position)) {
    return handlePyramidPositionMonitor(position, opts);
  }
  return handleLegacyPositionMonitor(position, opts);
}
