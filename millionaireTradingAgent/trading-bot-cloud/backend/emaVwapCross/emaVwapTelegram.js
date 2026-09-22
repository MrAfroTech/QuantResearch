/**
 * EMA/VWAP cross Telegram alerts — independent transport (sendTelegram not exported).
 */

import { logAlert } from '../db.js';
import { shouldSuppressNonExitTelegram, isCloseOrExitAlertType } from '../strategyEnvironment.js';
import { formatClosedTradeTelegramText } from '../telegramCloseOutcome.js';

async function recordAlert(alertType, message, success, error) {
  try {
    await logAlert({ alertType, message, success, error });
  } catch (err) {
    console.error('[alert_log] write failed:', err.message);
  }
}

async function sendTelegram(text, alertType = 'emavwap_telegram') {
  if (
    !isCloseOrExitAlertType(alertType) &&
    (await shouldSuppressNonExitTelegram('emavwap'))
  ) {
    console.log(`[EMA/VWAP Telegram] skip ${alertType} — emavwap is paper on production`);
    return null;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[EMA/VWAP Telegram SKIPPED - not configured]');
    await recordAlert(alertType, text, false, 'not_configured');
    return null;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[EMA/VWAP] Telegram send failed:', errText.slice(0, 200));
      await recordAlert(alertType, text, false, errText.slice(0, 500));
      return null;
    }

    await recordAlert(alertType, text, true, null);
    return await res.json();
  } catch (err) {
    console.error('[EMA/VWAP] Telegram send failed:', err.message);
    await recordAlert(alertType, text, false, err.message);
    return null;
  }
}

export async function sendEmaVwapTradeOpenedTelegram({ ticker, direction, premium, paper, strike, strikeBucket }) {
  const paperLabel = paper ? ' [PAPER]' : '';
  await sendTelegram(
    `🟢 EMA/VWAP CROSS OPENED${paperLabel} ${ticker} ${direction} $${Number(strike).toFixed(0)} @ $${Number(premium).toFixed(2)} (${strikeBucket})`,
    'emavwap_trade_opened'
  );
}

export async function sendEmaVwapTradeClosedTelegram({ ticker, reason, pnlPct, realizedPnl }) {
  await sendTelegram(
    formatClosedTradeTelegramText({
      label: 'EMA/VWAP CROSS',
      ticker,
      reason,
      pnlPct,
      realizedPnl,
    }),
    'emavwap_trade_closed'
  );
}

export async function sendEmaVwapSignalNotExecutedTelegram({ ticker, direction, reason }) {
  await sendTelegram(
    `📡 EMA/VWAP CROSS ${ticker} ${direction || 'N/A'} — not executed: ${reason}`,
    'emavwap_signal_not_executed'
  );
}

export async function sendEmaVwapBudgetExhaustedTelegram(maxBudget) {
  await sendTelegram(
    `⚠️ EMA/VWAP cross monthly budget exhausted ($${maxBudget})`,
    'emavwap_budget_exhausted'
  );
}

export async function sendEmaVwapInsufficientBudgetTelegram({
  ticker,
  requiredCost,
  budgetRemaining,
}) {
  const needed = Number(requiredCost).toFixed(2);
  const left = Number(budgetRemaining).toFixed(2);
  await sendTelegram(
    `EMA/VWAP cross ${ticker} skipped: insufficient budget ` +
      `(needed $${needed}, have $${left} remaining — FCFS, no per-slot reserve)`,
    'emavwap_insufficient_budget'
  );
}
