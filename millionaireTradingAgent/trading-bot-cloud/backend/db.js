import postgres from 'postgres';

let client;

function getClient() {
  if (!client) {
    const url = process.env.SUPABASE_DB_URL;
    if (!url) {
      throw new Error('SUPABASE_DB_URL is required');
    }
    client = postgres(url);
  }
  return client;
}

async function initSchema() {
  const sql = getClient();

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
  const sql = getClient();
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
  const sql = getClient();
  await sql`
    UPDATE bot_state
    SET execution_mode = ${mode}, updated_at = NOW()::text
    WHERE id = 1
  `;
}

export async function addMonthlySpend(amount) {
  await ensureSchema();
  const sql = getClient();
  await sql`
    UPDATE bot_state
    SET monthly_spend = monthly_spend + ${amount}, updated_at = NOW()::text
    WHERE id = 1
  `;
}

export async function getOpenPositions() {
  await ensureSchema();
  const sql = getClient();
  const rows = await sql`
    SELECT * FROM positions WHERE status = 'OPEN' ORDER BY opened_at DESC
  `;
  return rows.map(rowToObject);
}

export async function getOpenPositionCount() {
  await ensureSchema();
  const sql = getClient();
  const [row] = await sql`
    SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'
  `;
  return Number(row.count);
}

export async function insertPosition(position) {
  await ensureSchema();
  const sql = getClient();
  const [row] = await sql`
    INSERT INTO positions (ticker, direction, strike, expiration, entry_premium, quantity, order_id, broker, opened_at, status)
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
      'OPEN'
    )
    RETURNING id
  `;
  return row.id;
}

export async function closePosition(id, exitPremium, pnlPct, reason) {
  await ensureSchema();
  const sql = getClient();
  const posRows = await sql`SELECT * FROM positions WHERE id = ${id}`;
  const position = rowToObject(posRows[0]);
  if (!position) return null;

  await sql.begin(async (tx) => {
    await tx`UPDATE positions SET status = 'CLOSED' WHERE id = ${id}`;
    await tx`
      INSERT INTO trade_log (ticker, direction, strike, expiration, entry_premium, exit_premium, pnl_pct, close_reason, opened_at, closed_at)
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
        NOW()::text
      )
    `;
  });

  return position;
}

export async function logSignal({ ticker, signalType, result, direction, confidence, executed }) {
  await ensureSchema();
  const sql = getClient();
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

export async function getLastSignal() {
  await ensureSchema();
  const sql = getClient();
  const rows = await sql`
    SELECT * FROM signal_log ORDER BY id DESC LIMIT 1
  `;
  return rowToObject(rows[0]);
}

export async function getTradeLog(limit = 50) {
  await ensureSchema();
  const sql = getClient();
  const rows = await sql`
    SELECT * FROM trade_log ORDER BY closed_at DESC LIMIT ${limit}
  `;
  return rows.map(rowToObject);
}

export async function saveOAuthToken(broker, accessToken, refreshToken, expiresAt) {
  await ensureSchema();
  const sql = getClient();
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
  const sql = getClient();
  const rows = await sql`SELECT * FROM oauth_tokens WHERE broker = ${broker}`;
  return rowToObject(rows[0]);
}

export async function markSignalExecuted(ticker, signalType) {
  await ensureSchema();
  const sql = getClient();
  await sql`
    UPDATE signal_log SET executed = 1
    WHERE id = (
      SELECT id FROM signal_log
      WHERE ticker = ${ticker} AND signal_type = ${signalType}
      ORDER BY id DESC LIMIT 1
    )
  `;
}
