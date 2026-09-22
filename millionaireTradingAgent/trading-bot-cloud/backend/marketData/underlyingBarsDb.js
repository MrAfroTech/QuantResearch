import { getSql } from '../sqlClient.js';

const TIMEFRAME_5MIN = '5min';

let schemaReady;

/**
 * Shared 5-minute (and future) underlying OHLCV store.
 * Primary key (ticker, timeframe, bar_time) prevents duplicates.
 */
export async function ensureUnderlyingBarsSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const sql = getSql();
    const existing = await sql`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'underlying_bars'
      LIMIT 1
    `;
    // Table already exists (one-time backfill). Skip DDL — the live DB role
    // can INSERT but is not owner, so CREATE INDEX would fail the upsert.
    if (existing.length > 0) return;
    await sql`
      CREATE TABLE IF NOT EXISTS underlying_bars (
        ticker TEXT NOT NULL,
        bar_time TEXT NOT NULL,
        timeframe TEXT NOT NULL DEFAULT '5min',
        open DOUBLE PRECISION NOT NULL,
        high DOUBLE PRECISION NOT NULL,
        low DOUBLE PRECISION NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        volume DOUBLE PRECISION,
        timestamp_epoch BIGINT,
        source TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (ticker, timeframe, bar_time)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS underlying_bars_ticker_time_idx
      ON underlying_bars (ticker, bar_time)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS underlying_bars_ticker_tf_time_idx
      ON underlying_bars (ticker, timeframe, bar_time)
    `;
  })();
  return schemaReady;
}

function normalizeBarRow(ticker, bar, { timeframe = TIMEFRAME_5MIN, source = null } = {}) {
  const barTime = bar?.time != null ? String(bar.time) : null;
  const open = Number(bar?.open);
  const high = Number(bar?.high);
  const low = Number(bar?.low);
  const close = Number(bar?.close);
  if (!ticker || !barTime) return null;
  if (![open, high, low, close].every(Number.isFinite)) return null;
  const volume = bar?.volume != null && Number.isFinite(Number(bar.volume))
    ? Number(bar.volume)
    : null;
  const ts = Number(bar?.timestamp);
  return {
    ticker: String(ticker).toUpperCase(),
    bar_time: barTime,
    timeframe: String(timeframe || TIMEFRAME_5MIN),
    open,
    high,
    low,
    close,
    volume,
    timestamp_epoch: Number.isFinite(ts) && ts > 0 ? Math.trunc(ts) : null,
    source: source != null ? String(source) : null,
    created_at: new Date().toISOString(),
  };
}

/**
 * Upsert bars. Idempotent on (ticker, timeframe, bar_time).
 * @returns {{ attempted: number, upserted: number }}
 */
export async function upsertUnderlyingBars(ticker, bars, options = {}) {
  await ensureUnderlyingBarsSchema();
  const sql = getSql();
  const rows = (bars || [])
    .map((bar) => normalizeBarRow(ticker, bar, options))
    .filter(Boolean);

  if (rows.length === 0) return { attempted: 0, upserted: 0 };

  let upserted = 0;
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    for (const row of chunk) {
      await sql`
        INSERT INTO underlying_bars (
          ticker, bar_time, timeframe, open, high, low, close,
          volume, timestamp_epoch, source, created_at
        ) VALUES (
          ${row.ticker},
          ${row.bar_time},
          ${row.timeframe},
          ${row.open},
          ${row.high},
          ${row.low},
          ${row.close},
          ${row.volume},
          ${row.timestamp_epoch},
          ${row.source},
          ${row.created_at}
        )
        ON CONFLICT (ticker, timeframe, bar_time) DO UPDATE SET
          open = EXCLUDED.open,
          high = EXCLUDED.high,
          low = EXCLUDED.low,
          close = EXCLUDED.close,
          volume = COALESCE(EXCLUDED.volume, underlying_bars.volume),
          timestamp_epoch = COALESCE(EXCLUDED.timestamp_epoch, underlying_bars.timestamp_epoch),
          source = COALESCE(EXCLUDED.source, underlying_bars.source)
      `;
      upserted += 1;
    }
  }

  return { attempted: rows.length, upserted };
}

/**
 * Query bars for a ticker in [startTime, endTime] inclusive (string compare on bar_time).
 */
export async function getUnderlyingBars({
  ticker,
  startTime,
  endTime,
  timeframe = TIMEFRAME_5MIN,
} = {}) {
  await ensureUnderlyingBarsSchema();
  const sql = getSql();
  const sym = String(ticker || '').toUpperCase();
  if (!sym) return [];

  if (startTime && endTime) {
    return sql`
      SELECT ticker, bar_time, timeframe, open, high, low, close, volume,
             timestamp_epoch, source, created_at
      FROM underlying_bars
      WHERE ticker = ${sym}
        AND timeframe = ${timeframe}
        AND bar_time >= ${String(startTime)}
        AND bar_time <= ${String(endTime)}
      ORDER BY bar_time ASC
    `;
  }

  if (startTime) {
    return sql`
      SELECT ticker, bar_time, timeframe, open, high, low, close, volume,
             timestamp_epoch, source, created_at
      FROM underlying_bars
      WHERE ticker = ${sym}
        AND timeframe = ${timeframe}
        AND bar_time >= ${String(startTime)}
      ORDER BY bar_time ASC
    `;
  }

  return sql`
    SELECT ticker, bar_time, timeframe, open, high, low, close, volume,
           timestamp_epoch, source, created_at
    FROM underlying_bars
    WHERE ticker = ${sym}
      AND timeframe = ${timeframe}
    ORDER BY bar_time ASC
  `;
}

export { TIMEFRAME_5MIN };
