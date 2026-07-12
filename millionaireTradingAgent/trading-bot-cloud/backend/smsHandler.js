import twilio from 'twilio';
import {
  getBotState,
  setExecutionMode,
  getOpenPositionCount,
} from './db.js';
import { getBudgetRemaining, MAX_MONTHLY_BUDGET } from './positionManager.js';

let twilioClient = null;

function getClient() {
  if (!twilioClient && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

function formatPhone(num) {
  return num?.startsWith('+') ? num : `+1${num?.replace(/\D/g, '')}`;
}

export async function sendSms(body) {
  const client = getClient();
  const to = formatPhone(process.env.ALERT_TO_NUMBER);
  const from = process.env.TWILIO_FROM_NUMBER;

  if (!client || !to || !from) {
    console.log('[SMS SKIPPED - not configured]', body);
    return null;
  }

  try {
    const message = await client.messages.create({ body, from, to });
    console.log(`SMS sent: ${message.sid}`);
    return message;
  } catch (err) {
    console.error('SMS send failed:', err.message);
    return null;
  }
}

export async function sendTradeOpened(trade) {
  const paper = trade.paper ? ' [PAPER]' : '';
  await sendSms(
    `TRADE OPENED${paper}\n` +
    `${trade.ticker} ${trade.direction}\n` +
    `Strike: $${trade.strike}\n` +
    `Exp: ${trade.expiration}\n` +
    `Premium: $${trade.premium.toFixed(2)} x ${trade.quantity}\n` +
    `Cost: $${trade.totalCost.toFixed(2)}`
  );
}

export async function sendTradeClosed(position, reason, pnlPct, exitPremium) {
  const reasonLabel = {
    profit_target: 'Profit target (+30%)',
    stop_loss: 'Stop loss (-10%)',
    manual_close: 'Manual close',
  }[reason] || reason;

  await sendSms(
    `TRADE CLOSED\n` +
    `${position.ticker} ${position.direction}\n` +
    `Strike: $${position.strike} | Exp: ${position.expiration}\n` +
    `Exit premium: $${exitPremium.toFixed(2)}\n` +
    `P&L: ${(pnlPct * 100).toFixed(1)}%\n` +
    `Reason: ${reasonLabel}`
  );
}

export async function sendSignalNotExecuted(signal, reason) {
  await sendSms(
    `SIGNAL NOT EXECUTED\n` +
    `${signal.ticker} | ${signal.signalType}\n` +
    `Direction: ${signal.direction || 'N/A'} | Confidence: ${signal.confidence}\n` +
    `Reason: ${reason}`
  );
}

export async function sendBudgetExhausted() {
  await sendSms(
    `MONTHLY BUDGET EXHAUSTED\n` +
    `Max spend of $${MAX_MONTHLY_BUDGET} reached. No new trades until next month.`
  );
}

export async function sendModeSwitch(mode) {
  await sendSms(
    `MODE SWITCHED\n` +
    `Execution mode is now: ${mode}\n` +
    `${mode === 'AUTO' ? 'Bot will auto-execute HIGH confidence trades.' : 'Bot will alert only — no auto-execution.'}`
  );
}

export async function sendStatusReply() {
  const state = await getBotState();
  const openCount = await getOpenPositionCount();
  const budgetRemaining = await getBudgetRemaining();

  await sendSms(
    `BOT STATUS\n` +
    `Mode: ${state.execution_mode}\n` +
    `Open positions: ${openCount}/3\n` +
    `Budget remaining: $${budgetRemaining.toFixed(2)} / $${MAX_MONTHLY_BUDGET}\n` +
    `Paper trading: ${process.env.PAPER_TRADING !== 'false' ? 'ON' : 'OFF'}`
  );
}

export async function handleInboundSms(body) {
  const command = body?.trim().toUpperCase();

  if (command === 'STOP') {
    await setExecutionMode('MANUAL');
    await sendModeSwitch('MANUAL');
    return { action: 'mode_switch', mode: 'MANUAL' };
  }

  if (command === 'GO') {
    await setExecutionMode('AUTO');
    await sendModeSwitch('AUTO');
    return { action: 'mode_switch', mode: 'AUTO' };
  }

  await sendStatusReply();
  return { action: 'status_reply' };
}

export { sendTradeClosed as notifyClose };
