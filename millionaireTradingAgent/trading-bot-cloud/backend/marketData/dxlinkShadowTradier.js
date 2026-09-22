/**
 * Shadow-only Tradier lookup. Does not write underlying_bars and does not
 * wait for the 9:30 premarket persist job.
 */
import { etDateKey } from '../orb/tradierTimesales.js';
import { barTimeKey, shadowBarLookupKey, tradierOhlcFromRow } from './dxlinkShadowPrices.js';

export const DXLINK_SHADOW_TRADIER_CACHE_MS = 60_000;

const cache = {
  date: null,
  fetchedAt: 0,
  byKey: new Map(),
};

export function resetShadowTradierCache() {
  cache.date = null;
  cache.fetchedAt = 0;
  cache.byKey = new Map();
}

async function fetchExtendedTimesales(symbol, tradeDate) {
  const token = process.env.TRADIER_API_TOKEN;
  if (!token) return [];
  const url = new URL('https://api.tradier.com/v1/markets/timesales');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', '5min');
  url.searchParams.set('start', `${tradeDate} 04:00`);
  url.searchParams.set('end', `${tradeDate} 16:00`);
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Tradier timesales failed for ${symbol}: ${res.status}`);
  }
  const json = await res.json();
  const data = json?.series?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

function putBars(ticker, bars) {
  const sym = String(ticker || '').toUpperCase();
  for (const bar of bars || []) {
    const ohlc = tradierOhlcFromRow(bar);
    const time = barTimeKey(bar?.time);
    if (!ohlc || !time) continue;
    cache.byKey.set(shadowBarLookupKey(sym, time), ohlc);
  }
}

export async function refreshShadowTradierTimesales(
  symbols,
  tradeDate = etDateKey(),
  { fetchBars = fetchExtendedTimesales, nowMs = Date.now(), force = false } = {}
) {
  const date = String(tradeDate);
  const fresh =
    !force &&
    cache.date === date &&
    nowMs - cache.fetchedAt < DXLINK_SHADOW_TRADIER_CACHE_MS &&
    cache.byKey.size > 0;
  if (fresh) return cache.byKey;

  if (cache.date !== date) cache.byKey = new Map();
  cache.date = date;
  cache.fetchedAt = nowMs;

  for (const ticker of symbols) {
    try {
      const bars = await fetchBars(ticker, date);
      putBars(ticker, bars);
    } catch (err) {
      console.warn(`[DXLinkShadow] Tradier timesales failed ${ticker}:`, err.message);
    }
  }
  return cache.byKey;
}

export function lookupShadowTradierClose(ticker, barTime) {
  return cache.byKey.get(shadowBarLookupKey(ticker, barTime)) || null;
}

export async function resolveShadowTradierBar(
  ticker,
  barTime,
  { getLocalBar, symbols, tradeDate, fetchBars, nowMs } = {}
) {
  if (typeof getLocalBar === 'function') {
    const local = tradierOhlcFromRow(await getLocalBar(ticker, barTime));
    if (local) return { ...local, source: 'underlying_bars' };
  }
  await refreshShadowTradierTimesales(symbols || [ticker], tradeDate, { fetchBars, nowMs });
  const live = lookupShadowTradierClose(ticker, barTime);
  return live ? { ...live, source: 'tradier_timesales' } : null;
}
