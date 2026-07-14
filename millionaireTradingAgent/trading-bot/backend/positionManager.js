import {
  getBotState,
  getOpenPositions,
  getOpenPositionCount,
  addMonthlySpend,
  closePosition,
  getTradeLog,
} from './db.js';
import {
  fetchQuote,
  findMonthlyExpiration,
  getOptionPremium,
  closeOptionOrder,
} from './brokerageConnector.js';

const MAX_POSITIONS = 3;
const MAX_MONTHLY_BUDGET = 599;
const PROFIT_TARGET_PCT = 0.30;
const STOP_LOSS_PCT = 0.10;
const STARTING_CAPITAL = Number(process.env.PORTFOLIO_STARTING_CAPITAL) || MAX_MONTHLY_BUDGET;

function getEtNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function getPeriodStart(period, now = getEtNow()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  if (period === 'day') return start;

  if (period === 'week') {
    const day = start.getDay();
    const daysFromMonday = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - daysFromMonday);
    return start;
  }

  if (period === 'month') {
    start.setDate(1);
    return start;
  }

  if (period === 'year') {
    start.setMonth(0, 1);
    return start;
  }

  return start;
}

function parseClosedAt(closedAt) {
  if (!closedAt) return null;
  if (closedAt.includes('T')) return new Date(closedAt);
  return new Date(`${closedAt.replace(' ', 'T')}Z`);
}

function tradeRealizedDollars(trade) {
  if (trade.exit_premium == null || trade.entry_premium == null) return 0;
  return (Number(trade.exit_premium) - Number(trade.entry_premium)) * 100;
}

function sumRealizedInPeriod(trades, period) {
  const start = getPeriodStart(period);
  return trades.reduce((sum, trade) => {
    const closed = parseClosedAt(trade.closed_at);
    if (!closed || closed < start) return sum;
    return sum + tradeRealizedDollars(trade);
  }, 0);
}

export async function getBudgetRemaining() {
  const state = await getBotState();
  return Math.max(0, MAX_MONTHLY_BUDGET - state.monthly_spend);
}

export async function canOpenPosition() {
  const openCount = await getOpenPositionCount();
  const budgetRemaining = await getBudgetRemaining();
  return openCount < MAX_POSITIONS && budgetRemaining > 0;
}

export async function calculatePositionSize() {
  const openCount = await getOpenPositionCount();
  const slotsAvailable = MAX_POSITIONS - openCount;
  const budgetRemaining = await getBudgetRemaining();

  if (slotsAvailable <= 0 || budgetRemaining <= 0) return 0;

  return budgetRemaining / slotsAvailable;
}

export async function selectStrike(ticker, direction) {
  const { price } = await fetchQuote(ticker);
  const step = ticker === 'VIX' ? 1 : ticker === 'SOFI' ? 0.5 : 1;
  const atm = Math.round(price / step) * step;

  if (direction === 'CALL') {
    return atm + step;
  }
  return atm - step;
}

export async function buildTradeParams(signal) {
  const expiration = await findMonthlyExpiration();
  const strike = await selectStrike(signal.ticker, signal.direction);
  const premium = await getOptionPremium(signal.ticker, signal.direction, strike, expiration);
  const budgetPerSlot = await calculatePositionSize();
  const contractCost = premium * 100;
  const quantity = Math.floor(budgetPerSlot / contractCost);

  return {
    ticker: signal.ticker,
    direction: signal.direction,
    strike,
    expiration,
    premium,
    quantity,
    totalCost: quantity >= 1 ? premium * quantity * 100 : 0,
    requiredCost: contractCost,
    affordable: quantity >= 1,
  };
}

export async function monitorOpenPositions(notifyClose) {
  const positions = await getOpenPositions();
  const actions = [];

  for (const position of positions) {
    const currentPremium = await getOptionPremium(
      position.ticker,
      position.direction,
      position.strike,
      position.expiration
    );

    const pnlPct = (currentPremium - position.entry_premium) / position.entry_premium;
    let closeReason = null;

    if (pnlPct >= PROFIT_TARGET_PCT) {
      closeReason = 'profit_target';
    } else if (pnlPct <= -STOP_LOSS_PCT) {
      closeReason = 'stop_loss';
    }

    if (closeReason) {
      await closeOptionOrder(position, currentPremium);
      await closePosition(position.id, currentPremium, pnlPct * 100, closeReason);
      actions.push({ position, closeReason, pnlPct, exitPremium: currentPremium });
      if (notifyClose) {
        await notifyClose(position, closeReason, pnlPct, currentPremium);
      }
    } else {
      actions.push({ position, pnlPct, currentPremium, closeReason: null });
    }
  }

  return actions;
}

export async function getPositionsWithPnL() {
  const positions = await getOpenPositions();
  const enriched = [];

  for (const position of positions) {
    try {
      const currentPremium = await getOptionPremium(
        position.ticker,
        position.direction,
        position.strike,
        position.expiration
      );
      const pnlPct = ((currentPremium - position.entry_premium) / position.entry_premium) * 100;
      enriched.push({ ...position, currentPremium, pnlPct });
    } catch {
      enriched.push({ ...position, currentPremium: null, pnlPct: null });
    }
  }

  return enriched;
}

export async function getPortfolioSummary() {
  const positions = await getPositionsWithPnL();
  const cashOnHand = await getBudgetRemaining();
  const trades = await getTradeLog(500);

  const costBasis = positions.reduce(
    (sum, p) => sum + Number(p.entry_premium) * Number(p.quantity) * 100,
    0
  );
  const marketValue = positions.reduce((sum, p) => {
    const mark = p.currentPremium ?? p.entry_premium;
    return sum + Number(mark) * Number(p.quantity) * 100;
  }, 0);
  const unrealizedPnl = marketValue - costBasis;
  const unrealizedPnlPct = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

  const realizedPnl = trades.reduce((sum, t) => sum + tradeRealizedDollars(t), 0);
  const portfolioValue = cashOnHand + marketValue;
  const totalPnl = realizedPnl + unrealizedPnl;
  const totalPnlPct = STARTING_CAPITAL > 0 ? (totalPnl / STARTING_CAPITAL) * 100 : 0;

  const periods = ['day', 'week', 'month', 'year'];
  const returnsPct = {};
  const returnsPnl = {};

  for (const period of periods) {
    const realizedInPeriod = sumRealizedInPeriod(trades, period);
    const periodPnl = realizedInPeriod + unrealizedPnl;
    returnsPnl[period] = periodPnl;
    returnsPct[period] =
      STARTING_CAPITAL > 0 ? (periodPnl / STARTING_CAPITAL) * 100 : 0;
  }

  return {
    cash_on_hand: cashOnHand,
    portfolio_value: portfolioValue,
    positions_market_value: marketValue,
    positions_cost_basis: costBasis,
    unrealized_pnl: unrealizedPnl,
    unrealized_pnl_pct: unrealizedPnlPct,
    realized_pnl: realizedPnl,
    total_pnl: totalPnl,
    total_pnl_pct: totalPnlPct,
    starting_capital: STARTING_CAPITAL,
    open_position_count: positions.length,
    returns_pct: returnsPct,
    returns_pnl: returnsPnl,
  };
}

export async function recordSpend(amount) {
  await addMonthlySpend(amount);
}

export { MAX_POSITIONS, MAX_MONTHLY_BUDGET, PROFIT_TARGET_PCT, STOP_LOSS_PCT };
