import { getSql } from '../sqlClient.js';
import { ladderExitPhase } from '../ladder/ladderConfig.js';
import { computeRealizedPnlDollars } from '../tradePnl.js';
import { readStrategyEnvironmentForLog } from '../tradeLogEnvironment.js';

const BOT_SYMBOL = '';
const BOT_DATE = '';

let schemaReady;

function rowToObject(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row));
}

export async function ensurePremarketSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();

    await sql`
      CREATE TABLE IF NOT EXISTS premarket_state (
        symbol TEXT NOT NULL DEFAULT '',
        trade_date TEXT NOT NULL DEFAULT '',
        pm_high DOUBLE PRECISION,
        pm_low DOUBLE PRECISION,
        range_complete BOOLEAN NOT NULL DEFAULT false,
        fsm_json TEXT NOT NULL DEFAULT '{}',
        monthly_spend DOUBLE PRECISION,
        budget_month TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (symbol, trade_date)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS premarket_positions (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ticker TEXT NOT NULL,
        direction TEXT NOT NULL,
        strike DOUBLE PRECISION NOT NULL,
        expiration TEXT NOT NULL,
        entry_premium DOUBLE PRECISION NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        order_id TEXT,
        broker TEXT,
        opened_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        premarket_high DOUBLE PRECISION,
        premarket_low DOUBLE PRECISION,
        breakout_level DOUBLE PRECISION,
        breakout_direction TEXT,
        confirmation_candles_json TEXT,
        strike_bucket TEXT,
        entry_iv DOUBLE PRECISION,
        entry_delta DOUBLE PRECISION,
        mfe_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
        mae_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
        entry_metadata_json TEXT
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS premarket_trade_log (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ticker TEXT NOT NULL,
        direction TEXT NOT NULL,
        strike DOUBLE PRECISION NOT NULL,
        expiration TEXT NOT NULL,
        entry_premium DOUBLE PRECISION NOT NULL,
        exit_premium DOUBLE PRECISION,
        quantity INTEGER NOT NULL DEFAULT 1,
        pnl_pct DOUBLE PRECISION,
        realized_pnl DOUBLE PRECISION,
        premarket_high DOUBLE PRECISION,
        premarket_low DOUBLE PRECISION,
        breakout_level DOUBLE PRECISION,
        breakout_direction TEXT,
        confirmation_candles_json TEXT,
        strike_bucket TEXT,
        entry_iv DOUBLE PRECISION,
        entry_delta DOUBLE PRECISION,
        mfe_pct DOUBLE PRECISION,
        mae_pct DOUBLE PRECISION,
        close_reason TEXT,
        opened_at TEXT NOT NULL,
        closed_at TEXT NOT NULL
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS premarket_event_log (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ticker TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        event_type TEXT NOT NULL,
        direction TEXT,
        breakout_level DOUBLE PRECISION,
        details_json TEXT,
        created_at TEXT NOT NULL
      )
    `;

    await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS premarket_mode TEXT DEFAULT 'AUTO'`;

    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS exit_phase TEXT DEFAULT 'INITIAL'`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS contracts_open INTEGER`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS trail_peak_pnl_frac DOUBLE PRECISION NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS entry_contracts INTEGER`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS pyramid_tier TEXT`;
    await sql`ALTER TABLE premarket_trade_log ADD COLUMN IF NOT EXISTS entry_contracts INTEGER`;
    await sql`ALTER TABLE premarket_trade_log ADD COLUMN IF NOT EXISTS pyramid_tier TEXT`;
    // live|paper at insert time. NULL = pre-deploy unknown. No backfill.
    await sql`ALTER TABLE premarket_trade_log ADD COLUMN IF NOT EXISTS environment TEXT`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS broker_stop_order_id TEXT`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS broker_stop_trigger_price DOUBLE PRECISION`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS broker_stop_pnl_frac DOUBLE PRECISION`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS pending_close_order_id TEXT`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS pending_close_reason TEXT`;
    await sql`ALTER TABLE premarket_positions ADD COLUMN IF NOT EXISTS pending_close_submitted_at TEXT`;

    const month = new Date().toISOString().slice(0, 7);
    const existing = await sql`
      SELECT symbol FROM premarket_state WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
    `;
    if (existing.length === 0) {
      await sql`
        INSERT INTO premarket_state (symbol, trade_date, monthly_spend, budget_month, updated_at)
        VALUES (${BOT_SYMBOL}, ${BOT_DATE}, 0, ${month}, NOW()::text)
      `;
    }
  })();
  return schemaReady;
}

export async function getPremarketBotState() {
  await ensurePremarketSchema();
  const sql = getSql();
  const currentMonth = new Date().toISOString().slice(0, 7);
  let rows = await sql`
    SELECT * FROM premarket_state WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
  `;
  let state = rowToObject(rows[0]);

  if (state.budget_month !== currentMonth) {
    await sql`
      UPDATE premarket_state
      SET monthly_spend = 0, budget_month = ${currentMonth}, updated_at = NOW()::text
      WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
    `;
    rows = await sql`
      SELECT * FROM premarket_state WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
    `;
    state = rowToObject(rows[0]);
  }
  return state;
}

export async function getPremarketMode() {
  await ensurePremarketSchema();
  const sql = getSql();
  const rows = await sql`SELECT premarket_mode FROM bot_state WHERE id = 1`;
  return rows[0]?.premarket_mode || 'AUTO';
}

export async function addPremarketMonthlySpend(amount) {
  await ensurePremarketSchema();
  const sql = getSql();
  await sql`
    UPDATE premarket_state
    SET monthly_spend = COALESCE(monthly_spend, 0) + ${amount}, updated_at = NOW()::text
    WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
  `;
}

export async function getPremarketBudgetRemaining() {
  const { getPremarketBudgetRemaining: remaining } = await import('../budget/budgetAllocations.js');
  return remaining();
}

export async function getPremarketOpenPositions() {
  await ensurePremarketSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM premarket_positions WHERE status = 'OPEN' ORDER BY opened_at DESC
  `;
  return rows.map(rowToObject);
}

export async function getPremarketOpenPositionCount() {
  await ensurePremarketSchema();
  const sql = getSql();
  const [row] = await sql`
    SELECT COUNT(*)::int AS count FROM premarket_positions WHERE status = 'OPEN'
  `;
  return Number(row.count);
}

export async function getPremarketTradeLog(limit = 500) {
  await ensurePremarketSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM premarket_trade_log ORDER BY closed_at DESC LIMIT ${limit}
  `;
  return rows.map(rowToObject);
}

export async function getPremarketRangeRow(symbol, tradeDate) {
  await ensurePremarketSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM premarket_state WHERE symbol = ${symbol} AND trade_date = ${tradeDate}
  `;
  return rowToObject(rows[0]);
}

export async function upsertPremarketRangeState({
  symbol,
  tradeDate,
  pmHigh,
  pmLow,
  rangeComplete,
  fsmJson,
}) {
  await ensurePremarketSchema();
  const sql = getSql();
  const fsm = typeof fsmJson === 'string' ? fsmJson : JSON.stringify(fsmJson ?? {});
  await sql`
    INSERT INTO premarket_state (symbol, trade_date, pm_high, pm_low, range_complete, fsm_json, updated_at)
    VALUES (
      ${symbol},
      ${tradeDate},
      ${pmHigh},
      ${pmLow},
      ${rangeComplete},
      ${fsm},
      NOW()::text
    )
    ON CONFLICT (symbol, trade_date) DO UPDATE SET
      pm_high = EXCLUDED.pm_high,
      pm_low = EXCLUDED.pm_low,
      range_complete = EXCLUDED.range_complete,
      fsm_json = EXCLUDED.fsm_json,
      updated_at = NOW()::text
  `;
}

export async function insertPremarketPosition(position) {
  await ensurePremarketSchema();
  const sql = getSql();
  const entryContracts = position.entry_contracts ?? position.quantity;
  const pyramidTier = position.pyramid_tier ?? 'ladder';
  const [row] = await sql`
    INSERT INTO premarket_positions (
      ticker, direction, strike, expiration, entry_premium, quantity, order_id, broker,
      opened_at, status, premarket_high, premarket_low, breakout_level,
      breakout_direction, confirmation_candles_json, strike_bucket, entry_iv, entry_delta,
      mfe_pct, mae_pct, entry_metadata_json, exit_phase, contracts_open, trail_peak_pnl_frac,
      entry_contracts, pyramid_tier
    )
    VALUES (
      ${position.ticker},
      ${position.direction},
      ${position.strike},
      ${position.expiration},
      ${position.entry_premium},
      ${position.quantity},
      ${position.order_id},
      ${position.broker},
      NOW()::text,
      'OPEN',
      ${position.premarket_high},
      ${position.premarket_low},
      ${position.breakout_level},
      ${position.breakout_direction},
      ${position.confirmation_candles_json},
      ${position.strike_bucket},
      ${position.entry_iv},
      ${position.entry_delta},
      0,
      0,
      ${position.entry_metadata_json},
      ${ladderExitPhase(0)},
      ${position.quantity},
      0,
      ${entryContracts},
      ${pyramidTier}
    )
    RETURNING id
  `;
  return row.id;
}

export async function updatePremarketPositionExcursion(id, mfePct, maePct) {
  await ensurePremarketSchema();
  const sql = getSql();
  await sql`
    UPDATE premarket_positions
    SET mfe_pct = ${mfePct}, mae_pct = ${maePct}
    WHERE id = ${id}
  `;
}

export async function updatePremarketPositionPyramidState(id, state) {
  await ensurePremarketSchema();
  const sql = getSql();
  await sql`
    UPDATE premarket_positions
    SET
      exit_phase = COALESCE(${state.exit_phase ?? null}, exit_phase),
      contracts_open = COALESCE(${state.contracts_open ?? null}, contracts_open),
      quantity = COALESCE(${state.quantity ?? null}, quantity),
      trail_peak_pnl_frac = COALESCE(${state.trail_peak_pnl_frac ?? null}, trail_peak_pnl_frac)
    WHERE id = ${id}
  `;
}

export async function updatePremarketPositionBrokerStop(id, state) {
  await ensurePremarketSchema();
  const sql = getSql();
  await sql`
    UPDATE premarket_positions
    SET
      broker_stop_order_id = ${state.broker_stop_order_id ?? null},
      broker_stop_trigger_price = ${state.broker_stop_trigger_price ?? null},
      broker_stop_pnl_frac = ${state.broker_stop_pnl_frac ?? null}
    WHERE id = ${id}
  `;
}

export async function updatePremarketPositionPendingClose(id, state) {
  await ensurePremarketSchema();
  const sql = getSql();
  await sql`
    UPDATE premarket_positions
    SET
      pending_close_order_id = ${state.pending_close_order_id ?? null},
      pending_close_reason = ${state.pending_close_reason ?? null},
      pending_close_submitted_at = ${state.pending_close_submitted_at ?? null}
    WHERE id = ${id}
  `;
}

async function insertPremarketTradeLogLeg(tx, position, exitPremium, pnlPct, reason, legQty) {
  const realizedPnl = computeRealizedPnlDollars({
    entryPremium: position.entry_premium,
    exitPremium,
    quantity: legQty,
    closeReason: reason,
  });

  const environment = await readStrategyEnvironmentForLog('premarket', tx);
  await tx`
    INSERT INTO premarket_trade_log (
      ticker, direction, strike, expiration, entry_premium, exit_premium, quantity,
      pnl_pct, realized_pnl, premarket_high, premarket_low, breakout_level,
      breakout_direction, confirmation_candles_json, strike_bucket, entry_iv, entry_delta,
      mfe_pct, mae_pct, close_reason, opened_at, closed_at, entry_contracts, pyramid_tier,
      environment
    )
    VALUES (
      ${position.ticker},
      ${position.direction},
      ${position.strike},
      ${position.expiration},
      ${position.entry_premium},
      ${exitPremium},
      ${legQty},
      ${pnlPct},
      ${realizedPnl},
      ${position.premarket_high},
      ${position.premarket_low},
      ${position.breakout_level},
      ${position.breakout_direction},
      ${position.confirmation_candles_json},
      ${position.strike_bucket},
      ${position.entry_iv},
      ${position.entry_delta},
      ${position.mfe_pct},
      ${position.mae_pct},
      ${reason},
      ${position.opened_at},
      NOW()::text,
      ${position.entry_contracts ?? position.quantity},
      ${position.pyramid_tier ?? null},
      ${environment}
    )
  `;
}

export async function partialClosePremarketPosition(id, exitPremium, pnlPct, reason, closeQty, stateUpdate) {
  await ensurePremarketSchema();
  const sql = getSql();
  const posRows = await sql`SELECT * FROM premarket_positions WHERE id = ${id}`;
  const position = rowToObject(posRows[0]);
  if (!position) return null;

  const exitFrac = Number(pnlPct) / 100;
  const mfePct = Math.max(Number(position.mfe_pct) || 0, exitFrac);
  const maePct = Math.min(Number(position.mae_pct) || 0, exitFrac);

  await sql.begin(async (tx) => {
    await insertPremarketTradeLogLeg(tx, position, exitPremium, pnlPct, reason, closeQty);
    await tx`
      UPDATE premarket_positions
      SET
        quantity = ${stateUpdate.quantity},
        contracts_open = ${stateUpdate.contracts_open},
        exit_phase = ${stateUpdate.exit_phase},
        trail_peak_pnl_frac = ${stateUpdate.trail_peak_pnl_frac ?? 0},
        mfe_pct = ${mfePct},
        mae_pct = ${maePct}
      WHERE id = ${id}
    `;
  });

  return position;
}

/** True when UPDATE … AND status = 'OPEN' claimed the row. */
export function premarketCloseUpdateClaimed(updated) {
  const count = Number(updated?.count);
  if (Number.isFinite(count)) return count > 0;
  return Array.isArray(updated) && updated.length > 0;
}

export async function closePremarketPosition(id, exitPremium, pnlPct, reason, closeQty = null) {
  await ensurePremarketSchema();
  const sql = getSql();
  const posRows = await sql`SELECT * FROM premarket_positions WHERE id = ${id}`;
  const position = rowToObject(posRows[0]);
  if (!position) return null;
  if (String(position.status || '').toUpperCase() === 'CLOSED') return null;

  const legQty = closeQty ?? position.quantity;
  const exitFrac = Number(pnlPct) / 100;
  const mfePct = Math.max(Number(position.mfe_pct) || 0, exitFrac);
  const maePct = Math.min(Number(position.mae_pct) || 0, exitFrac);
  position.mfe_pct = mfePct;
  position.mae_pct = maePct;

  let claimed = false;
  await sql.begin(async (tx) => {
    const updated = await tx`
      UPDATE premarket_positions
      SET status = 'CLOSED'
      WHERE id = ${id} AND status = 'OPEN'
      RETURNING id
    `;
    if (!premarketCloseUpdateClaimed(updated)) return;
    await insertPremarketTradeLogLeg(tx, position, exitPremium, pnlPct, reason, legQty);
    claimed = true;
  });

  return claimed ? position : null;
}

export async function logPremarketEvent({ ticker, tradeDate, eventType, direction, breakoutLevel, details }) {
  await ensurePremarketSchema();
  const sql = getSql();
  await sql`
    INSERT INTO premarket_event_log (ticker, trade_date, event_type, direction, breakout_level, details_json, created_at)
    VALUES (
      ${ticker},
      ${tradeDate},
      ${eventType},
      ${direction || null},
      ${breakoutLevel ?? null},
      ${JSON.stringify(details ?? {})},
      NOW()::text
    )
  `;
}

/** True only while a filled position for this breakout key is still OPEN. */
export async function hasPremarketBreakoutExecutedToday({
  ticker,
  direction,
  breakoutLevel,
  tradeDate,
}) {
  await ensurePremarketSchema();
  const sql = getSql();
  const level = Number(breakoutLevel);

  const [posRow] = await sql`
    SELECT 1 FROM premarket_positions
    WHERE ticker = ${ticker}
      AND direction = ${direction}
      AND breakout_level = ${level}
      AND expiration = ${tradeDate}
      AND status = 'OPEN'
    LIMIT 1
  `;
  return Boolean(posRow);
}

export async function listPremarketBreakoutCloseOutcomes({ ticker, tradeDate }) {
  await ensurePremarketSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT direction, breakout_level, opened_at, closed_at, realized_pnl
    FROM premarket_trade_log
    WHERE ticker = ${ticker}
      AND expiration = ${tradeDate}
      AND COALESCE(close_reason, '') NOT IN ('entry_unfilled_cancelled', 'entry_never_filled')
    ORDER BY closed_at ASC
  `;
  return rows.map((row) => ({
    direction: row.direction,
    breakout_level: row.breakout_level,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    realized_pnl: row.realized_pnl,
  }));
}
