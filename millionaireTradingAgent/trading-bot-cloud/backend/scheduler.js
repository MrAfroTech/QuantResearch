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
import { runWeeklyBudgetTopOff } from './budget/budgetAllocations.js';
import { refreshLiveRiskState } from './budget/liveRiskSync.js';

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
  stop_loss_cooldown: (signal, result) => {
    const mins = Math.ceil((result?.cooldownRemainingMs ?? 0) / 60000) || 20;
    return `Stop-loss cooldown active for ${signal.ticker} ${signal.direction} (~${mins}m)`;
  },
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

    if (!budgetNotified && result.reason === 'budget_exhausted') {
      console.log(
        `[Scheduler] budget_exhausted — needed=$${result.requiredCost ?? 0}, remaining=$${result.budgetRemaining ?? 0}`
      );
      if (result.requiredCost != null && result.signal) {
        await sendInsufficientBudgetTelegram(
          result.signal,
          result.requiredCost ?? 0,
          result.budgetRemaining ?? 0
        );
      } else {
        await sendBudgetExhaustedTelegram(await getSwingTotalAllocated());
      }
      budgetNotified = true;
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
  await refreshLiveRiskState();

  let marketStatus;
  try {
    marketStatus = await getMarketStatus();
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

export async function runPollCycle() {
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
  cron.schedule('* * * * 1-5', () => {
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
  console.log('[Scheduler] Started — signal scans every 5 min; 0DTE position monitors every 1 min (Mon-Fri, market open)');
  console.log('[Scheduler] Swing position monitor on 5-min poll cycle');
  console.log('[Scheduler] Daily trade diagnosis scheduled Mon-Fri 4:15pm ET');
  console.log('[Scheduler] Weekly budget top-off scheduled Monday 12:01am ET');
}
