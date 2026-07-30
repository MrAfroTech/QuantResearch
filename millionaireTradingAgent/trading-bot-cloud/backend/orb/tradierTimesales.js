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

export function getEtParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hours: Number(get('hour')),
    minutes: Number(get('minute')),
    weekday: get('weekday'),
  };
}

export function etDateKey(date = new Date()) {
  const { year, month, day } = getEtParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function minutesSinceMidnightEt(date = new Date()) {
  const { hours, minutes } = getEtParts(date);
  return hours * 60 + minutes;
}

export function isWeekdayEt(date = new Date()) {
  const { weekday } = getEtParts(date);
  return !['Sat', 'Sun'].includes(weekday);
}

export function isWithinOrbSession(date = new Date()) {
  if (!isWeekdayEt(date)) return false;
  const mins = minutesSinceMidnightEt(date);
  const start = 9 * 60 + 30;
  const end = 15 * 60 + 5;
  return mins >= start && mins < end;
}

export function isAfterRangeEnd(date = new Date()) {
  const mins = minutesSinceMidnightEt(date);
  return mins >= 9 * 60 + 45;
}

export function isAtOrAfterTimeStop(date = new Date()) {
  const mins = minutesSinceMidnightEt(date);
  return mins >= 15 * 60 + 5;
}

function formatTimesalesStartEnd(tradeDate) {
  return {
    start: `${tradeDate} 09:30`,
    end: `${tradeDate} 16:00`,
  };
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

export async function getFiveMinuteBars(symbol, tradeDate = etDateKey()) {
  const { start, end } = formatTimesalesStartEnd(tradeDate);
  const url = new URL(`${getBaseUrl()}/markets/timesales`);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', '5min');
  url.searchParams.set('start', start);
  url.searchParams.set('end', end);

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

export function barEtMinutes(bar) {
  if (!bar) return null;

  const ts = Number(bar.timestamp);
  if (Number.isFinite(ts)) {
    const { hours, minutes } = getEtParts(new Date(ts * 1000));
    return hours * 60 + minutes;
  }

  if (!bar.time) return null;

  // Tradier timesales `time` is ET wall clock without a timezone suffix.
  const wallClock = String(bar.time).match(/T(\d{2}):(\d{2})(?::\d{2})?/);
  if (wallClock) {
    return Number(wallClock[1]) * 60 + Number(wallClock[2]);
  }

  const { hours, minutes } = getEtParts(new Date(bar.time));
  return hours * 60 + minutes;
}

export function isOpeningRangeBar(bar) {
  const mins = barEtMinutes(bar);
  if (mins == null) return false;
  return mins >= 9 * 60 + 30 && mins < 9 * 60 + 45;
}

export function candleBody(bar) {
  return Math.abs(bar.close - bar.open);
}
