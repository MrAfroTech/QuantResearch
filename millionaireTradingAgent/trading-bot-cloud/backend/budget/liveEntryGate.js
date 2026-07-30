import { getStrategyEnvironment } from '../strategyEnvironment.js';
import { refreshLiveRiskState } from './liveRiskSync.js';
import { sendLiveRiskUnknownTelegram } from '../telegramHandler.js';

const UNKNOWN_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
let lastUnknownAlertAt = 0;
let lastUnknownAlertKey = null;

async function alertRiskUnknownOnce(strategy, reason, detail) {
  const key = `${strategy}:${reason}:${detail || ''}`;
  const now = Date.now();
  if (key === lastUnknownAlertKey && now - lastUnknownAlertAt < UNKNOWN_ALERT_COOLDOWN_MS) {
    return;
  }
  lastUnknownAlertKey = key;
  lastUnknownAlertAt = now;
  try {
    await sendLiveRiskUnknownTelegram({ strategy, reason, detail });
  } catch (err) {
    console.error('[LiveEntryGate] unknown-risk Telegram failed:', err.message);
  }
}

/**
 * Pure decision for live entry after refreshLiveRiskState().
 * Fail-closed: unknown/skipped/invalid → block.
 */
export function evaluateLiveRiskRefreshForEntry(refresh) {
  if (!refresh || refresh.skipped) {
    return {
      allowed: false,
      reason: 'live_risk_state_unknown',
      detail: refresh?.error || refresh?.reason || 'refresh_skipped',
    };
  }

  const dailyLoss = refresh.dailyLoss;
  if (!dailyLoss || dailyLoss.skipped) {
    return {
      allowed: false,
      reason: 'live_risk_state_unknown',
      detail: dailyLoss?.reason || 'daily_loss_status_unavailable',
    };
  }

  if (dailyLoss.active) {
    return { allowed: false, reason: 'daily_loss_limit_reached' };
  }

  const cash = Number(refresh.cashBalance);
  if (!Number.isFinite(cash) || cash <= 0) {
    return {
      allowed: false,
      reason: 'live_risk_state_unknown',
      detail: 'invalid_cash_balance',
    };
  }

  return { allowed: true };
}

/**
 * Live entry gate — fail-closed.
 * Paper strategies always allowed.
 * Live strategies require a successful risk refresh and a known non-tripped breaker.
 */
export async function checkLiveEntryGate(strategy) {
  const environment = await getStrategyEnvironment(strategy);
  if (environment !== 'live') {
    return { allowed: true, environment: 'paper' };
  }

  let refresh;
  try {
    refresh = await refreshLiveRiskState();
  } catch (err) {
    await alertRiskUnknownOnce(strategy, 'refresh_threw', err.message);
    return {
      allowed: false,
      environment: 'live',
      reason: 'live_risk_state_unknown',
      detail: err.message,
    };
  }

  const decision = evaluateLiveRiskRefreshForEntry(refresh);
  if (!decision.allowed) {
    if (decision.reason === 'live_risk_state_unknown') {
      await alertRiskUnknownOnce(strategy, decision.detail || decision.reason, refresh?.error);
    }
    return {
      allowed: false,
      environment: 'live',
      reason: decision.reason,
      detail: decision.detail,
    };
  }

  return { allowed: true, environment: 'live' };
}
