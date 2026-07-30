import { getSql } from '../sqlClient.js';
import { getOptionPremium } from '../brokerageConnector.js';
import { etDateKey } from '../orb/tradierTimesales.js';
import { getOpenPositions } from '../db.js';
import { getOrbOpenPositions } from '../orb/orbDb.js';
import { getPremarketOpenPositions } from '../premarketBreakout/premarketDb.js';
import { getEmaVwapOpenPositions } from '../emaVwapCross/emaVwapDb.js';
import { getLiveStrategyKeys } from './liveBudget.js';
import { sendDailyLossLimitTelegram } from '../telegramHandler.js';

export const LIVE_DAILY_LOSS_LIMIT_PCT = 0.3;

let schemaReady;

export function computeDailyPnl({ realizedToday, unrealizedOpen }) {
  return (Number(realizedToday) || 0) + (Number(unrealizedOpen) || 0);
}

export function shouldTriggerDailyLossLimit({ baselineBalance, dailyPnl }) {
  const baseline = Number(baselineBalance);
  if (!Number.isFinite(baseline) || baseline <= 0) return false;
  return Number(dailyPnl) <= -LIVE_DAILY_LOSS_LIMIT_PCT * baseline;
}

export function computeUnrealizedPnl(position, currentPremium) {
  const entry = Number(position.entry_premium);
  const current = Number(currentPremium);
  const qty = Number(position.contracts_open ?? position.quantity) || 0;
  if (!Number.isFinite(entry) || !Number.isFinite(current) || qty <= 0) return 0;
  return (current - entry) * 100 * qty;
}

async function ensureLiveRiskSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();
    await sql`
      CREATE TABLE IF NOT EXISTS live_risk_state (
        trade_date TEXT PRIMARY KEY,
        baseline_balance DOUBLE PRECISION NOT NULL,
        circuit_breaker_active BOOLEAN NOT NULL DEFAULT false,
        triggered_at TEXT,
        alert_sent BOOLEAN NOT NULL DEFAULT false,
        last_daily_pnl DOUBLE PRECISION,
        last_realized_today DOUBLE PRECISION,
        last_unrealized_open DOUBLE PRECISION,
        updated_at TEXT NOT NULL
      )
    `;
  })();
  return schemaReady;
}

async function getOpenPositionsForStrategy(strategy) {
  if (strategy === 'swing') return getOpenPositions();
  if (strategy === 'orb') return getOrbOpenPositions();
  if (strategy === 'premarket') return getPremarketOpenPositions();
  if (strategy === 'emavwap') return getEmaVwapOpenPositions();
  return [];
}

async function sumRealizedPnlToday(strategy, tradeDate) {
  const sql = getSql();
  let rows;

  if (strategy === 'swing') {
    rows = await sql`
      SELECT COALESCE(
        SUM((exit_premium - entry_premium) * COALESCE(quantity, 1) * 100),
        0
      )::float AS total
      FROM trade_log
      WHERE LEFT(closed_at::text, 10) = ${tradeDate}
    `;
  } else if (strategy === 'orb') {
    rows = await sql`
      SELECT COALESCE(SUM(realized_pnl), 0)::float AS total
      FROM orb_trade_log
      WHERE LEFT(closed_at::text, 10) = ${tradeDate}
        AND COALESCE(close_reason, '') NOT IN ('entry_unfilled_cancelled', 'entry_never_filled')
    `;
  } else if (strategy === 'premarket') {
    rows = await sql`
      SELECT COALESCE(SUM(realized_pnl), 0)::float AS total
      FROM premarket_trade_log
      WHERE LEFT(closed_at::text, 10) = ${tradeDate}
        AND COALESCE(close_reason, '') NOT IN ('entry_unfilled_cancelled', 'entry_never_filled')
    `;
  } else if (strategy === 'emavwap') {
    rows = await sql`
      SELECT COALESCE(SUM(realized_pnl), 0)::float AS total
      FROM emavwap_trade_log
      WHERE LEFT(closed_at::text, 10) = ${tradeDate}
        AND COALESCE(close_reason, '') NOT IN ('entry_unfilled_cancelled', 'entry_never_filled')
    `;
  } else {
    return 0;
  }

  return Number(rows[0]?.total) || 0;
}

export async function computeLiveDailyPnlBreakdown(liveStrategies, tradeDate = etDateKey()) {
  let realizedToday = 0;
  let unrealizedOpen = 0;

  for (const strategy of liveStrategies) {
    realizedToday += await sumRealizedPnlToday(strategy, tradeDate);

    const positions = await getOpenPositionsForStrategy(strategy);
    for (const position of positions) {
      try {
        const currentPremium = await getOptionPremium(
          position.ticker,
          position.direction,
          position.strike,
          position.expiration
        );
        unrealizedOpen += computeUnrealizedPnl(position, currentPremium);
      } catch (err) {
        console.warn(
          `[LiveRisk] Premium lookup failed for ${strategy} ${position.ticker}:`,
          err.message
        );
      }
    }
  }

  return {
    tradeDate,
    realizedToday,
    unrealizedOpen,
    dailyPnl: computeDailyPnl({ realizedToday, unrealizedOpen }),
  };
}

async function getRiskRow(tradeDate) {
  await ensureLiveRiskSchema();
  const sql = getSql();
  const rows = await sql`SELECT * FROM live_risk_state WHERE trade_date = ${tradeDate}`;
  return rows[0] || null;
}

export async function isLiveDailyLossLimitActive(tradeDate = etDateKey()) {
  const liveStrategies = await getLiveStrategyKeys();
  if (liveStrategies.length === 0) return false;

  const row = await getRiskRow(tradeDate);
  return Boolean(row?.circuit_breaker_active);
}

export async function syncLiveDailyLossLimit({
  baselineBalance,
  tradeDate = etDateKey(),
  liveStrategies,
}) {
  await ensureLiveRiskSchema();
  const sql = getSql();
  const strategies = liveStrategies || (await getLiveStrategyKeys());
  if (strategies.length === 0) {
    return { active: false, skipped: true, reason: 'no_live_strategies' };
  }

  const baseline = Number(baselineBalance);
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return { active: false, skipped: true, reason: 'invalid_baseline' };
  }

  let row = await getRiskRow(tradeDate);
  if (!row) {
    const [inserted] = await sql`
      INSERT INTO live_risk_state (
        trade_date,
        baseline_balance,
        circuit_breaker_active,
        alert_sent,
        updated_at
      )
      VALUES (${tradeDate}, ${baseline}, false, false, NOW()::text)
      ON CONFLICT (trade_date) DO NOTHING
      RETURNING *
    `;
    row = inserted || (await getRiskRow(tradeDate));
  }

  const pnl = await computeLiveDailyPnlBreakdown(strategies, tradeDate);
  const shouldTrip =
    !row?.circuit_breaker_active &&
    shouldTriggerDailyLossLimit({ baselineBalance: row.baseline_balance, dailyPnl: pnl.dailyPnl });

  let circuitBreakerActive = Boolean(row?.circuit_breaker_active);
  let triggeredAt = row?.triggered_at || null;
  let alertSent = Boolean(row?.alert_sent);

  if (shouldTrip) {
    circuitBreakerActive = true;
    triggeredAt = new Date().toISOString();
    const lossAmount = Math.abs(Math.min(0, pnl.dailyPnl));
    const lossPct = (lossAmount / row.baseline_balance) * 100;

    if (!alertSent) {
      await sendDailyLossLimitTelegram({
        baseline: row.baseline_balance,
        dailyPnl: pnl.dailyPnl,
        lossAmount,
        lossPct,
        realizedToday: pnl.realizedToday,
        unrealizedOpen: pnl.unrealizedOpen,
      });
      alertSent = true;
    }

    console.log(
      `[LiveRisk] daily_loss_limit_reached — baseline=$${row.baseline_balance.toFixed(2)}, ` +
        `daily P&L=$${pnl.dailyPnl.toFixed(2)} (realized=$${pnl.realizedToday.toFixed(2)}, ` +
        `unrealized=$${pnl.unrealizedOpen.toFixed(2)}), limit=${LIVE_DAILY_LOSS_LIMIT_PCT * 100}%`
    );
  }

  await sql`
    UPDATE live_risk_state
    SET
      circuit_breaker_active = ${circuitBreakerActive},
      triggered_at = ${triggeredAt},
      alert_sent = ${alertSent},
      last_daily_pnl = ${pnl.dailyPnl},
      last_realized_today = ${pnl.realizedToday},
      last_unrealized_open = ${pnl.unrealizedOpen},
      updated_at = NOW()::text
    WHERE trade_date = ${tradeDate}
  `;

  return {
    active: circuitBreakerActive,
    tradeDate,
    baselineBalance: row.baseline_balance,
    ...pnl,
    lossLimitPct: LIVE_DAILY_LOSS_LIMIT_PCT,
    newlyTriggered: shouldTrip,
  };
}

export async function getLiveDailyLossStatus(tradeDate = etDateKey()) {
  const row = await getRiskRow(tradeDate);
  if (!row) {
    return {
      tradeDate,
      active: false,
      baselineBalance: null,
      lastDailyPnl: null,
    };
  }

  return {
    tradeDate,
    active: Boolean(row.circuit_breaker_active),
    baselineBalance: Number(row.baseline_balance),
    lastDailyPnl: Number(row.last_daily_pnl),
    lastRealizedToday: Number(row.last_realized_today),
    lastUnrealizedOpen: Number(row.last_unrealized_open),
    triggeredAt: row.triggered_at,
  };
}
