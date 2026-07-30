import { getBotState, setExecutionMode, getOpenPositionCount, logAlert } from './db.js';
import { getBudgetRemaining, MAX_MONTHLY_BUDGET } from './positionManager.js';

async function recordAlert(alertType, message, success, error) {
  try {
    await logAlert({ alertType, message, success, error });
  } catch (err) {
    console.error('[alert_log] write failed:', err.message);
  }
}

async function sendTelegram(text, alertType = 'telegram') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Telegram SKIPPED - not configured]');
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
      console.error('Telegram send failed:', errText.slice(0, 200));
      await recordAlert(alertType, text, false, errText.slice(0, 500));
      return null;
    }

    await recordAlert(alertType, text, true, null);
    return await res.json();
  } catch (err) {
    console.error('Telegram send failed:', err.message);
    await recordAlert(alertType, text, false, err.message);
    return null;
  }
}

export async function sendTradeOpenedTelegram(signal, tradeParams, paper) {
  const paperLabel = paper ? ' [PAPER]' : '';
  const price = tradeParams?.premium ?? signal?.curr_px ?? 0;
  await sendTelegram(
    `🟢 TRADE OPENED${paperLabel} ${signal.ticker} ${signal.direction} @ $${Number(price).toFixed(2)}`,
    'trade_opened'
  );
}

export async function sendTradeClosedTelegram(position, reason, pnlPct, exitPremium) {
  const pct = (pnlPct * 100).toFixed(1);
  await sendTelegram(
    `🔴 TRADE CLOSED ${position.ticker} — ${reason} | P&L: ${pct}%`,
    'trade_closed'
  );
}

export async function sendSignalNotExecutedTelegram(signal, reason) {
  await sendTelegram(
    `📡 SIGNAL ${signal.ticker} ${signal.direction || 'N/A'} — not executed: ${reason}`,
    'signal_not_executed'
  );
}

export async function sendModeSwitchTelegram(mode) {
  await sendTelegram(`🔄 Mode changed to ${mode}`, 'mode_switch');
}

export async function sendBudgetExhaustedTelegram(maxBudget = 1797) {
  await sendTelegram(`⚠️ Monthly budget exhausted ($${maxBudget})`, 'budget_exhausted');
}

export async function sendDailyLossLimitTelegram({
  baseline,
  dailyPnl,
  lossAmount,
  lossPct,
  realizedToday,
  unrealizedOpen,
}) {
  await sendTelegram(
    `🛑 LIVE DAILY LOSS LIMIT REACHED\n` +
      `Baseline: $${Number(baseline).toFixed(2)}\n` +
      `Daily P&L: $${Number(dailyPnl).toFixed(2)} ` +
      `(realized today: $${Number(realizedToday).toFixed(2)}, ` +
      `open MTM: $${Number(unrealizedOpen).toFixed(2)})\n` +
      `Loss: $${Number(lossAmount).toFixed(2)} (${Number(lossPct).toFixed(1)}% of baseline)\n` +
      `New live entries blocked for the rest of today. Open positions continue normal exit logic.`,
    'daily_loss_limit_reached'
  );
}

export async function sendLiveRiskUnknownTelegram({ strategy, reason, detail }) {
  const strat = strategy || 'unknown';
  const why = reason || 'unknown';
  const extra = detail ? `\nDetail: ${detail}` : '';
  await sendTelegram(
    `⚠️ LIVE RISK STATE UNKNOWN — entries blocked\n` +
      `Strategy: ${strat}\n` +
      `Reason: ${why}${extra}\n` +
      `New live entries are blocked until live balance/risk sync succeeds. ` +
      `This is NOT the 30% daily loss trip — risk status could not be determined.`,
    'live_risk_state_unknown'
  );
}

const closeFailureAlertAt = new Map();
const CLOSE_FAILURE_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Loud alert when broker close fails repeatedly (e.g. illegal_buy_and_sell_on_same_symbol).
 * Cooldown per strategy+position so monitor loops do not spam.
 */
export async function sendCloseFailedTelegram({
  strategy,
  positionId,
  ticker,
  direction,
  strike,
  error,
  attempt = 1,
}) {
  const key = `${strategy || 'unknown'}:${positionId ?? ticker}`;
  const now = Date.now();
  const last = closeFailureAlertAt.get(key) || 0;
  if (now - last < CLOSE_FAILURE_ALERT_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }
  closeFailureAlertAt.set(key, now);

  const strat = strategy || 'unknown';
  const sym = `${ticker || '?'} ${direction || ''} $${strike ?? ''}`.trim();
  await sendTelegram(
    `🚨 CLOSE FAILED — position may be stuck past stop\n` +
      `Strategy: ${strat}\n` +
      `Position: #${positionId ?? '?'} ${sym}\n` +
      `Attempt: ${attempt}\n` +
      `Error: ${String(error || 'unknown').slice(0, 400)}\n` +
      `Monitor will keep retrying; investigate broker working orders if this persists.`,
    'close_order_failed'
  );
  return { sent: true };
}

export async function sendInsufficientBudgetTelegram(signal, requiredCost, budgetRemaining) {
  const ticker = signal?.ticker || 'unknown';
  const needed = Number(requiredCost).toFixed(2);
  const left = Number(budgetRemaining).toFixed(2);
  await sendTelegram(
    `Signal on ${ticker} skipped: insufficient budget (needed $${needed}, have $${left} remaining)`,
    'insufficient_budget'
  );
}

export async function sendTradingViewOfflineTelegram() {
  await sendTelegram('⚠️ TradingView MCP offline — scan skipped', 'tv_offline');
}

async function sendStatusReplyTelegram() {
  const state = await getBotState();
  const openCount = await getOpenPositionCount();
  const budgetRemaining = await getBudgetRemaining();

  await sendTelegram(
    `BOT STATUS\n` +
    `Mode: ${state.execution_mode}\n` +
    `Open positions: ${openCount}/3\n` +
    `Budget remaining: $${budgetRemaining.toFixed(2)} / $${MAX_MONTHLY_BUDGET}\n` +
    `Paper trading: ${process.env.PAPER_TRADING !== 'false' ? 'ON' : 'OFF'}`,
    'status_reply'
  );
}

export async function handleInboundTelegramCommand(text) {
  const command = text?.trim().toUpperCase();

  if (command === 'STOP') {
    await setExecutionMode('MANUAL');
    await sendModeSwitchTelegram('MANUAL');
    return { action: 'mode_switch', mode: 'MANUAL' };
  }

  if (command === 'GO') {
    await setExecutionMode('AUTO');
    await sendModeSwitchTelegram('AUTO');
    return { action: 'mode_switch', mode: 'AUTO' };
  }

  await sendStatusReplyTelegram();
  return { action: 'status_reply' };
}
