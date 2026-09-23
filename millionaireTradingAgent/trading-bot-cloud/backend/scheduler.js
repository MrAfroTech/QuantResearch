import { runScan } from './cloudScanner.js';
import { getMarketStatus } from './tradierClient.js';
import { processSignals } from './tradeExecutor.js';
import { getSwingTotalAllocated } from './budget/budgetAllocations.js';
import { monitorOpenPositions } from './positionManager.js';
import { monitorOrbPositions } from './orb/orbPositionManager.js';
import { runOrbScanAndExecute } from './orb/orbExecutor.js';
import { monitorPremarketPositions } from './premarketBreakout/premarketPositionManager.js';
import { runPremarketScanAndExecute } from './premarketBreakout/premarketExecutor.js';
import { monitorEmaVwapPositions } from './emaVwapCross/emaVwapPositionManager.js';
import { runEmaVwapScanAndExecute } from './emaVwapCross/emaVwapExecutor.js';
import {
  sendTradeOpenedTelegram,
  sendTradeClosedTelegram,
  sendSignalNotExecutedTelegram,
  sendBudgetExhaustedTelegram,
  sendInsufficientBudgetTelegram,
} from './telegramHandler.js';
import { runDailyDiagnosis } from './analytics/runDiagnosis.js';
import {
  runConfirmBarRecalibration,
  CONFIRM_BAR_RECAL_CRON,
} from './analytics/confirmBarRecalibration.js';
import { runWeeklyBudgetTopOff } from './budget/budgetAllocations.js';
import { refreshLiveRiskState } from './budget/liveRiskSync.js';
import { runPositionReconciliation } from './recon/positionReconciliation.js';
import { logAlert } from './db.js';
import { runIsolationCanaryCycle } from './isolation/isolationCanary.js';
import { ISOLATION_CANARY_CRON } from './isolation/isolationConfig.js';
import {
  getScheduledTradingHalt,
  maybeResumeScheduledHalt,
} from './budget/tradingHalt.js';

/** THE3-2 recon cadence during RTH (Mon–Fri ET). */
export const POSITION_RECON_CRON = process.env.POSITION_RECON_CRON || '*/10 * * * 1-5';

/**
 * 0DTE position-monitor cadence (Mon–Fri ET, 6-field cron with seconds).
 * Partial-lock trails ratchet on each new MFE high, but MFE is a poll snapshot.
 * A 1-min tick cannot re-tighten an intra-minute run (Premarket IWM #82:
 * lock at 11:08:03 on 6.06% MFE, broker-flat 58s later; 9.39% never sampled
 * while still long). 10s is enough to re-arm the next 5%/10% rung on a new high.
 */
export const ZERO_DTE_POSITION_MONITOR_CRON =
  process.env.ZERO_DTE_POSITION_MONITOR_CRON || '*/10 * * * * 1-5';

const MARKET_STATUS_CACHE_MS = 15_000;
let cachedMarketStatus = null;
let cachedMarketStatusAt = 0;
let zeroDteMonitorInFlight = false;

export function isZeroDteMonitorInFlight() {
  return zeroDteMonitorInFlight;
}

export function resetZeroDteMonitorLockForTests() {
  zeroDteMonitorInFlight = false;
  cachedMarketStatus = null;
  cachedMarketStatusAt = 0;
}

export function markZeroDteMonitorInFlightForTests() {
  zeroDteMonitorInFlight = true;
}

async function getCachedMarketStatus() {
  const now = Date.now();
  if (cachedMarketStatus && now - cachedMarketStatusAt < MARKET_STATUS_CACHE_MS) {
    return cachedMarketStatus;
  }
  const status = await getMarketStatus();
  cachedMarketStatus = status;
  cachedMarketStatusAt = now;
  return status;
}

export async function isMarketOpen() {
  try {
    const status = await getMarketStatus();
    return status.state === 'open';
  } catch {
    return false;
  }
}

async function notifyClose(position, reason, pnlPct, exitPremium) {
  await sendTradeClosedTelegram(position, reason, pnlPct, exitPremium);
}

const NOT_EXECUTED_REASONS = {
  low_confidence: (signal) => `Confidence is ${signal.confidence}, not HIGH`,
  max_positions: () => 'Max open positions (3) reached',
  already_executed_today: (signal) =>
    `Already executed today for ${signal.ticker} ${signal.direction} (${signal.signalType})`,
  same_day_loss_block: (signal) =>
    `Same-day loss block — no re-entry for ${signal.ticker} ${signal.direction} after a losing close today`,
  stop_loss_cooldown: (signal) =>
    `Same-day loss block — no re-entry for ${signal.ticker} ${signal.direction} after a losing close today`,
  ticker_paused_sofi_put: () =>
    'SOFI PUT paused — awaiting clean post-reentry-gate sample',
  daily_loss_limit_reached: () =>
    'Live daily loss limit reached (30%) — new entries blocked for today',
  manual_mode: () => 'Bot is in MANUAL mode — awaiting approval',
  execution_error: (_signal, result) => result.error || 'Execution error',
};

async function notifyExecutionResults(results) {
  let budgetNotified = false;

  for (const result of results) {
    if (result.executed) {
      await sendTradeOpenedTelegram(
        result.signal,
        result.tradeParams,
        result.order?.paper
      );
      continue;
    }

    if (result.reason === 'paper_entry_blocked') {
      console.log(
        `[Scheduler] paper_entry_blocked — skip entry Telegram for ${result.signal?.ticker || '?'}`
      );
      continue;
    }

    if (result.reason === 'budget_exhausted') {
      console.log(
        `[Scheduler] budget_exhausted — needed=$${result.requiredCost ?? 0}, ` +
          `perSlot=$${result.perSlot ?? '?'}, remaining=$${result.budgetRemaining ?? 0}, ` +
          `slots=${result.slots ?? '?'}`
      );
      if (result.requiredCost != null && result.signal) {
        // Per-signal detail (same pattern as ORB/Premarket/EMA) — do not collapse
        // later same-cycle skips into a bare "budget_exhausted" string.
        await sendInsufficientBudgetTelegram(
          result.signal,
          result.requiredCost ?? 0,
          result.budgetRemaining ?? 0,
          { perSlot: result.perSlot, slots: result.slots }
        );
      } else if (!budgetNotified) {
        await sendBudgetExhaustedTelegram(await getSwingTotalAllocated());
        budgetNotified = true;
      }
      continue;
    }

    if (result.signal) {
      const reasonFn = NOT_EXECUTED_REASONS[result.reason];
      const reason = reasonFn
        ? reasonFn(result.signal, result)
        : result.reason || 'Not executed';
      await sendSignalNotExecutedTelegram(result.signal, reason);
    }
  }
}

export async function runZeroDtePositionMonitorCycle() {
  if (zeroDteMonitorInFlight) {
    return { skipped: true, reason: 'in_flight' };
  }
  zeroDteMonitorInFlight = true;
  try {
    return await runZeroDtePositionMonitorCycleBody();
  } finally {
    zeroDteMonitorInFlight = false;
  }
}

async function runZeroDtePositionMonitorCycleBody() {
  try {
    await maybeResumeScheduledHalt();
  } catch (err) {
    console.error('[Scheduler] scheduled halt resume error (0DTE monitor):', err.message);
  }

  await refreshLiveRiskState();

  let marketStatus;
  try {
    marketStatus = await getCachedMarketStatus();
  } catch (err) {
    console.error('[Scheduler] Tradier market status error (0DTE monitor):', err.message);
    return { skipped: true, reason: 'market_status_error' };
  }

  if (marketStatus.state !== 'open') {
    return { skipped: true, reason: 'outside_market_hours' };
  }

  const results = { orb: [], premarket: [], emavwap: [] };

  try {
    results.orb = await monitorOrbPositions();
  } catch (err) {
    console.error('[Scheduler] ORB position monitor error:', err.message);
  }

  try {
    results.premarket = await monitorPremarketPositions();
  } catch (err) {
    console.error('[Scheduler] Premarket position monitor error:', err.message);
  }

  try {
    results.emavwap = await monitorEmaVwapPositions();
  } catch (err) {
    console.error('[Scheduler] EMA/VWAP position monitor error:', err.message);
  }

  return { skipped: false, results };
}

/**
 * THE3-2 — Tastytrade ↔ Supabase open-book / fill reconciliation.
 * Market-hours only; production alerts Telegram; preprod logs to event log.
 */
export async function runPositionReconCycle() {
  let marketStatus;
  try {
    marketStatus = await getMarketStatus();
  } catch (err) {
    console.error('[Scheduler] Tradier market status error (THE3-2 recon):', err.message);
    return { skipped: true, reason: 'market_status_error' };
  }

  if (marketStatus.state !== 'open') {
    return { skipped: true, reason: 'outside_market_hours' };
  }

  try {
    return await runPositionReconciliation();
  } catch (err) {
    console.error('[Scheduler] THE3-2 recon error:', err.message);
    try {
      await logAlert({
        alertType: 'recon_error',
        message: `🚨 RECON ERROR (THE3-2) — cycle threw\n${err.message}`,
        success: false,
        error: err.message,
      });
    } catch (logErr) {
      console.error('[Scheduler] recon_error alert_log write failed:', logErr.message);
    }
    return { skipped: false, ok: false, error: err.message };
  }
}

export async function runPollCycle() {
  try {
    await maybeResumeScheduledHalt();
  } catch (err) {
    console.error('[Scheduler] scheduled halt resume error:', err.message);
  }

  await refreshLiveRiskState();

  let marketStatus;
  try {
    marketStatus = await getMarketStatus();
  } catch (err) {
    console.error('[Scheduler] Tradier market status error:', err.message);
    return { skipped: true, reason: 'market_status_error' };
  }

  if (marketStatus.state !== 'open') {
    console.log('[Scheduler] Market closed — skipping');
    return { skipped: true, reason: 'outside_market_hours' };
  }

  console.log('[Scheduler] Running market-hours poll (swing monitor + signal scans)...');

  try {
    await monitorOpenPositions(notifyClose);
  } catch (err) {
    console.error('[Scheduler] Position monitor error:', err.message);
  }

  let signalTickers = [];
  try {
    const scanResult = await runScan();
    const signals = scanResult.signals ?? [];
    signalTickers = signals.map((s) => s.ticker).filter(Boolean);

    if (signals.length > 0) {
      console.log(`[Scheduler] ${signals.length} signal(s) triggered`);
      const results = await processSignals(signals);
      await notifyExecutionResults(results);
      return { skipped: false, signalsTriggered: signals.length };
    }

    console.log('[Scheduler] No signals triggered');
    return { skipped: false, signalsTriggered: 0 };
  } catch (err) {
    const tickerInfo = signalTickers.length ? ` tickers=${signalTickers.join(',')}` : '';
    console.error(`[Scheduler] Signal scan error:${tickerInfo}`, err.message);
    throw err;
  } finally {
    try {
      const halt = await getScheduledTradingHalt();
      if (halt.active) {
        console.log(
          `[Scheduler] scheduled trading halt until ${halt.resumeAtEt} — skipping 0DTE scans (position monitors still run)`
        );
        return { skipped: false, signalsTriggered: 0, entriesHalted: true };
      }
    } catch (err) {
      console.error('[Scheduler] scheduled halt check error:', err.message);
    }
    try {
      await runOrbScanAndExecute();
    } catch (err) {
      console.error('[Scheduler] ORB scan error:', err.message);
    }
    try {
      await runPremarketScanAndExecute();
    } catch (err) {
      console.error('[Scheduler] Premarket scan error:', err.message);
    }
    try {
      await runEmaVwapScanAndExecute();
    } catch (err) {
      console.error('[Scheduler] EMA/VWAP scan error:', err.message);
    }
  }
}

export async function startScheduler() {
  const { default: cron } = await import('node-cron');
  cron.schedule('*/5 * * * 1-5', () => runPollCycle(), { timezone: 'America/New_York' });
  cron.schedule(ZERO_DTE_POSITION_MONITOR_CRON, () => {
    runZeroDtePositionMonitorCycle().catch((err) => {
      console.error('[Scheduler] 0DTE position monitor error:', err.message);
    });
  }, { timezone: 'America/New_York' });
  cron.schedule('15 16 * * 1-5', () => {
    runDailyDiagnosis().catch((err) => {
      console.error('[Scheduler] Daily diagnosis error:', err.message);
    });
  }, { timezone: 'America/New_York' });
  cron.schedule('1 0 * * 1', () => {
    runWeeklyBudgetTopOff().catch((err) => {
      console.error('[Scheduler] Weekly budget top-off error:', err.message);
    });
  }, { timezone: 'America/New_York' });
  cron.schedule(CONFIRM_BAR_RECAL_CRON, () => {
    runConfirmBarRecalibration().catch((err) => {
      console.error('[Scheduler] Confirm-bar recalibration error:', err.message);
    });
  }, { timezone: 'America/New_York' });
  cron.schedule(POSITION_RECON_CRON, () => {
    runPositionReconCycle().catch((err) => {
      console.error('[Scheduler] THE3-2 recon error:', err.message);
    });
  }, { timezone: 'America/New_York' });
  cron.schedule(ISOLATION_CANARY_CRON, () => {
    runIsolationCanaryCycle().catch((err) => {
      console.error('[Scheduler] isolation canary error:', err.message);
    });
  }, { timezone: 'America/New_York' });
  runIsolationCanaryCycle().catch((err) => {
    console.error('[Scheduler] isolation canary startup error:', err.message);
  });
  console.log(
    `[Scheduler] Started — signal scans every 5 min; 0DTE position monitors ${ZERO_DTE_POSITION_MONITOR_CRON} (Mon-Fri, market open)`
  );
  console.log('[Scheduler] Swing position monitor on 5-min poll cycle');
  console.log('[Scheduler] Daily trade diagnosis scheduled Mon-Fri 4:15pm ET');
  console.log('[Scheduler] Weekly budget top-off scheduled Monday 12:01am ET');
  console.log(
    `[Scheduler] Confirm-bar recalibration scheduled cron="${CONFIRM_BAR_RECAL_CRON}" ET (suggestions only)`
  );
  console.log(
    `[Scheduler] THE3-2 position recon scheduled cron="${POSITION_RECON_CRON}" ET (market open)`
  );
  console.log(
    `[Scheduler] Isolation canary scheduled cron="${ISOLATION_CANARY_CRON}" ET (every environment, not market-hours-only)`
  );
}
