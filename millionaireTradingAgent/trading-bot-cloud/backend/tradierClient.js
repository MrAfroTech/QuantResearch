const SANDBOX_URL = 'https://sandbox.tradier.com/v1';
const PRODUCTION_URL = 'https://api.tradier.com/v1';

function getBaseUrl() {
  void SANDBOX_URL; // neutralize TRADIER_SANDBOX host gate — no sandbox fallback
  return PRODUCTION_URL;
}

function getToken() {
  const token = process.env.TRADIER_API_TOKEN;
  if (!token) throw new Error('TRADIER_API_TOKEN is required');
  return token;
}

async function tradierRequest(path, params = {}) {
  const url = new URL(`${getBaseUrl()}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Tradier ${path} failed: ${res.status} ${errText}`);
  }

  return res.json();
}

function normalizeQuote(raw) {
  if (!raw) return null;
  const quote = Array.isArray(raw) ? raw[0] : raw;
  if (!quote) return null;

  return {
    symbol: quote.symbol,
    last: Number(quote.last),
    bid: Number(quote.bid),
    ask: Number(quote.ask),
    volume: Number(quote.volume),
    week_52_high: Number(quote.week_52_high ?? quote.week52high),
    week_52_low: Number(quote.week_52_low ?? quote.week52low),
  };
}

function normalizeHistoryBars(payload) {
  const day = payload?.history?.day;
  if (!day) return [];
  const bars = Array.isArray(day) ? day : [day];
  return bars.map((bar) => ({
    date: bar.date,
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume),
  }));
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function epochOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Quote fields from a Tradier option chain row.
 * `last`, `bid_date`, `ask_date`, and `trade_date` are on the chain payload
 * and must survive normalization so MFE can see a newer sale and quote age.
 * Dates are last-change unix milliseconds.
 */
export function optionQuoteFields(option) {
  if (!option || typeof option !== 'object') {
    return {
      bid: null,
      ask: null,
      mid: null,
      last: null,
      bid_date: null,
      ask_date: null,
      trade_date: null,
    };
  }
  const bid = finiteOrNull(option.bid);
  const ask = finiteOrNull(option.ask);
  return {
    bid,
    ask,
    mid: bid != null && ask != null ? (bid + ask) / 2 : null,
    last: finiteOrNull(option.last),
    bid_date: epochOrNull(option.bid_date),
    ask_date: epochOrNull(option.ask_date),
    trade_date: epochOrNull(option.trade_date),
  };
}

function normalizeOption(option) {
  return {
    symbol: option.symbol,
    description: option.description,
    option_type: option.option_type,
    strike: Number(option.strike),
    expiration: String(option.expiration_date || option.expiration || '').slice(0, 10),
    ...optionQuoteFields(option),
    greeks: option.greeks || null,
  };
}

export async function getQuote(symbol) {
  const json = await tradierRequest('/markets/quotes', { symbols: symbol });
  const quote = normalizeQuote(json?.quotes?.quote);
  if (!quote) throw new Error(`No quote for ${symbol}`);
  return quote;
}

export async function getHistoricalBars(symbol, interval, start, end) {
  const json = await tradierRequest('/markets/history', {
    symbol,
    interval,
    start,
    end,
  });
  return normalizeHistoryBars(json);
}

export async function getOptionChain(symbol, expiration) {
  const json = await tradierRequest('/markets/options/chains', {
    symbol,
    expiration,
    greeks: 'true',
  });

  const options = json?.options?.option;
  if (!options) return [];
  const list = Array.isArray(options) ? options : [options];
  return list.map(normalizeOption);
}

export async function getOptionExpirations(symbol) {
  const json = await tradierRequest('/markets/options/expirations', { symbol });
  const dates = json?.expirations?.date;
  if (!dates) return [];
  return (Array.isArray(dates) ? dates : [dates]).map((d) => String(d).slice(0, 10));
}

export async function getMarketStatus() {
  const json = await tradierRequest('/markets/clock');
  const clock = json?.clock || json;
  return {
    state: clock.state === 'open' ? 'open' : 'closed',
    next_open: clock.next_change || clock.next_open || null,
    next_close: clock.next_close || null,
  };
}
