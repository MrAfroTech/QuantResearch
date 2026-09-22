import { getBotState, setExecutionMode, getOpenPositionCount, logAlert } from './db.js';
import { getBudgetRemaining, MAX_MONTHLY_BUDGET } from './positionManager.js';
import { shouldSuppressNonExitTelegram, isCloseOrExitAlertType } from './strategyEnvironment.js';
import { formatClosedTradeTelegramText } from './telegramCloseOutcome.js';

async function recordAlert(alertType, message, success, error) {
  try {
    await logAlert({ alertType, message, success, error });
  } catch (err) {
    console.error('[alert_log] write failed:', err.message);
  }
}

async function sendTelegram(text, alertType = 'telegram', strategy = null) {
  if (
    strategy &&
    !isCloseOrExitAlertType(alertType) &&
    (await shouldSuppressNonExitTelegram(strategy))
  ) {
    console.log(`[Telegram] skip ${alertType} — ${strategy} is paper on production`);
    return null;
  }

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
    'trade_opened',
    'swing'
  );
}

export async function sendTradeClosedTelegram(position, reason, pnlPct, exitPremium) {
  await sendTelegram(
    formatClosedTradeTelegramText({
      label: 'TRADE',
      ticker: position.ticker,
      reason,
      pnlPct,
    }),
    'trade_closed',
    'swing'
  );
}

export async function sendSignalNotExecutedTelegram(signal, reason) {
  await sendTelegram(
    `📡 SIGNAL ${signal.ticker} ${signal.direction || 'N/A'} — not executed: ${reason}`,
    'signal_not_executed',
    'swing'
  );
}

export async function sendModeSwitchTelegram(mode) {
  await sendTelegram(`🔄 Mode changed to ${mode}`, 'mode_switch');
}

export async function sendScheduledHaltTelegram(halt = {}) {
  const when = halt.resumeAtEt || 'the scheduled resume time';
  await sendTelegram(
    `🛑 TRADING HALTED\n` +
      `New entries blocked until ${when}.\n` +
      `ORB / Premarket / EMA-VWAP / Swing will not open new positions.\n` +
      `Open positions (if any) still follow normal exits.`,
    'scheduled_trading_halt'
  );
}

export async function sendScheduledHaltResumeTelegram(halt = {}) {
  const when = halt.resumeAtEt || 'the scheduled resume time';
  await sendTelegram(
    `✅ TRADING RESUMED\n` +
      `Scheduled halt expired (${when}).\n` +
      `All strategies set back to AUTO. New entries allowed subject to live risk gates.`,
    'scheduled_trading_halt_resume'
  );
}

export async function sendBudgetExhaustedTelegram(maxBudget = 1797) {
  await sendTelegram(`⚠️ Monthly budget exhausted ($${maxBudget})`, 'budget_exhausted', 'swing');
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
    'close_order_failed',
    strategy
  );
  return { sent: true };
}

const unprotectedStopAlertAt = new Map();
const UNPROTECTED_STOP_ALERT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * THE3-2 candidate: open live position with no resting broker stop past grace.
 * Cooldown per strategy+position so retry loops do not spam.
 */
export async function sendUnprotectedBrokerStopTelegram({
  strategy,
  positionId,
  ticker,
  direction,
  strike,
  attempt = 1,
  elapsedMs = 0,
  reason,
}) {
  const key = `${strategy || 'unknown'}:${positionId ?? ticker}`;
  const now = Date.now();
  const last = unprotectedStopAlertAt.get(key) || 0;
  if (now - last < UNPROTECTED_STOP_ALERT_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }
  unprotectedStopAlertAt.set(key, now);

  const strat = strategy || 'unknown';
  const elapsedSec = Math.round(Number(elapsedMs) / 1000);
  const sym = `${ticker || '?'} ${direction || ''} $${strike ?? ''}`.trim();
  await sendTelegram(
    `🚨 UNPROTECTED POSITION — no resting broker stop (THE3-2)\n` +
      `Strategy: ${strat}\n` +
      `Position: #${positionId ?? '?'} ${sym}\n` +
      `Elapsed: ${elapsedSec}s unprotected\n` +
      `Attempt: ${attempt}\n` +
      `Last error: ${String(reason || 'unknown').slice(0, 400)}\n` +
      `Retrying stop placement until it rests or the position closes.`,
    'unprotected_broker_stop',
    strategy
  );
  return { sent: true };
}

const reconAlertAt = new Map();
const RECON_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Visually distinct THE3-2 recon alert — not a normal trade open/close message.
 * Cooldown on identical message fingerprints so a stuck mismatch does not spam.
 */
const isolationAlertAt = new Map();
const ISOLATION_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Same 🚨 class as unprotected-position / THE3-2 recon.
 * Never pass a strategy — paper suppression must not mute isolation failures.
 */
export async function sendIsolationBreachTelegram({ mode, schema, detail }) {
  const text =
    `🚨 ISOLATION BREACH — schema/credential drift (do not ignore)\n` +
    `Environment: ${mode || '?'}\n` +
    `Schema: ${schema || '?'}\n` +
    `${String(detail || 'unknown').slice(0, 800)}\n` +
    `This process is scoped to its own DB role/schema only. Investigate immediately.`;
  const key = text.slice(0, 240).replace(/\s+/g, ' ');
  const now = Date.now();
  const last = isolationAlertAt.get(key) || 0;
  if (now - last < ISOLATION_ALERT_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }
  isolationAlertAt.set(key, now);
  await sendTelegram(text, 'isolation_breach');
  return { sent: true };
}

export async function sendReconMismatchTelegram(message) {
  const key = String(message || '')
    .slice(0, 240)
    .replace(/\s+/g, ' ');
  const now = Date.now();
  const last = reconAlertAt.get(key) || 0;
  if (now - last < RECON_ALERT_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown' };
  }
  reconAlertAt.set(key, now);

  await sendTelegram(message, 'recon_mismatch');
  return { sent: true };
}

/**
 * First real partial fill (and any OTO stop-align failure) must page, not sit in logs.
 * Align-failure uses the same 🚨 class as unprotected_broker_stop.
 */
export async function sendEntryFillQtyTelegram({
  strategy,
  ticker,
  direction,
  strike,
  positionId,
  requestedQty,
  bookedQty,
  fillQuantity,
  observedStopQty,
  stopReplaced,
  brokerStopMatchedFill,
  stopAlignFailed,
  stopOrderId,
  reason,
}) {
  const strat = strategy || 'unknown';
  const sym = `${ticker || '?'} ${direction || ''} $${strike ?? ''}`.trim();
  const stopLine = stopAlignFailed
    ? `Stop: ALIGN FAILED — ${String(reason || 'unknown').slice(0, 300)}\nRetrying until a stop rests or the position closes.`
    : `Stop: ${brokerStopMatchedFill ? 'child already matched filled qty' : stopReplaced ? 'replaced to filled qty' : 'see logs'}` +
      `\nChild stop qty at fill: ${observedStopQty ?? 'n/a'}  restingOrder=${stopOrderId || 'none'}`;

  const header = stopAlignFailed
    ? '🚨 PARTIAL FILL — STOP NOT ALIGNED'
    : '⚠️ PARTIAL FILL — booked actual size';

  await sendTelegram(
    `${header}\n` +
      `Strategy: ${strat}\n` +
      `Position: #${positionId ?? '?'} ${sym}\n` +
      `Requested: ${requestedQty}  Filled: ${fillQuantity ?? 'n/a'}  Booked: ${bookedQty}\n` +
      `${stopLine}`,
    stopAlignFailed ? 'oto_stop_align_failed' : 'partial_fill_booked',
    strategy
  );
  return { sent: true };
}

export async function sendInsufficientBudgetTelegram(
  signal,
  requiredCost,
  budgetRemaining,
  _meta = {}
) {
  const ticker = signal?.ticker || 'unknown';
  const needed = Number(requiredCost).toFixed(2);
  const left = Number(budgetRemaining).toFixed(2);
  await sendTelegram(
    `Signal on ${ticker} skipped: insufficient budget ` +
      `(needed $${needed}, have $${left} remaining — FCFS, no per-slot reserve)`,
    'insufficient_budget',
    'swing'
  );
}

export async function sendTradingViewOfflineTelegram() {
  await sendTelegram('⚠️ TradingView MCP offline — scan skipped', 'tv_offline', 'swing');
}

export async function sendConfirmBarRecalSuggestionTelegram({
  reportDate,
  winnerCount,
  dateRange,
  suggestions,
}) {
  const lines = (suggestions || []).map(
    (s) =>
      `• ${s.parameter}: ${s.current_value} → ${s.suggested_value} (${s.confidence})`
  );
  const range =
    dateRange?.start && dateRange?.end
      ? `${dateRange.start} → ${dateRange.end}`
      : 'n/a';
  await sendTelegram(
    `📊 Confirm-bar recalibration suggestion (pending approval)\n` +
      `Report: ${reportDate}\n` +
      `Winners: ${winnerCount} | Window: ${range}\n` +
      (lines.length ? lines.join('\n') : '(no material changes)') +
      `\nNothing auto-applied — review suggested_changes.`,
    'confirm_bar_recal_suggestion'
  );
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
    const { getScheduledTradingHalt } = await import('./budget/tradingHalt.js');
    const halt = await getScheduledTradingHalt();
    if (halt.active) {
      await sendScheduledHaltTelegram(halt);
      return { action: 'halt_blocks_go', mode: 'MANUAL' };
    }
    await setExecutionMode('AUTO');
    await sendModeSwitchTelegram('AUTO');
    return { action: 'mode_switch', mode: 'AUTO' };
  }

  await sendStatusReplyTelegram();
  return { action: 'status_reply' };
}
