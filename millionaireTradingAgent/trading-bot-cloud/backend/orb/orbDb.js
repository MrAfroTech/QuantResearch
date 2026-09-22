import { getSql } from '../sqlClient.js';
import { ladderExitPhase } from '../ladder/ladderConfig.js';
import { computeRealizedPnlDollars } from '../tradePnl.js';
import { readStrategyEnvironmentForLog } from '../tradeLogEnvironment.js';

let schemaReady;

function rowToObject(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row));
}

export async function ensureOrbSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();

    await sql`
      CREATE TABLE IF NOT EXISTS orb_bot_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        orb_monthly_spend DOUBLE PRECISION NOT NULL DEFAULT 0,
        budget_month TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS orb_range_state (
        symbol TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        or_high DOUBLE PRECISION,
        or_low DOUBLE PRECISION,
        range_complete BOOLEAN NOT NULL DEFAULT false,
        fsm_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (symbol, trade_date)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS orb_positions (
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
        opening_range_high DOUBLE PRECISION,
        opening_range_low DOUBLE PRECISION,
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
      CREATE TABLE IF NOT EXISTS orb_trade_log (
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
        opening_range_high DOUBLE PRECISION,
        opening_range_low DOUBLE PRECISION,
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
      CREATE TABLE IF NOT EXISTS orb_event_log (
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

    await sql`ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS orb_mode TEXT DEFAULT 'AUTO'`;

    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS exit_phase TEXT DEFAULT 'INITIAL'`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS contracts_open INTEGER`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS trail_peak_pnl_frac DOUBLE PRECISION NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS entry_contracts INTEGER`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS pyramid_tier TEXT`;
    await sql`ALTER TABLE orb_trade_log ADD COLUMN IF NOT EXISTS entry_contracts INTEGER`;
    await sql`ALTER TABLE orb_trade_log ADD COLUMN IF NOT EXISTS pyramid_tier TEXT`;
    // live|paper at insert time. NULL = pre-deploy unknown. No backfill.
    await sql`ALTER TABLE orb_trade_log ADD COLUMN IF NOT EXISTS environment TEXT`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS broker_stop_order_id TEXT`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS broker_stop_trigger_price DOUBLE PRECISION`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS broker_stop_pnl_frac DOUBLE PRECISION`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS pending_close_order_id TEXT`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS pending_close_reason TEXT`;
    await sql`ALTER TABLE orb_positions ADD COLUMN IF NOT EXISTS pending_close_submitted_at TEXT`;

    const month = new Date().toISOString().slice(0, 7);
    const existing = await sql`SELECT id FROM orb_bot_state WHERE id = 1`;
    if (existing.length === 0) {
      await sql`
        INSERT INTO orb_bot_state (id, orb_monthly_spend, budget_month, updated_at)
        VALUES (1, 0, ${month}, NOW()::text)
      `;
    }
  })();
  return schemaReady;
}

export async function getOrbBotState() {
  await ensureOrbSchema();
  const sql = getSql();
  const currentMonth = new Date().toISOString().slice(0, 7);
  let rows = await sql`SELECT * FROM orb_bot_state WHERE id = 1`;
  let state = rowToObject(rows[0]);

  if (state.budget_month !== currentMonth) {
    await sql`
      UPDATE orb_bot_state
      SET orb_monthly_spend = 0, budget_month = ${currentMonth}, updated_at = NOW()::text
      WHERE id = 1
    `;
    rows = await sql`SELECT * FROM orb_bot_state WHERE id = 1`;
    state = rowToObject(rows[0]);
  }
  return state;
}

export async function getOrbMode() {
  await ensureOrbSchema();
  const sql = getSql();
  const rows = await sql`SELECT orb_mode FROM bot_state WHERE id = 1`;
  return rows[0]?.orb_mode || 'AUTO';
}

export async function addOrbMonthlySpend(amount) {
  await ensureOrbSchema();
  const sql = getSql();
  await sql`
    UPDATE orb_bot_state
    SET orb_monthly_spend = orb_monthly_spend + ${amount}, updated_at = NOW()::text
    WHERE id = 1
  `;
}

export async function getOrbBudgetRemaining() {
  const { getOrbBudgetRemaining: remaining } = await import('../budget/budgetAllocations.js');
  return remaining();
}

export async function getOrbOpenPositions() {
  await ensureOrbSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM orb_positions WHERE status = 'OPEN' ORDER BY opened_at DESC
  `;
  return rows.map(rowToObject);
}

export async function getOrbOpenPositionCount() {
  await ensureOrbSchema();
  const sql = getSql();
  const [row] = await sql`SELECT COUNT(*)::int AS count FROM orb_positions WHERE status = 'OPEN'`;
  return Number(row.count);
}

export async function getOrbRangeState(symbol, tradeDate) {
  await ensureOrbSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM orb_range_state WHERE symbol = ${symbol} AND trade_date = ${tradeDate}
  `;
  return rowToObject(rows[0]);
}

export async function upsertOrbRangeState({
  symbol,
  tradeDate,
  orHigh,
  orLow,
  rangeComplete,
  fsmJson,
}) {
  await ensureOrbSchema();
  const sql = getSql();
  const fsm = typeof fsmJson === 'string' ? fsmJson : JSON.stringify(fsmJson ?? {});
  await sql`
    INSERT INTO orb_range_state (symbol, trade_date, or_high, or_low, range_complete, fsm_json, updated_at)
    VALUES (
      ${symbol},
      ${tradeDate},
      ${orHigh},
      ${orLow},
      ${rangeComplete},
      ${fsm},
      NOW()::text
    )
    ON CONFLICT (symbol, trade_date) DO UPDATE SET
      or_high = EXCLUDED.or_high,
      or_low = EXCLUDED.or_low,
      range_complete = EXCLUDED.range_complete,
      fsm_json = EXCLUDED.fsm_json,
      updated_at = NOW()::text
  `;
}

export async function insertOrbPosition(position) {
  await ensureOrbSchema();
  const sql = getSql();
  const entryContracts = position.entry_contracts ?? position.quantity;
  const pyramidTier = position.pyramid_tier ?? 'ladder';
  const [row] = await sql`
    INSERT INTO orb_positions (
      ticker, direction, strike, expiration, entry_premium, quantity, order_id, broker,
      opened_at, status, opening_range_high, opening_range_low, breakout_level,
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
      ${position.opening_range_high},
      ${position.opening_range_low},
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

export async function updateOrbPositionExcursion(id, mfePct, maePct) {
  await ensureOrbSchema();
  const sql = getSql();
  await sql`
    UPDATE orb_positions
    SET mfe_pct = ${mfePct}, mae_pct = ${maePct}
    WHERE id = ${id}
  `;
}

export async function updateOrbPositionPyramidState(id, state) {
  await ensureOrbSchema();
  const sql = getSql();
  await sql`
    UPDATE orb_positions
    SET
      exit_phase = COALESCE(${state.exit_phase ?? null}, exit_phase),
      contracts_open = COALESCE(${state.contracts_open ?? null}, contracts_open),
      quantity = COALESCE(${state.quantity ?? null}, quantity),
      trail_peak_pnl_frac = COALESCE(${state.trail_peak_pnl_frac ?? null}, trail_peak_pnl_frac)
    WHERE id = ${id}
  `;
}

export async function updateOrbPositionBrokerStop(id, state) {
  await ensureOrbSchema();
  const sql = getSql();
  await sql`
    UPDATE orb_positions
    SET
      broker_stop_order_id = ${state.broker_stop_order_id ?? null},
      broker_stop_trigger_price = ${state.broker_stop_trigger_price ?? null},
      broker_stop_pnl_frac = ${state.broker_stop_pnl_frac ?? null}
    WHERE id = ${id}
  `;
}

export async function updateOrbPositionPendingClose(id, state) {
  await ensureOrbSchema();
  const sql = getSql();
  await sql`
    UPDATE orb_positions
    SET
      pending_close_order_id = ${state.pending_close_order_id ?? null},
      pending_close_reason = ${state.pending_close_reason ?? null},
      pending_close_submitted_at = ${state.pending_close_submitted_at ?? null}
    WHERE id = ${id}
  `;
}

async function insertOrbTradeLogLeg(tx, position, exitPremium, pnlPct, reason, legQty) {
  const realizedPnl = computeRealizedPnlDollars({
    entryPremium: position.entry_premium,
    exitPremium,
    quantity: legQty,
    closeReason: reason,
  });

  const environment = await readStrategyEnvironmentForLog('orb', tx);
  await tx`
    INSERT INTO orb_trade_log (
      ticker, direction, strike, expiration, entry_premium, exit_premium, quantity,
      pnl_pct, realized_pnl, opening_range_high, opening_range_low, breakout_level,
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
      ${position.opening_range_high},
      ${position.opening_range_low},
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

export async function partialCloseOrbPosition(id, exitPremium, pnlPct, reason, closeQty, stateUpdate) {
  await ensureOrbSchema();
  const sql = getSql();
  const posRows = await sql`SELECT * FROM orb_positions WHERE id = ${id}`;
  const position = rowToObject(posRows[0]);
  if (!position) return null;

  const exitFrac = Number(pnlPct) / 100;
  const mfePct = Math.max(Number(position.mfe_pct) || 0, exitFrac);
  const maePct = Math.min(Number(position.mae_pct) || 0, exitFrac);

  await sql.begin(async (tx) => {
    await insertOrbTradeLogLeg(tx, position, exitPremium, pnlPct, reason, closeQty);
    await tx`
      UPDATE orb_positions
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
export function orbCloseUpdateClaimed(updated) {
  const count = Number(updated?.count);
  if (Number.isFinite(count)) return count > 0;
  return Array.isArray(updated) && updated.length > 0;
}

export async function closeOrbPosition(id, exitPremium, pnlPct, reason, closeQty = null) {
  await ensureOrbSchema();
  const sql = getSql();
  const posRows = await sql`SELECT * FROM orb_positions WHERE id = ${id}`;
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
      UPDATE orb_positions
      SET status = 'CLOSED'
      WHERE id = ${id} AND status = 'OPEN'
      RETURNING id
    `;
    if (!orbCloseUpdateClaimed(updated)) return;
    await insertOrbTradeLogLeg(tx, position, exitPremium, pnlPct, reason, legQty);
    claimed = true;
  });

  return claimed ? position : null;
}

export async function logOrbEvent({ ticker, tradeDate, eventType, direction, breakoutLevel, details }) {
  await ensureOrbSchema();
  const sql = getSql();
  await sql`
    INSERT INTO orb_event_log (ticker, trade_date, event_type, direction, breakout_level, details_json, created_at)
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
export async function hasOrbBreakoutExecutedToday({
  ticker,
  direction,
  breakoutLevel,
  tradeDate,
}) {
  await ensureOrbSchema();
  const sql = getSql();
  const level = Number(breakoutLevel);

  const [posRow] = await sql`
    SELECT 1 FROM orb_positions
    WHERE ticker = ${ticker}
      AND direction = ${direction}
      AND breakout_level = ${level}
      AND expiration = ${tradeDate}
      AND status = 'OPEN'
    LIMIT 1
  `;
  return Boolean(posRow);
}

export async function listOrbBreakoutCloseOutcomes({ ticker, tradeDate }) {
  await ensureOrbSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT direction, breakout_level, opened_at, closed_at, realized_pnl
    FROM orb_trade_log
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
