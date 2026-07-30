import { getSql } from '../sqlClient.js';
import { closePosition } from '../db.js';
import { closeOrbPosition } from '../orb/orbDb.js';
import { closePremarketPosition } from '../premarketBreakout/premarketDb.js';
import { closeEmaVwapPosition } from '../emaVwapCross/emaVwapDb.js';
import { etDateKey } from '../orb/tradierTimesales.js';

const SANDBOX_URL = 'https://sandbox.tradier.com/v1';
const PRODUCTION_URL = 'https://api.tradier.com/v1';

function getBaseUrl() {
  return process.env.TRADIER_SANDBOX !== 'false' ? SANDBOX_URL : PRODUCTION_URL;
}

function getToken() {
  const token = process.env.TRADIER_API_TOKEN;
  if (!token) throw new Error('TRADIER_API_TOKEN is required');
  return token;
}

async function fetchUnderlyingClose(ticker, tradeDate) {
  const url = `${getBaseUrl()}/markets/history?symbol=${ticker}&interval=daily&start=${tradeDate}&end=${tradeDate}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const json = await res.json();
  const day = json?.history?.day;
  const row = Array.isArray(day) ? day[0] : day;
  const close = row?.close != null ? Number(row.close) : null;
  return Number.isFinite(close) ? close : null;
}

function intrinsicAtExpiry(direction, strike, spot) {
  if (!Number.isFinite(spot) || !Number.isFinite(strike)) return 0;
  if (direction === 'CALL') return Math.max(0, spot - strike);
  return Math.max(0, strike - spot);
}

function resolveExpiration(position, spot) {
  const intrinsic = intrinsicAtExpiry(position.direction, Number(position.strike), spot);
  const entry = Number(position.entry_premium);
  const exitPremium = intrinsic;
  const pnlPct = entry > 0 ? ((exitPremium - entry) / entry) * 100 : -100;
  const itm = intrinsic > 0;
  return {
    exitPremium,
    pnlPct,
    closeReason: itm ? 'expired_itm' : 'expired_worthless',
    spot,
    intrinsic,
    itm,
  };
}

async function queryExpiredOpen(sql, table) {
  const today = etDateKey();
  const rows = await sql.unsafe(`
    SELECT * FROM ${table}
    WHERE status = 'OPEN'
      AND expiration IS NOT NULL
      AND LEFT(expiration::text, 10) < '${today}'
    ORDER BY expiration, id
  `);
  return rows;
}

export async function runExpiredPositionSweep() {
  const sql = getSql();
  const today = etDateKey();
  const found = [];

  const sources = [
    { strategy: 'swing', table: 'positions', close: closePosition },
    { strategy: 'orb', table: 'orb_positions', close: closeOrbPosition },
    { strategy: 'premarket', table: 'premarket_positions', close: closePremarketPosition },
    { strategy: 'emavwap', table: 'emavwap_positions', close: closeEmaVwapPosition },
  ];

  const spotCache = new Map();

  for (const { strategy, table, close } of sources) {
    const positions = await queryExpiredOpen(sql, table);
    for (const position of positions) {
      const expDate = String(position.expiration).slice(0, 10);
      const cacheKey = `${position.ticker}:${expDate}`;
      let spot = spotCache.get(cacheKey);
      if (spot === undefined) {
        spot = await fetchUnderlyingClose(position.ticker, expDate);
        spotCache.set(cacheKey, spot);
      }

      const resolution = resolveExpiration(position, spot);
      await close(
        position.id,
        resolution.exitPremium,
        resolution.pnlPct,
        resolution.closeReason
      );

      found.push({
        strategy,
        id: position.id,
        ticker: position.ticker,
        direction: position.direction,
        strike: position.strike,
        expiration: expDate,
        entry_premium: position.entry_premium,
        quantity: position.quantity ?? 1,
        underlying_close: spot,
        intrinsic: resolution.intrinsic,
        exit_premium: resolution.exitPremium,
        pnl_pct: resolution.pnlPct,
        close_reason: resolution.closeReason,
        itm: resolution.itm,
      });
    }
  }

  await sql.end();

  console.log(`[ExpiredSweep] ${today}: resolved ${found.length} expired OPEN position(s)`);
  for (const row of found) {
    console.log(
      `[ExpiredSweep] ${row.strategy} #${row.id} ${row.ticker} ${row.direction} $${row.strike} exp=${row.expiration} spot=${row.underlying_close} → ${row.close_reason} exit=$${row.exit_premium} pnl=${row.pnl_pct.toFixed(1)}%`
    );
  }

  return { sweep_date: today, resolved: found };
}
