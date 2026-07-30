import {
  getPremarketRangeRow,
  upsertPremarketRangeState,
} from './premarketDb.js';
import {
  etDateKey,
  barEtMinutes,
  minutesSinceMidnightEt,
  isWeekdayEt,
} from '../orb/tradierTimesales.js';

const SANDBOX_URL = 'https://sandbox.tradier.com/v1';
const PRODUCTION_URL = 'https://api.tradier.com/v1';

const DEFAULT_FSM = {
  phase: 'idle',
  direction: null,
  breakout_level: null,
  breakout_candle: null,
  breakout_bar_time: null,
};

function getBaseUrl() {
  return process.env.TRADIER_SANDBOX !== 'false' ? SANDBOX_URL : PRODUCTION_URL;
}

function getToken() {
  const token = process.env.TRADIER_API_TOKEN;
  if (!token) throw new Error('TRADIER_API_TOKEN is required');
  return token;
}

function normalizeTimesalesBar(raw) {
  if (!raw) return null;
  return {
    time: raw.time,
    timestamp: raw.timestamp,
    open: Number(raw.open),
    high: Number(raw.high),
    low: Number(raw.low),
    close: Number(raw.close),
    volume: Number(raw.volume),
  };
}

/** Fetch 5-min bars from 4:00am through 4:00pm ET (premarket + regular session). */
export async function getExtendedFiveMinuteBars(symbol, tradeDate = etDateKey()) {
  const url = new URL(`${getBaseUrl()}/markets/timesales`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', '5min');
  url.searchParams.set('start', `${tradeDate} 04:00`);
  url.searchParams.set('end', `${tradeDate} 16:00`);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Tradier timesales failed for ${symbol}: ${res.status} ${errText}`);
  }

  const json = await res.json();
  const data = json?.series?.data;
  if (!data) return [];
  const list = Array.isArray(data) ? data : [data];
  return list.map(normalizeTimesalesBar).filter((b) => b && Number.isFinite(b.close));
}

export function isPremarketBar(bar) {
  const mins = barEtMinutes(bar);
  if (mins == null) return false;
  return mins >= 4 * 60 && mins < 9 * 60 + 30;
}

export function isPostOpenBar(bar) {
  const mins = barEtMinutes(bar);
  if (mins == null) return false;
  return mins >= 9 * 60 + 30;
}

export function isWithinPremarketSession(date = new Date()) {
  if (!isWeekdayEt(date)) return false;
  const mins = minutesSinceMidnightEt(date);
  const start = 9 * 60 + 30;
  const end = 15 * 60 + 5;
  return mins >= start && mins < end;
}

export function isAtOrAfterTimeStop(date = new Date()) {
  const mins = minutesSinceMidnightEt(date);
  return mins >= 15 * 60 + 5;
}

export function isAfterMarketOpen(date = new Date()) {
  const mins = minutesSinceMidnightEt(date);
  return mins >= 9 * 60 + 30;
}

function parseFsm(raw) {
  if (!raw) return { ...DEFAULT_FSM };
  try {
    return { ...DEFAULT_FSM, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_FSM };
  }
}

function computePremarketRange(bars) {
  const rangeBars = bars.filter(isPremarketBar);
  if (rangeBars.length === 0) return null;

  const highs = rangeBars.map((b) => b.high).filter(Number.isFinite);
  const lows = rangeBars.map((b) => b.low).filter(Number.isFinite);
  if (!highs.length || !lows.length) return null;

  return {
    pmHigh: Math.max(...highs),
    pmLow: Math.min(...lows),
    barCount: rangeBars.length,
  };
}

export async function loadSymbolRangeState(symbol, tradeDate = etDateKey()) {
  const row = await getPremarketRangeRow(symbol, tradeDate);
  if (!row) {
    return {
      symbol,
      tradeDate,
      pmHigh: null,
      pmLow: null,
      rangeComplete: false,
      fsm: { ...DEFAULT_FSM },
    };
  }
  return {
    symbol,
    tradeDate,
    pmHigh: row.pm_high,
    pmLow: row.pm_low,
    rangeComplete: Boolean(row.range_complete),
    fsm: parseFsm(row.fsm_json),
  };
}

export async function persistSymbolRangeState(state) {
  await upsertPremarketRangeState({
    symbol: state.symbol,
    tradeDate: state.tradeDate,
    pmHigh: state.pmHigh,
    pmLow: state.pmLow,
    rangeComplete: state.rangeComplete,
    fsmJson: state.fsm,
  });
}

export async function updatePremarketRange(symbol, bars, tradeDate = etDateKey()) {
  const state = await loadSymbolRangeState(symbol, tradeDate);
  const computed = computePremarketRange(bars);

  if (computed) {
    state.pmHigh = computed.pmHigh;
    state.pmLow = computed.pmLow;
  }

  if (isAfterMarketOpen() && state.pmHigh != null && state.pmLow != null) {
    state.rangeComplete = true;
    if (state.fsm.phase === 'idle') {
      state.fsm.phase = 'watching';
    }
  }

  await persistSymbolRangeState(state);
  return state;
}

export function getPostOpenBars(bars) {
  return bars.filter(isPostOpenBar);
}

export { DEFAULT_FSM, parseFsm };
