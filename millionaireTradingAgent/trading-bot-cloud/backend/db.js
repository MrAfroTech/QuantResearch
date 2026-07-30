import { getSql } from './sqlClient.js';
import { PYRAMID_EXIT_PHASE, PYRAMID_TIER } from './pyramid/pyramidConfig.js';

async function initSchema() {
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS bot_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      execution_mode TEXT NOT NULL DEFAULT 'AUTO',
      monthly_spend DOUBLE PRECISION NOT NULL DEFAULT 0,
      budget_month TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS positions (
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
      status TEXT NOT NULL DEFAULT 'OPEN'
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS trade_log (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ticker TEXT NOT NULL,
      direction TEXT NOT NULL,
      strike DOUBLE PRECISION NOT NULL,
      expiration TEXT NOT NULL,
      entry_premium DOUBLE PRECISION NOT NULL,
      exit_premium DOUBLE PRECISION,
      pnl_pct DOUBLE PRECISION,
      close_reason TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS signal_log (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ticker TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      result TEXT NOT NULL,
      direction TEXT,
      confidence TEXT,
      executed INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      broker TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS alert_log (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      alert_type TEXT NOT NULL,
      message TEXT NOT NULL,
      success INTEGER NOT NULL,
      error TEXT,
      sent_at TEXT NOT NULL
    )
  `;

  await sql`ALTER TABLE positions ADD COLUMN IF NOT EXISTS signal_type TEXT`;
  await sql`ALTER TABLE positions ADD COLUMN IF NOT EXISTS breakout_level DOUBLE PRECISION`;
  await sql`ALTER TABLE positions ADD COLUMN IF NOT EXISTS mfe_pct DOUBLE PRECISION NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE positions ADD COLUMN IF NOT EXISTS mae_pct DOUBLE PRECISION NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS signal_type TEXT`;
  await sql`ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS breakout_level DOUBLE PRECISION`;
  await sql`ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS mfe_pct DOUBLE PRECISION`;
  await sql`ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS mae_pct DOUBLE PRECISION`;
  await sql`ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS quantity INTEGER`;
  await sql`ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_phase TEXT DEFAULT 'INITIAL'`;
  await sql`ALTER TABLE positions ADD COLUMN IF NOT EXISTS contracts_open INTEGER`;
  await sql`ALTER TABLE positions ADD COLUMN IF NOT EXISTS trail_peak_pnl_frac DOUBLE PRECISION NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_contracts INTEGER`;
  await sql`ALTER TABLE positions ADD COLUMN IF NOT EXISTS pyramid_tier TEXT`;
  await sql`ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS entry_contracts INTEGER`;
  await sql`ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS pyramid_tier TEXT`;

  const currentMonth = new Date().toISOString().slice(0, 7);
  const existing = await sql`SELECT id FROM bot_state WHERE id = 1`;
  if (existing.length === 0) {
    await sql`
      INSERT INTO bot_state (id, execution_mode, monthly_spend, budget_month, updated_at)
      VALUES (1, 'AUTO', 0, ${currentMonth}, NOW()::text)
    `;
  }
}

let schemaReady;
function ensureSchema() {
  if (!schemaReady) schemaReady = initSchema();
  return schemaReady;
}

function rowToObject(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row));
}

export async function getBotState() {
  await ensureSchema();
  const sql = getSql();
  const currentMonth = new Date().toISOString().slice(0, 7);
  let rows = await sql`SELECT * FROM bot_state WHERE id = 1`;
  let state = rowToObject(rows[0]);

  if (state.budget_month !== currentMonth) {
    await sql`
      UPDATE bot_state
      SET monthly_spend = 0, budget_month = ${currentMonth}, updated_at = NOW()::text
      WHERE id = 1
    `;
    rows = await sql`SELECT * FROM bot_state WHERE id = 1`;
    state = rowToObject(rows[0]);
  }

  return state;
}

export async function setExecutionMode(mode) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE bot_state
    SET execution_mode = ${mode}, updated_at = NOW()::text
    WHERE id = 1
  `;
}

export async function addMonthlySpend(amount) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE bot_state
    SET monthly_spend = monthly_spend + ${amount}, updated_at = NOW()::text
    WHERE id = 1
  `;
}

export async function getOpenPositions() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM positions WHERE status = 'OPEN' ORDER BY opened_at DESC
  `;
  return rows.map(rowToObject);
}

export async function getOpenPositionCount() {
  await ensureSchema();
  const sql = getSql();
  const [row] = await sql`
    SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'
  `;
  return Number(row.count);
}

export async function insertPosition(position) {
  await ensureSchema();
  const sql = getSql();
  const entryContracts = position.entry_contracts ?? position.quantity;
  const pyramidTier = position.pyramid_tier ?? null;
  const isLegacy = pyramidTier === PYRAMID_TIER.LEGACY;
  const [row] = await sql`
    INSERT INTO positions (ticker, direction, strike, expiration, entry_premium, quantity, order_id, broker, opened_at, status, signal_type, breakout_level, exit_phase, contracts_open, trail_peak_pnl_frac, entry_contracts, pyramid_tier)
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
      ${position.signal_type || null},
      ${position.breakout_level ?? null},
      ${isLegacy ? 'LEGACY' : PYRAMID_EXIT_PHASE.INITIAL},
      ${position.quantity},
      0,
      ${entryContracts},
      ${pyramidTier}
    )
    RETURNING id
  `;
  return row.id;
}

export async function updatePositionExcursion(id, mfePct, maePct) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE positions
    SET mfe_pct = ${mfePct}, mae_pct = ${maePct}
    WHERE id = ${id}
  `;
}

export async function updatePositionPyramidState(id, state) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE positions
    SET
      exit_phase = COALESCE(${state.exit_phase ?? null}, exit_phase),
      contracts_open = COALESCE(${state.contracts_open ?? null}, contracts_open),
      quantity = COALESCE(${state.quantity ?? null}, quantity),
      trail_peak_pnl_frac = COALESCE(${state.trail_peak_pnl_frac ?? null}, trail_peak_pnl_frac)
    WHERE id = ${id}
  `;
}

async function insertSwingTradeLogLeg(tx, position, exitPremium, pnlPct, reason, legQty, mfePct, maePct) {
  await tx`
    INSERT INTO trade_log (ticker, direction, strike, expiration, entry_premium, exit_premium, pnl_pct, close_reason, opened_at, closed_at, signal_type, breakout_level, mfe_pct, mae_pct, quantity, entry_contracts, pyramid_tier)
    VALUES (
      ${position.ticker},
      ${position.direction},
      ${position.strike},
      ${position.expiration},
      ${position.entry_premium},
      ${exitPremium},
      ${pnlPct},
      ${reason},
      ${position.opened_at},
      NOW()::text,
      ${position.signal_type || null},
      ${position.breakout_level ?? null},
      ${mfePct},
      ${maePct},
      ${legQty},
      ${position.entry_contracts ?? position.quantity},
      ${position.pyramid_tier ?? null}
    )
  `;
}

export async function partialClosePosition(id, exitPremium, pnlPct, reason, closeQty, stateUpdate) {
  await ensureSchema();
  const sql = getSql();
  const posRows = await sql`SELECT * FROM positions WHERE id = ${id}`;
  const position = rowToObject(posRows[0]);
  if (!position) return null;

  const exitFrac = Number(pnlPct) / 100;
  const mfePct = Math.max(Number(position.mfe_pct) || 0, exitFrac);
  const maePct = Math.min(Number(position.mae_pct) || 0, exitFrac);

  await sql.begin(async (tx) => {
    await insertSwingTradeLogLeg(tx, position, exitPremium, pnlPct, reason, closeQty, mfePct, maePct);
    await tx`
      UPDATE positions
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

export async function closePosition(id, exitPremium, pnlPct, reason, closeQty = null) {
  await ensureSchema();
  const sql = getSql();
  const posRows = await sql`SELECT * FROM positions WHERE id = ${id}`;
  const position = rowToObject(posRows[0]);
  if (!position) return null;

  const legQty = closeQty ?? position.quantity;
  const exitFrac = Number(pnlPct) / 100;
  const mfePct = Math.max(Number(position.mfe_pct) || 0, exitFrac);
  const maePct = Math.min(Number(position.mae_pct) || 0, exitFrac);

  await sql.begin(async (tx) => {
    await tx`UPDATE positions SET status = 'CLOSED' WHERE id = ${id}`;
    await insertSwingTradeLogLeg(tx, position, exitPremium, pnlPct, reason, legQty, mfePct, maePct);
  });

  return position;
}

export async function logSignal({ ticker, signalType, result, direction, confidence, executed }) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    INSERT INTO signal_log (ticker, signal_type, result, direction, confidence, executed, checked_at)
    VALUES (
      ${ticker},
      ${signalType},
      ${result},
      ${direction || null},
      ${confidence || null},
      ${executed ? 1 : 0},
      NOW()::text
    )
  `;
}

export async function logAlert({ alertType, message, success, error }) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    INSERT INTO alert_log (alert_type, message, success, error, sent_at)
    VALUES (
      ${alertType},
      ${message},
      ${success ? 1 : 0},
      ${error || null},
      NOW()::text
    )
  `;
}

export async function getLastSignal() {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM signal_log ORDER BY id DESC LIMIT 1
  `;
  return rowToObject(rows[0]);
}

export async function getTradeLog(limit = 50) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM trade_log ORDER BY closed_at DESC LIMIT ${limit}
  `;
  return rows.map(rowToObject);
}

export async function saveOAuthToken(broker, accessToken, refreshToken, expiresAt) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    INSERT INTO oauth_tokens (broker, access_token, refresh_token, expires_at)
    VALUES (${broker}, ${accessToken}, ${refreshToken}, ${expiresAt})
    ON CONFLICT(broker) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at
  `;
}

export async function getOAuthToken(broker) {
  await ensureSchema();
  const sql = getSql();
  const rows = await sql`SELECT * FROM oauth_tokens WHERE broker = ${broker}`;
  return rowToObject(rows[0]);
}

export async function markSignalExecuted(ticker, signalType) {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE signal_log SET executed = 1
    WHERE id = (
      SELECT id FROM signal_log
      WHERE ticker = ${ticker} AND signal_type = ${signalType}
      ORDER BY id DESC LIMIT 1
    )
  `;
}

/** True if swing already has a matching open/idempotent entry that should not be duplicated. */
export async function hasSwingEntryExecutedToday({
  ticker,
  direction,
  signalType,
  tradeDate,
  breakoutLevel = null,
}) {
  await ensureSchema();
  const sql = getSql();

  // PUT (tv_trend): only block while an OPEN position exists for ticker+direction.
  // Same-day closed entries are allowed again after the stop-loss cooldown gate
  // (see entryCooldown.js) — not a blanket one-per-day ban.
  if (signalType === 'tv_trend') {
    const [posRow] = await sql`
      SELECT 1 FROM positions
      WHERE ticker = ${ticker}
        AND direction = ${direction}
        AND status = 'OPEN'
        AND (signal_type = 'tv_trend' OR signal_type IS NULL)
      LIMIT 1
    `;
    return Boolean(posRow);
  }

  if (signalType === 'tv_breakout' && breakoutLevel != null) {
    const level = Number(breakoutLevel);
    const [posRow] = await sql`
      SELECT 1 FROM positions
      WHERE ticker = ${ticker}
        AND direction = ${direction}
        AND signal_type = 'tv_breakout'
        AND breakout_level = ${level}
        AND LEFT(opened_at::text, 10) = ${tradeDate}
      LIMIT 1
    `;
    if (posRow) return true;

    const [logRow] = await sql`
      SELECT 1 FROM trade_log
      WHERE ticker = ${ticker}
        AND direction = ${direction}
        AND signal_type = 'tv_breakout'
        AND breakout_level = ${level}
        AND LEFT(opened_at::text, 10) = ${tradeDate}
      LIMIT 1
    `;
    return Boolean(logRow);
  }

  return false;
}
