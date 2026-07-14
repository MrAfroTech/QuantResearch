import {
  getBotState,
  setExecutionMode,
  getTradeLog,
  getLastSignal,
} from './db.js';
import {
  getPositionsWithPnL,
  getBudgetRemaining,
  getPortfolioSummary,
  MAX_MONTHLY_BUDGET,
} from './positionManager.js';
import { isPaperTrading } from './brokerageConnector.js';
import { sendModeSwitch } from './smsHandler.js';
import { sendModeSwitchTelegram } from './telegramHandler.js';
import { getLastScanResults } from './tvScanner.js';

export async function buildStatusResponse() {
  const state = await getBotState();
  const positions = await getPositionsWithPnL();
  const tradeLog = await getTradeLog();
  const lastSignal = await getLastSignal();
  const budgetRemaining = await getBudgetRemaining();
  const portfolio = await getPortfolioSummary();

  return {
    execution_mode: state.execution_mode,
    paper_trading: isPaperTrading(),
    monthly_spend: state.monthly_spend,
    budget_remaining: budgetRemaining,
    max_budget: MAX_MONTHLY_BUDGET,
    portfolio,
    last_signal_checked: lastSignal,
    open_positions: positions,
    trade_log: tradeLog,
    server_time: new Date().toISOString(),
    watchlist: process.env.TV_WATCHLIST
      ? process.env.TV_WATCHLIST.split(',').map((t) => t.trim()).filter(Boolean)
      : ['SOFI', 'AI', '^VIX'],
    last_scan_results: getLastScanResults(),
  };
}

export async function switchExecutionMode(mode) {
  if (!['AUTO', 'MANUAL'].includes(mode)) {
    throw new Error('Mode must be AUTO or MANUAL');
  }

  await setExecutionMode(mode);

  try {
    await sendModeSwitch(mode);
  } catch (err) {
    console.error('Mode switch SMS failed:', err.message);
  }

  try {
    await sendModeSwitchTelegram(mode);
  } catch (err) {
    console.error('Mode switch Telegram failed:', err.message);
  }

  return { mode };
}
