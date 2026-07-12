import { runScan } from './cloudScanner.js';
import { getMarketStatus } from './tradierClient.js';
import { processSignals, MAX_MONTHLY_BUDGET } from './tradeExecutor.js';
import { monitorOpenPositions } from './positionManager.js';
import { sendTradeClosed } from './smsHandler.js';
import {
  sendTradeOpenedTelegram,
  sendTradeClosedTelegram,
  sendSignalNotExecutedTelegram,
  sendBudgetExhaustedTelegram,
} from './telegramHandler.js';

export async function isMarketOpen() {
  try {
    const status = await getMarketStatus();
    return status.state === 'open';
  } catch {
    return false;
  }
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

    if (
      !budgetNotified &&
      (result.reason === 'budget_exhausted' || result.reason === 'insufficient_budget')
    ) {
      await sendBudgetExhaustedTelegram(MAX_MONTHLY_BUDGET);
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

  console.log('[Scheduler] Running market-hours poll...');

  try {
    await monitorOpenPositions(notifyClose);
  } catch (err) {
    console.error('[Scheduler] Position monitor error:', err.message);
  }

  try {
    const scanResult = await runScan();
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
