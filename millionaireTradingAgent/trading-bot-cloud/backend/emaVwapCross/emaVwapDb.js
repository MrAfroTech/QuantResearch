import { getSql } from '../sqlClient.js';
import { ladderExitPhase } from '../ladder/ladderConfig.js';
import { computeRealizedPnlDollars } from '../tradePnl.js';

const BOT_SYMBOL = '';
const BOT_DATE = '';

let schemaReady;

function rowToObject(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row));
}

export async function ensureEmaVwapSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();

    await sql`
      CREATE TABLE IF NOT EXISTS emavwap_state (
        symbol TEXT NOT NULL DEFAULT '',
        trade_date TEXT NOT NULL DEFAULT '',
        monthly_spend DOUBLE PRECISION,
        budget_month TEXT,
        execution_mode TEXT DEFAULT 'AUTO',
        fsm_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (symbol, trade_date)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS emavwap_positions (
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
        vwap_at_entry DOUBLE PRECISION,
        ema_at_entry DOUBLE PRECISION,
        cross_direction TEXT,
        cross_candle_json TEXT,
        strike_bucket TEXT,
        entry_iv DOUBLE PRECISION,
        entry_delta DOUBLE PRECISION,
        mfe_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
        mae_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
        entry_metadata_json TEXT
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS emavwap_trade_log (
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
        vwap_at_entry DOUBLE PRECISION,
        ema_at_entry DOUBLE PRECISION,
        cross_direction TEXT,
        cross_candle_json TEXT,
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

    await sql`ALTER TABLE emavwap_positions ADD COLUMN IF NOT EXISTS exit_phase TEXT DEFAULT 'INITIAL'`;
    await sql`ALTER TABLE emavwap_positions ADD COLUMN IF NOT EXISTS contracts_open INTEGER`;
    await sql`ALTER TABLE emavwap_positions ADD COLUMN IF NOT EXISTS trail_peak_pnl_frac DOUBLE PRECISION NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE emavwap_positions ADD COLUMN IF NOT EXISTS entry_contracts INTEGER`;
    await sql`ALTER TABLE emavwap_positions ADD COLUMN IF NOT EXISTS pyramid_tier TEXT`;
    await sql`ALTER TABLE emavwap_trade_log ADD COLUMN IF NOT EXISTS entry_contracts INTEGER`;
    await sql`ALTER TABLE emavwap_trade_log ADD COLUMN IF NOT EXISTS pyramid_tier TEXT`;
    await sql`ALTER TABLE emavwap_positions ADD COLUMN IF NOT EXISTS broker_stop_order_id TEXT`;
    await sql`ALTER TABLE emavwap_positions ADD COLUMN IF NOT EXISTS broker_stop_trigger_price DOUBLE PRECISION`;
    await sql`ALTER TABLE emavwap_positions ADD COLUMN IF NOT EXISTS broker_stop_pnl_frac DOUBLE PRECISION`;

    const month = new Date().toISOString().slice(0, 7);
    const existing = await sql`
      SELECT symbol FROM emavwap_state WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
    `;
    if (existing.length === 0) {
      await sql`
        INSERT INTO emavwap_state (symbol, trade_date, monthly_spend, budget_month, execution_mode, updated_at)
        VALUES (${BOT_SYMBOL}, ${BOT_DATE}, 0, ${month}, 'AUTO', NOW()::text)
      `;
    }
  })();
  return schemaReady;
}

export async function getEmaVwapBotState() {
  await ensureEmaVwapSchema();
  const sql = getSql();
  const currentMonth = new Date().toISOString().slice(0, 7);
  let rows = await sql`
    SELECT * FROM emavwap_state WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
  `;
  let state = rowToObject(rows[0]);

  if (state.budget_month !== currentMonth) {
    await sql`
      UPDATE emavwap_state
      SET monthly_spend = 0, budget_month = ${currentMonth}, updated_at = NOW()::text
      WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
    `;
    rows = await sql`
      SELECT * FROM emavwap_state WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
    `;
    state = rowToObject(rows[0]);
  }
  return state;
}

export async function getEmaVwapMode() {
  const state = await getEmaVwapBotState();
  return state.execution_mode || 'AUTO';
}

export async function setEmaVwapMode(mode) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  await sql`
    UPDATE emavwap_state
    SET execution_mode = ${mode}, updated_at = NOW()::text
    WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
  `;
}

export async function addEmaVwapMonthlySpend(amount) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  await sql`
    UPDATE emavwap_state
    SET monthly_spend = COALESCE(monthly_spend, 0) + ${amount}, updated_at = NOW()::text
    WHERE symbol = ${BOT_SYMBOL} AND trade_date = ${BOT_DATE}
  `;
}

export async function getEmaVwapBudgetRemaining() {
  const { getEmaVwapBudgetRemaining: remaining } = await import('../budget/budgetAllocations.js');
  return remaining();
}

export async function getEmaVwapOpenPositions() {
  await ensureEmaVwapSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM emavwap_positions WHERE status = 'OPEN' ORDER BY opened_at DESC
  `;
  return rows.map(rowToObject);
}

export async function getEmaVwapOpenPositionCount() {
  await ensureEmaVwapSchema();
  const sql = getSql();
  const [row] = await sql`
    SELECT COUNT(*)::int AS count FROM emavwap_positions WHERE status = 'OPEN'
  `;
  return Number(row.count);
}

export async function getEmaVwapSymbolState(symbol, tradeDate) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM emavwap_state WHERE symbol = ${symbol} AND trade_date = ${tradeDate}
  `;
  return rowToObject(rows[0]);
}

export async function upsertEmaVwapSymbolState({ symbol, tradeDate, fsmJson }) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  const fsm = typeof fsmJson === 'string' ? fsmJson : JSON.stringify(fsmJson ?? {});
  await sql`
    INSERT INTO emavwap_state (symbol, trade_date, fsm_json, updated_at)
    VALUES (${symbol}, ${tradeDate}, ${fsm}, NOW()::text)
    ON CONFLICT (symbol, trade_date) DO UPDATE SET
      fsm_json = EXCLUDED.fsm_json,
      updated_at = NOW()::text
  `;
}

export async function insertEmaVwapPosition(position) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  const entryContracts = position.entry_contracts ?? position.quantity;
  const pyramidTier = position.pyramid_tier ?? 'ladder';
  const [row] = await sql`
    INSERT INTO emavwap_positions (
      ticker, direction, strike, expiration, entry_premium, quantity, order_id, broker,
      opened_at, status, vwap_at_entry, ema_at_entry, cross_direction, cross_candle_json,
      strike_bucket, entry_iv, entry_delta, mfe_pct, mae_pct, entry_metadata_json,
      exit_phase, contracts_open, trail_peak_pnl_frac, entry_contracts, pyramid_tier
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
      ${position.vwap_at_entry},
      ${position.ema_at_entry},
      ${position.cross_direction},
      ${position.cross_candle_json},
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

export async function updateEmaVwapPositionExcursion(id, mfePct, maePct) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  await sql`
    UPDATE emavwap_positions
    SET mfe_pct = ${mfePct}, mae_pct = ${maePct}
    WHERE id = ${id}
  `;
}

export async function updateEmaVwapPositionPyramidState(id, state) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  await sql`
    UPDATE emavwap_positions
    SET
      exit_phase = COALESCE(${state.exit_phase ?? null}, exit_phase),
      contracts_open = COALESCE(${state.contracts_open ?? null}, contracts_open),
      quantity = COALESCE(${state.quantity ?? null}, quantity),
      trail_peak_pnl_frac = COALESCE(${state.trail_peak_pnl_frac ?? null}, trail_peak_pnl_frac)
    WHERE id = ${id}
  `;
}

export async function updateEmaVwapPositionBrokerStop(id, state) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  await sql`
    UPDATE emavwap_positions
    SET
      broker_stop_order_id = ${state.broker_stop_order_id ?? null},
      broker_stop_trigger_price = ${state.broker_stop_trigger_price ?? null},
      broker_stop_pnl_frac = ${state.broker_stop_pnl_frac ?? null}
    WHERE id = ${id}
  `;
}

async function insertEmaVwapTradeLogLeg(tx, position, exitPremium, pnlPct, reason, legQty) {
  const realizedPnl = computeRealizedPnlDollars({
    entryPremium: position.entry_premium,
    exitPremium,
    quantity: legQty,
    closeReason: reason,
  });

  await tx`
    INSERT INTO emavwap_trade_log (
      ticker, direction, strike, expiration, entry_premium, exit_premium, quantity,
      pnl_pct, realized_pnl, vwap_at_entry, ema_at_entry, cross_direction,
      cross_candle_json, strike_bucket, entry_iv, entry_delta,
      mfe_pct, mae_pct, close_reason, opened_at, closed_at, entry_contracts, pyramid_tier
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
      ${position.vwap_at_entry},
      ${position.ema_at_entry},
      ${position.cross_direction},
      ${position.cross_candle_json},
      ${position.strike_bucket},
      ${position.entry_iv},
      ${position.entry_delta},
      ${position.mfe_pct},
      ${position.mae_pct},
      ${reason},
      ${position.opened_at},
      NOW()::text,
      ${position.entry_contracts ?? position.quantity},
      ${position.pyramid_tier ?? null}
    )
  `;
}

export async function partialCloseEmaVwapPosition(id, exitPremium, pnlPct, reason, closeQty, stateUpdate) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  const posRows = await sql`SELECT * FROM emavwap_positions WHERE id = ${id}`;
  const position = rowToObject(posRows[0]);
  if (!position) return null;

  const exitFrac = Number(pnlPct) / 100;
  const mfePct = Math.max(Number(position.mfe_pct) || 0, exitFrac);
  const maePct = Math.min(Number(position.mae_pct) || 0, exitFrac);

  await sql.begin(async (tx) => {
    await insertEmaVwapTradeLogLeg(tx, position, exitPremium, pnlPct, reason, closeQty);
    await tx`
      UPDATE emavwap_positions
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

export async function closeEmaVwapPosition(id, exitPremium, pnlPct, reason, closeQty = null) {
  await ensureEmaVwapSchema();
  const sql = getSql();
  const posRows = await sql`SELECT * FROM emavwap_positions WHERE id = ${id}`;
  const position = rowToObject(posRows[0]);
  if (!position) return null;

  const legQty = closeQty ?? position.quantity;
  const exitFrac = Number(pnlPct) / 100;
  const mfePct = Math.max(Number(position.mfe_pct) || 0, exitFrac);
  const maePct = Math.min(Number(position.mae_pct) || 0, exitFrac);
  position.mfe_pct = mfePct;
  position.mae_pct = maePct;

  await sql.begin(async (tx) => {
    await tx`UPDATE emavwap_positions SET status = 'CLOSED' WHERE id = ${id}`;
    await insertEmaVwapTradeLogLeg(tx, position, exitPremium, pnlPct, reason, legQty);
  });

  return position;
}

/** True if any position or trade log row exists for this cross-bar key today. */
export async function hasEmaVwapCrossExecutedToday({
  ticker,
  direction,
  crossBarTime,
  tradeDate,
}) {
  await ensureEmaVwapSchema();
  const sql = getSql();

  const [posRow] = await sql`
    SELECT 1 FROM emavwap_positions
    WHERE ticker = ${ticker}
      AND direction = ${direction}
      AND expiration = ${tradeDate}
      AND cross_candle_json IS NOT NULL
      AND cross_candle_json::json->>'time' = ${crossBarTime}
    LIMIT 1
  `;
  if (posRow) return true;

  const [logRow] = await sql`
    SELECT 1 FROM emavwap_trade_log
    WHERE ticker = ${ticker}
      AND direction = ${direction}
      AND expiration = ${tradeDate}
      AND cross_candle_json IS NOT NULL
      AND cross_candle_json::json->>'time' = ${crossBarTime}
    LIMIT 1
  `;
  return Boolean(logRow);
}
