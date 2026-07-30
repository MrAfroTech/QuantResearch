/**
 * Premarket breakout Telegram alerts — independent from ORB/swing helpers.
 */

import { logAlert } from '../db.js';

async function recordAlert(alertType, message, success, error) {
  try {
    await logAlert({ alertType, message, success, error });
  } catch (err) {
    console.error('[alert_log] write failed:', err.message);
  }
}

async function sendTelegram(text, alertType = 'premarket_telegram') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Premarket Telegram SKIPPED - not configured]');
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
      console.error('[Premarket] Telegram send failed:', errText.slice(0, 200));
      await recordAlert(alertType, text, false, errText.slice(0, 500));
      return null;
    }

    await recordAlert(alertType, text, true, null);
    return await res.json();
  } catch (err) {
    console.error('[Premarket] Telegram send failed:', err.message);
    await recordAlert(alertType, text, false, err.message);
    return null;
  }
}

export async function sendPremarketTradeOpenedTelegram({ ticker, direction, premium, paper, strike, strikeBucket }) {
  const paperLabel = paper ? ' [PAPER]' : '';
  await sendTelegram(
    `🟢 PREMARKET BREAKOUT OPENED${paperLabel} ${ticker} ${direction} $${Number(strike).toFixed(0)} @ $${Number(premium).toFixed(2)} (${strikeBucket})`,
    'premarket_trade_opened'
  );
}

export async function sendPremarketTradeClosedTelegram({ ticker, reason, pnlPct }) {
  const pct = (Number(pnlPct) * 100).toFixed(1);
  await sendTelegram(
    `🔴 PREMARKET BREAKOUT CLOSED ${ticker} — ${reason} | P&L: ${pct}%`,
    'premarket_trade_closed'
  );
}

export async function sendPremarketSignalNotExecutedTelegram({ ticker, direction, reason }) {
  await sendTelegram(
    `📡 PREMARKET BREAKOUT ${ticker} ${direction || 'N/A'} — not executed: ${reason}`,
    'premarket_signal_not_executed'
  );
}

export async function sendPremarketBudgetExhaustedTelegram(maxBudget) {
  await sendTelegram(
    `⚠️ Premarket breakout monthly budget exhausted ($${maxBudget})`,
    'premarket_budget_exhausted'
  );
}

export async function sendPremarketInsufficientBudgetTelegram({
  ticker,
  requiredCost,
  budgetRemaining,
  perSlot,
  slots,
}) {
  const needed = Number(requiredCost).toFixed(2);
  const slotBudget = Number(perSlot ?? budgetRemaining).toFixed(2);
  const total = Number(budgetRemaining).toFixed(2);
  const slotCount = Number.isFinite(slots) ? slots : '?';
  await sendTelegram(
    `Premarket breakout ${ticker} skipped: insufficient budget ` +
      `(needed $${needed}, have $${slotBudget} available this slot ` +
      `(of $${total} total remaining across ${slotCount} slots))`,
    'premarket_insufficient_budget'
  );
}
