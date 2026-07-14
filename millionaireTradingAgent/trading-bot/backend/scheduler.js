import { runScan } from './tvScanner.js';
import { processSignals, MAX_MONTHLY_BUDGET } from './tradeExecutor.js';
import { monitorOpenPositions } from './positionManager.js';
import { sendTradeClosed } from './smsHandler.js';
import {
  sendTradeOpenedTelegram,
  sendTradeClosedTelegram,
  sendSignalNotExecutedTelegram,
  sendBudgetExhaustedTelegram,
  sendInsufficientBudgetTelegram,
  sendTradingViewOfflineTelegram,
} from './telegramHandler.js';

export function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const timeDecimal = hours + minutes / 60;

  if (day === 0 || day === 6) return false;
  return timeDecimal >= 9.5 && timeDecimal < 16;
}

async function notifyClose(position, reason, pnlPct, exitPremium) {
  await sendTradeClosed(position, reason, pnlPct, exitPremium);
  await sendTradeClosedTelegram(position, reason, pnlPct, exitPremium);
}

const NOT_EXECUTED_REASONS = {
  low_confidence: (signal) => `Confidence is ${signal.confidence}, not HIGH`,
  max_positions: () => 'Max open positions (3) reached',
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
      await sendBudgetExhaustedTelegram(MAX_MONTHLY_BUDGET);
      budgetNotified = true;
      continue;
    }

    if (!budgetNotified && result.reason === 'insufficient_budget') {
      const ticker = result.signal?.ticker || 'unknown';
      await sendInsufficientBudgetTelegram(
        ticker,
        result.budgetRemaining ?? 0,
        result.requiredCost ?? 0
      );
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

export async function runPollCycle() {
  if (!isMarketOpen()) {
    console.log('[Scheduler] Outside market hours — skipping');
    return { skipped: true, reason: 'outside_market_hours' };
  }

  console.log('[Scheduler] Running market-hours poll...');

  try {
    await monitorOpenPositions(notifyClose);
  } catch (err) {
    console.error('[Scheduler] Position monitor error:', err.message);
  }

  try {
    const scanResult = await runScan();

    if (scanResult.offline) {
      await sendTradingViewOfflineTelegram();
      return { skipped: true, reason: 'tradingview_offline' };
    }

    const signals = scanResult.signals ?? [];
    if (signals.length > 0) {
      console.log(`[Scheduler] ${signals.length} signal(s) triggered`);
      const results = await processSignals(signals);
      await notifyExecutionResults(results);
      return { skipped: false, signalsTriggered: signals.length };
    }

    console.log('[Scheduler] No signals triggered');
    return { skipped: false, signalsTriggered: 0 };
  } catch (err) {
    console.error('[Scheduler] Signal scan error:', err.message);
    throw err;
  }
}

export async function startScheduler() {
  const { default: cron } = await import('node-cron');
  cron.schedule('*/5 * * * 1-5', () => runPollCycle(), { timezone: 'America/New_York' });
  console.log('[Scheduler] Started — polling every 5 min during market hours (Mon-Fri 9:30am-4pm ET)');
}
