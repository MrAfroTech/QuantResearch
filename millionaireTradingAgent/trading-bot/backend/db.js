import { createClient } from '@libsql/client';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_DB = `file:${path.join(DATA_DIR, 'trading-bot.db')}`;

let client;

function getClient() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL || LOCAL_DB;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!process.env.TURSO_DATABASE_URL) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    client = createClient({ url, authToken });
  }
  return client;
}

async function initSchema() {
  const db = getClient();
  await db.batch([
    `CREATE TABLE IF NOT EXISTS bot_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      execution_mode TEXT NOT NULL DEFAULT 'AUTO',
      monthly_spend REAL NOT NULL DEFAULT 0,
      budget_month TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      direction TEXT NOT NULL,
      strike REAL NOT NULL,
      expiration TEXT NOT NULL,
      entry_premium REAL NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      order_id TEXT,
      broker TEXT,
      opened_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN'
    )`,
    `CREATE TABLE IF NOT EXISTS trade_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      direction TEXT NOT NULL,
      strike REAL NOT NULL,
      expiration TEXT NOT NULL,
      entry_premium REAL NOT NULL,
      exit_premium REAL,
      pnl_pct REAL,
      close_reason TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS signal_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      result TEXT NOT NULL,
      direction TEXT,
      confidence TEXT,
      executed INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS oauth_tokens (
      broker TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TEXT
    )`,
  ]);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const existing = await db.execute({ sql: 'SELECT id FROM bot_state WHERE id = 1', args: [] });
  if (existing.rows.length === 0) {
    await db.execute({
      sql: `INSERT INTO bot_state (id, execution_mode, monthly_spend, budget_month, updated_at)
            VALUES (1, 'AUTO', 0, ?, datetime('now'))`,
      args: [currentMonth],
    });
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
  const db = getClient();
  const currentMonth = new Date().toISOString().slice(0, 7);
  let result = await db.execute({ sql: 'SELECT * FROM bot_state WHERE id = 1', args: [] });
  let state = rowToObject(result.rows[0]);

  if (state.budget_month !== currentMonth) {
    await db.execute({
      sql: `UPDATE bot_state SET monthly_spend = 0, budget_month = ?, updated_at = datetime('now') WHERE id = 1`,
      args: [currentMonth],
    });
    result = await db.execute({ sql: 'SELECT * FROM bot_state WHERE id = 1', args: [] });
    state = rowToObject(result.rows[0]);
  }

  return state;
}

export async function setExecutionMode(mode) {
  await ensureSchema();
  await getClient().execute({
    sql: `UPDATE bot_state SET execution_mode = ?, updated_at = datetime('now') WHERE id = 1`,
    args: [mode],
  });
}

export async function addMonthlySpend(amount) {
  await ensureSchema();
  await getClient().execute({
    sql: `UPDATE bot_state SET monthly_spend = monthly_spend + ?, updated_at = datetime('now') WHERE id = 1`,
    args: [amount],
  });
}

export async function getOpenPositions() {
  await ensureSchema();
  const result = await getClient().execute({
    sql: `SELECT * FROM positions WHERE status = 'OPEN' ORDER BY opened_at DESC`,
    args: [],
  });
  return result.rows.map(rowToObject);
}

export async function getOpenPositionCount() {
  await ensureSchema();
  const result = await getClient().execute({
    sql: `SELECT COUNT(*) as count FROM positions WHERE status = 'OPEN'`,
    args: [],
  });
  return Number(result.rows[0].count);
}

export async function insertPosition(position) {
  await ensureSchema();
  const result = await getClient().execute({
    sql: `INSERT INTO positions (ticker, direction, strike, expiration, entry_premium, quantity, order_id, broker, opened_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'OPEN')`,
    args: [
      position.ticker, position.direction, position.strike, position.expiration,
      position.entry_premium, position.quantity, position.order_id, position.broker,
    ],
  });
  return result.lastInsertRowid;
}

export async function closePosition(id, exitPremium, pnlPct, reason) {
  await ensureSchema();
  const db = getClient();
  const posResult = await db.execute({ sql: 'SELECT * FROM positions WHERE id = ?', args: [id] });
  const position = rowToObject(posResult.rows[0]);
  if (!position) return null;

  await db.batch([
    { sql: `UPDATE positions SET status = 'CLOSED' WHERE id = ?`, args: [id] },
    {
      sql: `INSERT INTO trade_log (ticker, direction, strike, expiration, entry_premium, exit_premium, pnl_pct, close_reason, opened_at, closed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [
        position.ticker, position.direction, position.strike, position.expiration,
        position.entry_premium, exitPremium, pnlPct, reason, position.opened_at,
      ],
    },
  ]);

  return position;
}

export async function logSignal({ ticker, signalType, result, direction, confidence, executed }) {
  await ensureSchema();
  await getClient().execute({
    sql: `INSERT INTO signal_log (ticker, signal_type, result, direction, confidence, executed, checked_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [ticker, signalType, result, direction || null, confidence || null, executed ? 1 : 0],
  });
}

export async function getLastSignal() {
  await ensureSchema();
  const result = await getClient().execute({
    sql: 'SELECT * FROM signal_log ORDER BY id DESC LIMIT 1',
    args: [],
  });
  return rowToObject(result.rows[0]);
}

export async function getTradeLog(limit = 50) {
  await ensureSchema();
  const result = await getClient().execute({
    sql: 'SELECT * FROM trade_log ORDER BY closed_at DESC LIMIT ?',
    args: [limit],
  });
  return result.rows.map(rowToObject);
}

export async function saveOAuthToken(broker, accessToken, refreshToken, expiresAt) {
  await ensureSchema();
  await getClient().execute({
    sql: `INSERT INTO oauth_tokens (broker, access_token, refresh_token, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(broker) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at`,
    args: [broker, accessToken, refreshToken, expiresAt],
  });
}

export async function getOAuthToken(broker) {
  await ensureSchema();
  const result = await getClient().execute({
    sql: 'SELECT * FROM oauth_tokens WHERE broker = ?',
    args: [broker],
  });
  return rowToObject(result.rows[0]);
}

export async function markSignalExecuted(ticker, signalType) {
  await ensureSchema();
  await getClient().execute({
    sql: `UPDATE signal_log SET executed = 1
          WHERE id = (
            SELECT id FROM signal_log
            WHERE ticker = ? AND signal_type = ?
            ORDER BY id DESC LIMIT 1
          )`,
    args: [ticker, signalType],
  });
}
